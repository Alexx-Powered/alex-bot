"""Reviewed regional official bulletins; coverage is explicit, never inferred from AQI."""
import hashlib,re,ssl
from datetime import datetime,timedelta
from html.parser import HTMLParser
from urllib.parse import urljoin
from urllib.request import Request,urlopen
from urllib.error import URLError
from beijing_air_alerts import TZ,Document

TIANJIN={'key':'tianjin_air','code':'120000','source':'天津市生态环境局',
 'home':'https://sthj.tj.gov.cn/',
 'article':r'https://sthj\.tj\.gov\.cn/YWGZ7406/HJZL9827/DQHJZL7498/(\d{6})/t(\d{8})_(\d+)\.html\Z',
 'issuer':'天津市重污染天气应对指挥部'}

class Body(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.depth=0;self.parts=[];self.found=False
    def handle_starttag(self,tag,attrs):
        if tag=='div':
            if self.depth:self.depth+=1
            elif {'TRS_Editor','TRS_UEDITOR'}.intersection(dict(attrs).get('class','').split()):self.depth=1;self.found=True
        if self.depth and tag in {'p','div','br'}:self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag=='div' and self.depth:self.depth-=1
    def handle_data(self,s):
        if self.depth:self.parts.append(s)

def get_page(url,spec):
    if url!=spec['home'] and not re.fullmatch(spec['article'],url):raise ValueError('ALERT_REGIONAL_URL')
    # This official site times out with the production OpenSSL 3.5 TLS 1.3 handshake.
    # TLS 1.2 remains certificate- and hostname-verified; scoped to this provider.
    context=ssl.create_default_context()
    context.minimum_version=ssl.TLSVersion.TLSv1_2
    context.maximum_version=ssl.TLSVersion.TLSv1_2
    for attempt in range(2):
        try:
            with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'text/html','Cache-Control':'no-cache'}),timeout=4,context=context) as r:
                if r.url!=url:raise ValueError('ALERT_REGIONAL_REDIRECT')
                raw=r.read(300001)
            break
        except (TimeoutError,URLError) as error:
            if attempt or not isinstance(getattr(error,'reason',error),TimeoutError):raise
    if len(raw)>300000:raise ValueError('ALERT_REGIONAL_SIZE')
    return raw.decode('utf8')

def links(page,spec,now):
    p=Document(spec['home']);p.feed(page);found={};valid=False
    for url,title in p.links:
        m=re.fullmatch(spec['article'],url)
        if not m:continue
        valid=True
        if not re.search('重污染.*(?:预警|响应)',title) or re.search('预案|演练|解读|征求|绩效|评估|采购',title):continue
        day=datetime.strptime(m[2],'%Y%m%d').replace(tzinfo=TZ)
        if now-timedelta(days=14)<=day<=now:found[url]=(day,int(m[3]))
    if not valid:raise ValueError('ALERT_REGIONAL_SCHEMA')
    return max(found,key=found.get) if found else None

def parse_article(page,url,spec,now):
    if not re.fullmatch(spec['article'],url):raise ValueError('ALERT_REGIONAL_URL')
    p=Document();p.feed(page);title=p.meta.get('articletitle','')
    if not re.search('重污染.*(?:预警|响应)',title) or re.search('预案|演练|解读|征求|绩效|评估|采购',title):raise ValueError('ALERT_REGIONAL_SCHEMA')
    issued=datetime.fromisoformat(p.meta.get('pubdate','')).replace(tzinfo=TZ)
    if issued>now+timedelta(minutes=15) or issued<now-timedelta(days=14):return None
    body=Body();body.feed(page);text='\n'.join(x.strip() for x in ''.join(body.parts).splitlines() if x.strip())
    if not body.found or not 10<=len(text)<=9000 or '重污染' not in text:raise ValueError('ALERT_REGIONAL_SCHEMA')
    cancelled=bool(re.search('解除|终止|取消',title))
    color=re.search('(蓝色|黄色|橙色|红色)预警',title)
    if not color and not cancelled:raise ValueError('ALERT_REGIONAL_SCHEMA')
    color=color[1] if color else '未分色'
    # Preserve explicit effective time in the official full text; do not guess from a date-only title.
    effective='详见正文'
    for m in re.finditer(r'(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2})时(?:(\d{1,2})分)?',text):
        if not re.match(r'(?:起)?(?:本市|我市|全市)?(?:启动|解除|取消|终止)',text[m.end():]):continue
        y,mo,d,h,mi=m.groups();y=int(y or issued.year)
        if issued.month==12 and int(mo)==1 and not m[1]:y+=1
        effective=datetime(y,int(mo),int(d),int(h),int(mi or 0),tzinfo=TZ).isoformat();break
    fp=hashlib.sha256((url+title+text+issued.isoformat()+effective).encode()).hexdigest()
    return {'id':spec['key']+':'+re.fullmatch(spec['article'],url)[3], 'series':spec['key']+':air-pollution',
      'fingerprint':fp,'code':spec['code'],'province':'天津市','issuer':spec['issuer'],'headline':title,'title':title,
      'description':text,'hazard':'重污染天气','color':color,'severity':{'蓝色':1,'黄色':2,'橙色':3,'红色':4}.get(color,0),
      'cancelled':cancelled,'publishedAt':issued.isoformat(),'effective':effective,'url':url,'source':spec['source'],'level':'省级'}

def fetch_tianjin(now=None,getter=None):
    now=now or datetime.now(TZ);getter=getter or (lambda u:get_page(u,TIANJIN))
    url=links(getter(TIANJIN['home']),TIANJIN,now)
    if not url:return []
    a=parse_article(getter(url),url,TIANJIN,now)
    return [a] if a else []

def sources(codes):
    from beijing_air_alerts import fetch_beijing
    registry=[('beijing_air','11',fetch_beijing),('tianjin_air','12',fetch_tianjin)]
    return [(key,fetch) for key,prefix,fetch in registry if any(c.startswith(prefix) for c in codes)]

def coverage(codes):
    return [{'code':c,'meteorological':'cma','heavyPollution':'official_regional' if c[:2] in {'11','12'} else 'source_not_verified'} for c in codes]

