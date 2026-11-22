"""Bounded Beijing emergency-management bulletins; no search or model calls."""
import hashlib,re
from datetime import datetime,timedelta,timezone
from html.parser import HTMLParser
from urllib.parse import urljoin
from urllib.request import Request,urlopen

HOME='https://yjglj.beijing.gov.cn/'
ARTICLE=re.compile(r'https://yjglj\.beijing\.gov\.cn/art/(\d{4})/(\d{1,2})/(\d{1,2})/art_2472_(\d+)\.html\Z')
TZ=timezone(timedelta(hours=8))

def get_page(url):
    if url!=HOME and not ARTICLE.fullmatch(url):raise ValueError('ALERT_BEIJING_URL')
    with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'text/html','Cache-Control':'no-cache'}),timeout=4) as r:
        if r.url!=url:raise ValueError('ALERT_BEIJING_REDIRECT')
        raw=r.read(300001)
    if len(raw)>300000:raise ValueError('ALERT_BEIJING_SIZE')
    return raw.decode('utf8',errors='strict')

class Document(HTMLParser):
    def __init__(self,base=HOME):super().__init__(convert_charrefs=True);self.base=base;self.meta={};self.links=[];self.link=None;self.text=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='meta':self.meta[a.get('name','').lower()]=a.get('content','')
        if tag=='a':self.link=[urljoin(self.base,a.get('href','')),a.get('title','')]
        if tag in {'p','br','div'}:self.text.append('\n')
    def handle_endtag(self,tag):
        if tag=='a' and self.link:self.links.append(self.link);self.link=None
    def handle_data(self,data):
        self.text.append(data)
        if self.link:self.link[1]+=data

def discover(page,now,skip=None):
    p=Document();p.feed(page);links={}
    if not any(ARTICLE.fullmatch(url) for url,_ in p.links):raise ValueError('ALERT_BEIJING_SCHEMA')
    for url,title in p.links:
        m=ARTICLE.fullmatch(url)
        if not m or url==skip or '重污染' not in title or '预警' not in title or re.search('预案|演练|解读|征求',title):continue
        day=datetime(*map(int,m.groups()[:3]),tzinfo=TZ)
        if now-timedelta(days=14)<=day<=now:links[url]=(day,int(m[4]))
    # The newest bulletin (including cancellation) supersedes earlier starts.
    return max(links,key=links.get) if links else None

def pollution_level(title,text):
    target=re.search(r'(?:升级|上调|下调|降级|调整|变更)(?:为|至)(?:空气)?(?:重污染(?:天气)?)?(蓝色|黄色|橙色|红色)',title)
    return target or re.search(r'(蓝色|黄色|橙色|红色)预警',title+' '+text)


def parse_article(page,url,now):
    if not ARTICLE.fullmatch(url):raise ValueError('ALERT_BEIJING_URL')
    p=Document();p.feed(page);title=p.meta.get('articletitle','')
    if '重污染' not in title or '预警' not in title:raise ValueError('ALERT_BEIJING_SCHEMA')
    try:published=datetime.fromisoformat(p.meta['pubdate']).replace(tzinfo=TZ)
    except (ValueError,KeyError):raise ValueError('ALERT_BEIJING_SCHEMA') from None
    if published>now+timedelta(minutes=15) or published<now-timedelta(days=14):return None
    m=re.search(r'<!--ZJEG_RSS.content.begin-->(.*?)<!--ZJEG_RSS.content.end-->',page,re.S)
    if not m:raise ValueError('ALERT_BEIJING_SCHEMA')
    body=Document();body.feed(m[1]);text='\n'.join(x.strip() for x in ''.join(body.text).splitlines() if x.strip())
    if not 10<=len(text)<=9000 or '重污染' not in text:raise ValueError('ALERT_BEIJING_SCHEMA')
    color=pollution_level(title,text)
    cancelled=bool(re.search('解除|取消',title))
    if not color and not cancelled:raise ValueError('ALERT_BEIJING_SCHEMA')
    color=color[1] if color else '未分色';effective='详见正文'
    for d in re.finditer(r'(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2})[时点](?:(\d{1,2})分)?',text):
        if not re.match(r'(?:本市|北京市)?(?:将)?(?:启动|解除|取消|起)',text[d.end():]):continue
        y,mo,day,h,minute=d.groups()
        if not y and published.month==12 and int(mo)==1:y=str(published.year+1)
        try:
            hour=int(h);minute=int(minute or 0)
            if hour>24 or (hour==24 and minute):raise ValueError()
            stamp=datetime(int(y or published.year),int(mo),int(day),hour%24,minute,tzinfo=TZ)+timedelta(days=hour//24)
            effective=stamp.isoformat();break
        except ValueError:raise ValueError('ALERT_BEIJING_SCHEMA') from None
    fingerprint=hashlib.sha256((url+title+text+published.isoformat()+effective).encode()).hexdigest()
    return {'id':'bjair:'+ARTICLE.fullmatch(url)[4],'series':'beijing:air-pollution','fingerprint':fingerprint,
        'code':'110000','province':'北京市','issuer':'北京市空气重污染应急指挥部办公室','headline':title,'title':title,
        'description':text,'hazard':'空气重污染','color':color,'severity':{'蓝色':1,'黄色':2,'橙色':3,'红色':4}.get(color,0),
        'cancelled':cancelled,'publishedAt':published.isoformat(),'effective':effective,'url':url,'source':'北京市应急管理局','level':'省级'}

def fetch_beijing(now=None,getter=get_page,*,timeline=False):
    now=now or datetime.now(TZ);page=getter(HOME);url=discover(page,now)
    if not url:return []
    alert=parse_article(getter(url),url,now)
    if timeline and alert:
        from outdoor_warnings import effective_time
        if effective_time(alert,datetime.fromisoformat(alert['publishedAt']))>now:
            prior=discover(page,now,skip=url)
            if prior:
                earlier=parse_article(getter(prior),prior,now)
                if earlier:return [earlier,alert]
    return [alert] if alert else []
