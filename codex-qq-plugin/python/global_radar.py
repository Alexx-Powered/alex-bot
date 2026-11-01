"""Fixed-host global radar LangChain tool. Public maps only; no model keys or recipients."""
import concurrent.futures
import io
import json
import math
import re
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from langchain_core.tools import tool
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, ConfigDict, Field
from timeout_errors import is_timeout

TZ=timezone(timedelta(hours=8))
HOST='https://tilecache.rainviewer.com'
MANIFEST='https://api.rainviewer.com/public/weather-maps.json'
UA='AlexQQBot-GlobalRadar/1.0 (personal weather map viewer)'
ALIASES={'纽约':'New York City','东京':'Tokyo','伦敦':'London','巴黎':'Paris','新加坡':'Singapore','悉尼':'Sydney','洛杉矶':'Los Angeles','香港':'Hong Kong','澳门':'Macau','台北':'Taipei','首尔':'Seoul','大阪':'Osaka','曼谷':'Bangkok','多伦多':'Toronto','温哥华':'Vancouver'}
AREAS={'欧洲':(50,12,3),'亚洲':(34,90,2),'北美':(42,-100,3),'南美':(-18,-60,3),'非洲':(2,20,3),'大洋洲':(-26,135,3)}
COUNTRIES={'美国':'US','日本':'JP','英国':'GB','法国':'FR','德国':'DE','加拿大':'CA','澳大利亚':'AU','新西兰':'NZ','韩国':'KR','印度':'IN','泰国':'TH','马来西亚':'MY'}
NAME=re.compile(r"^[\w\u3400-\u9fff ·（）(),，.'’\-]{1,60}$",re.UNICODE)

class RadarFailure(Exception):
    def __init__(self,code):self.code=code;super().__init__(code)

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RadarFailure('GLOBAL_RADAR_SOURCE_INVALID')

def request(url,limit=1_500_000):
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in {'api.rainviewer.com','tilecache.rainviewer.com','tile.openstreetmap.org','geocoding-api.open-meteo.com'} or parsed.port is not None or parsed.username or parsed.password:
        raise RadarFailure('GLOBAL_RADAR_SOURCE_INVALID')
    try:
        with build_opener(NoRedirect()).open(Request(url,headers={'User-Agent':UA,'Accept':'application/json,image/png'}),timeout=10) as response:
            data=response.read(limit+1)
            if len(data)>limit:raise RadarFailure('GLOBAL_RADAR_SOURCE_INVALID')
            return data
    except Exception as error:
        if is_timeout(error):raise RadarFailure('GLOBAL_RADAR_TIMEOUT') from None
        if isinstance(error,RadarFailure):raise
        raise RadarFailure('GLOBAL_RADAR_SOURCE_UNAVAILABLE') from None

def latest_frame(data,now):
    if not isinstance(data,dict) or data.get('host')!=HOST or not isinstance(data.get('radar',{}).get('past'),list):raise RadarFailure('GLOBAL_RADAR_SOURCE_INVALID')
    generated=data.get('generated')
    frames=data['radar']['past']
    if isinstance(generated,bool) or not isinstance(generated,(int,float)) or not 0<=now-generated<=3600 or not 1<=len(frames)<=36:raise RadarFailure('GLOBAL_RADAR_STALE')
    valid=[]
    for frame in frames:
        if not isinstance(frame,dict):raise RadarFailure('GLOBAL_RADAR_SOURCE_INVALID')
        stamp,path=frame.get('time'),frame.get('path')
        if isinstance(stamp,bool) or not isinstance(stamp,int) or not isinstance(path,str) or not re.fullmatch(r'/v2/radar/[A-Za-z0-9_-]{1,64}',path):raise RadarFailure('GLOBAL_RADAR_SOURCE_INVALID')
        if -300<=now-stamp<=3600:valid.append(frame)
    if not valid:raise RadarFailure('GLOBAL_RADAR_STALE')
    return max(valid,key=lambda frame:frame['time'])

