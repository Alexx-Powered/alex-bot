"""At most two source-bound public photos, inside the existing research budget."""
from __future__ import annotations
import base64,hashlib,io,re,time
from html.parser import HTMLParser
from urllib.parse import urljoin,urlsplit
from research_transport import _get,_decode,_url_target,PAGE_MAX_BYTES,IMAGE_MAX_BYTES

STAY=re.compile('营地|露营|扎营|帐篷|住宿|木屋|通铺')
IMAGE=re.compile(r'!\[([^\]\n]{0,180})\]\(([^\s)]+)(?:\s+"[^"]*")?\)')

def image_allowed(page_url,url):
    try:
        page_host,_,_=_url_target(page_url,allow_http=True)
        host,_,_=_url_target(url)
        # Same-site media or the source's own known static host; no arbitrary
        # third-party image URL, local file, redirect or model-selected target.
        return host==page_host or (page_host.endswith('.8264.com') and host in {'static.8264.com','img1.8264.com'})
    except ValueError:return False

class Photos(HTMLParser):
    def __init__(self,page_url):super().__init__(convert_charrefs=True);self.page_url=page_url;self.items=[];self.text='';self.skip=0
    def handle_starttag(self,tag,attrs):
        if tag in {'script','style','nav','footer'}:self.skip+=1
        if self.skip or tag!='img':return
        a=dict(attrs);raw=next((a[k] for k in ('zoomfile','file','data-original','data-src','src') if a.get(k)),None)
        if not raw:return
        url=urljoin(self.page_url,raw);context=(self.text[-160:]+' '+a.get('alt',''))[-220:]
        if image_allowed(self.page_url,url) and not re.search(r'avatar|logo|icon|emoji|smiley|ad_',url,re.I):self.items.append((url,context))
    def handle_endtag(self,tag):
        if tag in {'script','style','nav','footer'} and self.skip:self.skip-=1
    def handle_data(self,data):
        if not self.skip:self.text=(self.text+data)[-240:]

def photo_candidates(pages,*,getter=_get,clock=time.monotonic,budget=1):
    candidates=[];seen=set();deadline=clock()+budget
    for i,p in enumerate(pages[:3]):
        for m in IMAGE.finditer(p['text']):
            url=urljoin(p['url'],m[2]);context=p['text'][max(0,m.start()-140):m.start()]+' '+m[1]
            if STAY.search(context) and image_allowed(p['url'],url) and url not in seen:
                candidates.append({'source':i,'url':url,'context':context[-220:]});seen.add(url)
    # Fetch a single already-admitted page's HTML only when Markdown omitted
    # photos. Never follow another page or retry a rejected request.
    if not candidates and budget>0:
        for i,p in enumerate(pages[:3]):
            if not STAY.search(p['text']) or not p['url'].startswith('https://'):continue
            try:
                response=getter(p['url'],timeout=max(.01,deadline-clock()),max_bytes=PAGE_MAX_BYTES)
                if response.content_type.split(';')[0].strip() not in {'text/html','application/xhtml+xml'}:break
                parser=Photos(p['url']);parser.feed(_decode(response))
                for url,context in parser.items:
                    if STAY.search(context) and url not in seen:
                        candidates.append({'source':i,'url':url,'context':context});seen.add(url)
            except Exception:pass
            break
    return candidates[:2]

def collect_photos(pages,*,budget=2,getter=_get,clock=time.monotonic,diagnostics=None):
    deadline=clock()+min(2,max(0,budget));result=[]
    choices=photo_candidates(pages,getter=getter,clock=clock,budget=min(.8,budget/3))
    for item in choices:
        if deadline-clock()<.1:break
        try:
            response=getter(item['url'],timeout=min(1,deadline-clock()),max_bytes=IMAGE_MAX_BYTES,headers={'Accept':'image/jpeg,image/png,image/webp'})
            if response.content_type.split(';')[0].strip() not in {'image/jpeg','image/png','image/webp'}:continue
            from PIL import Image
            with Image.open(io.BytesIO(response.body)) as image:
                if image.format not in {'JPEG','PNG','WEBP'} or image.width*image.height>8_000_000 or max(image.size)>8192:continue
                image.thumbnail((512,512));out=io.BytesIO();image.convert('RGB').save(out,format='JPEG',quality=80)
            result.append({**item,'id':len(result),'sha256':hashlib.sha256(response.body).hexdigest(),
                'data_url':'data:image/jpeg;base64,'+base64.b64encode(out.getvalue()).decode('ascii')})
        except Exception:continue
    if diagnostics is not None:diagnostics['photo_count']=len(result)
    return result