def resolve_target(target,fetch=request):
    if not isinstance(target,str) or not NAME.fullmatch(target):raise RadarFailure('GLOBAL_RADAR_LOCATION_INVALID')
    if target.lower() in {'全球','世界','global','world'}:return {'name':'全球','world':True,'latitude':0,'longitude':0,'zoom':1}
    if target in AREAS:
        lat,lon,zoom=AREAS[target]
        return {'name':target,'world':False,'latitude':lat,'longitude':lon,'zoom':zoom}
    # Reuse trusted project coordinates/aliases before any geocoding request.
    catalog=json.loads((Path(__file__).resolve().parents[1]/'data/weather-locations.json').read_text(encoding='utf-8'))
    matches=[p for p in catalog['places'] if target.casefold() in {str(v).casefold() for v in [p['name'],p['id'],*p.get('aliases',[])]}]
    if len(matches)>1:raise RadarFailure('GLOBAL_RADAR_LOCATION_AMBIGUOUS')
    if matches:
        p=matches[0]
        return {'name':p['name'],'world':False,'latitude':p['latitude'],'longitude':p['longitude'],'zoom':6}
    lookup=target;country=None
    for prefix,code in COUNTRIES.items():
        if target.startswith(prefix) and target[len(prefix):].strip(' ,，·'):
            lookup=target[len(prefix):].strip(' ,，·');country=code;break
    query=ALIASES.get(lookup,lookup)
    raw=fetch('https://geocoding-api.open-meteo.com/v1/search?'+urlencode({'name':query,'count':10,'language':'zh','format':'json'}),512000)
    data=json.loads(raw)
    rows=[row for row in data.get('results',[])[:10] if row.get('feature_code') in {'PPLC','PPLA','PPLA2','PPLA3','PPLA4','PPL','PPLX','ADM1','ADM2','PCLI','PCLD'}]
    if country:rows=[row for row in rows if row.get('country_code')==country]
    capitals=[row for row in rows if row.get('feature_code')=='PPLC']
    if len(capitals)==1:rows=capitals
    elif lookup in ALIASES and rows:
        ranked=sorted(rows,key=lambda p:p.get('population') or 0,reverse=True)
        if (ranked[0].get('population') or 0)>=500000 and (len(ranked)==1 or (ranked[0].get('population') or 0)>10*(ranked[1].get('population') or 0)):rows=ranked[:1]
        else:raise RadarFailure('GLOBAL_RADAR_LOCATION_AMBIGUOUS')
    elif len(rows)>1:
        exact=[r for r in rows if str(r.get('name','')).casefold() in {target.casefold(),query.casefold()}]
        if len(exact)==1:rows=exact
        else:raise RadarFailure('GLOBAL_RADAR_LOCATION_AMBIGUOUS')
    if not rows:raise RadarFailure('GLOBAL_RADAR_LOCATION_NOT_FOUND')
    p=rows[0];lat,lon=p.get('latitude'),p.get('longitude')
    if isinstance(lat,bool) or isinstance(lon,bool) or not isinstance(lat,(float,int)) or not isinstance(lon,(float,int)) or not math.isfinite(lat) or not math.isfinite(lon) or not -85<=lat<=85 or not -180<=lon<=180:raise RadarFailure('GLOBAL_RADAR_LOCATION_INVALID')
    return {'name':target,'world':False,'latitude':lat,'longitude':lon,'zoom':4 if p.get('feature_code') in {'PCLI','PCLD','ADM1'} else 6}

def tile_position(lat,lon,zoom):
    scale=2**zoom
    x=(lon+180)/360*scale
    y=(1-math.asinh(math.tan(math.radians(max(-85,min(85,lat)))))/math.pi)/2*scale
    return x,y

def decode_tile(raw,size):
    if len(raw)>1_500_000 or not raw.startswith(b'\x89PNG\r\n\x1a\n'):raise RadarFailure('GLOBAL_RADAR_TILE_INVALID')
    image=Image.open(io.BytesIO(raw))
    if image.size!=(size,size) or image.format!='PNG':raise RadarFailure('GLOBAL_RADAR_TILE_INVALID')
    return image.convert('RGBA')

def map_image(place,frame,private,fetch=request):
    zoom=place['zoom'];n=2**zoom
    if place['world']:
        size=1024;left=top=0;tiles=[(x,y,x*512,y*512) for x in range(2) for y in range(2)]
    else:
        center_x,center_y=tile_position(place['latitude'],place['longitude'],zoom)
        left=round(center_x*512-512);top=round(center_y*512-512);size=1024
        tiles=[(x%n,y,x*512-left,y*512-top) for x in range(math.floor(left/512),math.floor((left+size-1)/512)+1) for y in range(math.floor(top/512),math.floor((top+size-1)/512)+1) if 0<=y<n]
    base=Image.new('RGBA',(size,size),'#e2e8ef');radar=Image.new('RGBA',(size,size));mask=Image.new('L',(size,size),255)
    cache=private/'global-radar-tiles';cache.mkdir(parents=True,exist_ok=True,mode=0o700)
    for old in cache.glob('osm-*.png'):
        if time.time()-old.stat().st_mtime>8*86400:old.unlink(missing_ok=True)
    # Only tiles intersecting this requested viewport; OSM cache retained at least seven days.
    def load_tile(row):
        x,y,dx,dy=row
        cached=cache/f'osm-{zoom}-{x}-{y}.png'
        if cached.exists() and 0<=time.time()-cached.stat().st_mtime<7*86400:
            raw=cached.read_bytes()
        else:
            if not cached.exists() and sum(1 for _ in cache.glob('osm-*.png'))>=512:raise RadarFailure('GLOBAL_RADAR_CACHE_FULL')
            raw=fetch(f'https://tile.openstreetmap.org/{zoom}/{x}/{y}.png')
            decode_tile(raw,256);temporary=cached.with_name(cached.name+'.'+uuid.uuid4().hex+'.tmp');temporary.write_bytes(raw);temporary.replace(cached)
        background=decode_tile(raw,256).resize((512,512),Image.Resampling.LANCZOS)
        echo=decode_tile(fetch(f"{HOST}{frame['path']}/512/{zoom}/{x}/{y}/2/0_0.png"),512)
        coverage=decode_tile(fetch(f'{HOST}/v2/coverage/0/512/{zoom}/{x}/{y}/0/0_0.png'),512).getchannel('A')
        return background,echo,coverage,dx,dy
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for background,echo,coverage,x,y in pool.map(load_tile,tiles):
            base.paste(background,(x,y));radar.paste(echo,(x,y));mask.paste(coverage,(x,y))
    base=Image.alpha_composite(base,radar)
    shade=Image.new('RGBA',base.size,(84,94,108,115));hatch=ImageDraw.Draw(shade)
    for offset in range(-size,size*2,18):hatch.line((offset,0,offset-size,size),fill=(70,82,99,175),width=2)
    opacity=mask.point(lambda value:round(value*.55));base=Image.composite(shade,base,opacity)
    covered=mask.getpixel((512,512))<128 if not place['world'] else True
    if not place['world']:
        draw=ImageDraw.Draw(base);draw.ellipse((503,503,521,521),fill='#ffffff',outline='#1e4c84',width=3);draw.ellipse((509,509,515,515),fill='#1e4c84')
    # Bound disk growth without discarding any tile before the seven-day cache minimum.
    for old in cache.glob('osm-*.png'):
        if time.time()-old.stat().st_mtime>8*86400:old.unlink(missing_ok=True)
    return base.convert('RGB'),covered

def render(place,map_view,covered,frame):
    from render_fonts import font_path
    def font(size,bold=False):return ImageFont.truetype(font_path(bold),size)
    image=Image.new('RGB',(1080,1370),'#eef3f9');draw=ImageDraw.Draw(image)
    title=place['name']+' · 全球雷达'
    while draw.textlength(title,font=font(38,True))>990 and len(title)>15:title=title[:-8]+'…'
    draw.text((28,22),title,font=font(38,True),fill='#1c334e')
    stamp=datetime.fromtimestamp(frame['time'],TZ).strftime('%m-%d %H:%M')
    draw.text((30,76),'最新拼图帧 '+stamp+'  北京时间',font=font(24),fill='#536b84')
    draw.text((30,110),'全球雷达实况拼图' if covered else '目标位置暂无雷达覆盖 · 灰纹为缺测',font=font(24),fill='#536b84' if covered else '#986023')
    image.paste(map_view,(28,158))
    labels=[(15,'#88ddee'),(20,'#00a3e0'),(30,'#005588'),(35,'#ffee00'),(40,'#ffaa00'),(45,'#ff4400')]
    draw.text((30,1200),'回波强度 dBZ',font=font(23),fill='#435973')
    for i,(value,color) in enumerate(labels):
        x=245+i*103;draw.rectangle((x,1203,x+92,1219),fill=color);draw.text((x+25,1227),str(value),font=font(20),fill='#536b84')
    draw.text((30,1265),'灰纹：无雷达覆盖   ·   圆点：查询位置' if not place['world'] else '灰纹：无雷达覆盖',font=font(23),fill='#536b84')
    draw.text((30,1301),'雷达 RainViewer · https://www.rainviewer.com/',font=font(22),fill='#536b84')
    draw.text((30,1336),'底图 © OpenStreetMap contributors · openstreetmap.org/copyright',font=font(20),fill='#536b84')
    output=io.BytesIO();image.save(output,format='PNG',optimize=True)
    if output.tell()>4_500_000:raise RadarFailure('GLOBAL_RADAR_IMAGE_TOO_LARGE')
    return output.getvalue()

class GlobalRadarArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    target:str=Field(min_length=1,max_length=60)

def build_global_radar_tool(private,fetch=request,clock=time.time):
    @tool('global_radar_image',args_schema=GlobalRadarArgs,return_direct=True)
    def global_radar_image(target:str)->dict:
        """查询固定RainViewer全球雷达；只接受地名或全球，不允许URL、命令、账户或收件人。"""
        try:
            place=resolve_target(target.strip(),fetch)
            frame=latest_frame(json.loads(fetch(MANIFEST,100000)),clock())
            map_view,covered=map_image(place,frame,Path(private),fetch)
            png=render(place,map_view,covered,frame)
            if clock()-frame['time']>3600:raise RadarFailure('GLOBAL_RADAR_STALE')
            output=Path(private)/'global-radar';output.mkdir(parents=True,exist_ok=True,mode=0o700)
            identity=uuid.uuid4().hex;target_file=output/(identity+'.png');target_file.write_bytes(png);target_file.chmod(0o600)
            return {'ok':True,'artifact_id':identity,'name':place['name'],'covered':covered,'issued_at':datetime.fromtimestamp(frame['time'],TZ).isoformat(),'source':'https://www.rainviewer.com/'}
        except Exception as error:
            return {'ok':False,'code':error.code if isinstance(error,RadarFailure) else 'GLOBAL_RADAR_TIMEOUT' if is_timeout(error) else 'GLOBAL_RADAR_SOURCE_UNAVAILABLE'}
    return global_radar_image
