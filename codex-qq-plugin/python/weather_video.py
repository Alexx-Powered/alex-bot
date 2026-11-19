"""Time-labelled public weather maps encoded serially to bounded H.264 MP4."""
import io,json,math,time
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import datetime,timezone,timedelta
from urllib.parse import urlencode
from typing import Literal
from functools import lru_cache, partial
from pydantic import BaseModel,ConfigDict,Field,model_validator
from langchain_core.tools import tool
from PIL import Image,ImageDraw,ImageFont
from render_fonts import font_path
from weather_map import overlay as map_overlay
from weather_regions import REGIONS,regional_area
from native_forecast import native_forecast, domain_for, DOMAINS, valid_update_time
from video_download import pooled_downloads, request
from video_trace import stage, sample

TZ=timezone(timedelta(hours=8));N=15;SIZE=640
from weather_video_codec import OUTPUT_SIZE, FPS, VideoFailure, output_directory, finish_video, FrameFiles, frame_folder
ENDPOINTS={'cloud_cover':'https://api.open-meteo.com/v1/forecast','cloud':'https://www.jma.go.jp/bosai/himawari/data/satimg/targetTimes_fd.json','pm25':'https://air-quality-api.open-meteo.com/v1/air-quality','temperature':'https://api.open-meteo.com/v1/forecast','precipitation':'https://api.open-meteo.com/v1/forecast'}
LABELS={'cloud_cover':'云量预报','cloud':'动态云图','pm25':'动态 PM2.5','temperature':'动态温度','precipitation':'动态降水'}
VARIABLES={'cloud_cover':'cloud_cover','pm25':'pm2_5','temperature':'temperature_2m','precipitation':'precipitation'}
# Independently chosen meteorological ramps inspired by Windy's visual language.
# Values and units remain our CAMS/ECMWF sources; this does not use Windy tiles.
SCALES={'cloud_cover':[(0,'#927a40'),(25,'#8a7f63'),(50,'#898987'),(75,'#a1a5a6'),(100,'#dadcda')],'pm25':[(0,'#293c61'),(10,'#3769a0'),(25,'#398f99'),(35,'#75ad68'),(50,'#c8c654'),(75,'#e4a23b'),(100,'#dc6c37'),(150,'#b93846'),(250,'#713453')],'temperature':[(-20,'#a17ac2'),(-10,'#5273bd'),(0,'#359bb4'),(10,'#719b41'),(20,'#e4cf24'),(25,'#f4a51d'),(30,'#e65b1b'),(35,'#b82632'),(40,'#672046')],'precipitation':[(0,'#293d4f'),(.1,'#374c83'),(.5,'#416bd6'),(1,'#4084c7'),(2.5,'#49a4a1'),(5,'#b9c745'),(10,'#e69b32'),(20,'#d25635'),(40,'#994d8c')]}
UNITS={'cloud_cover':'%','pm25':'μg/m³','temperature':'°C','precipitation':'mm / 小时'}
class Args(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    layer:Literal['cloud','cloud_cover','pm25','precipitation','temperature']
    name:str=Field(min_length=1,max_length=100)
    latitude:float|None=Field(default=None,ge=-80,le=80,allow_inf_nan=False)
    longitude:float|None=Field(default=None,ge=-180,le=180,allow_inf_nan=False)
    hours:Literal[24,48]=24
    region_id:str|None=Field(default=None,max_length=24)

    @model_validator(mode='after')
    def target_is_valid(self):
        if self.layer=='cloud' and self.hours!=24:raise ValueError('Cloud uses observations')
        if self.region_id is None:
            if self.latitude is None or self.longitude is None:raise ValueError('Missing location')
        elif self.region_id not in REGIONS or self.latitude is not None or self.longitude is not None:
            raise ValueError('Invalid regional target')
        return self
def utc(ts):return datetime.fromtimestamp(ts,timezone.utc)
def stamp(ts):return datetime.fromtimestamp(ts,TZ).strftime('%m.%d %H:%M')
def xy(lat,lon,world):return (lon+180)/360*world,(1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*world
def latlon(x,y,world):return math.degrees(math.atan(math.sinh(math.pi*(1-2*y/world)))),(x/world*360-180+180)%360-180

def area(lat,lon,cloud=False):
    world=8192 if cloud else 32768;size=256 if cloud else 512
    cx,cy=xy(lat,lon,world)
    return {'world':world,'size':size,'left':cx-size/2,'top':cy-size/2}

def latest_source_availability(layer, view, now, fetch):
    host = ENDPOINTS[layer].split('/v1/', 1)[0]
    domain = domain_for(layer, view)
    try:
        metadata = json.loads(fetch(f'{host}/data/{domain}/static/meta.json', 16_384))
    except (VideoFailure, ValueError, TypeError):
        return None
    if not isinstance(metadata, dict):
        return None
    return valid_update_time(metadata.get('last_run_availability_time'), metadata.get('last_run_initialisation_time'), now)

def forecast_frames(layer,lat,lon,now,fetch=request,*,viewport=None,hours=24):
    a=viewport if viewport is not None else area(lat,lon)
    points=[latlon(a['left']+j*a['size']/(N-1),a['top']+i*a['size']/(N-1),a['world']) for i in range(N) for j in range(N)]
    start=int(math.ceil(now/3600)*3600);times=[start+i*3600 for i in range(hours)];v=VARIABLES[layer]
    params={'hourly':v,'timezone':'GMT','timeformat':'unixtime','start_hour':utc(times[0]).strftime('%Y-%m-%dT%H:00'),'end_hour':utc(times[-1]).strftime('%Y-%m-%dT%H:00')}
    params.update({'domains':domain_for(layer,a)} if layer=='pm25' else {'models':'ecmwf_ifs'})
    def read_batch(offset):
        batch=points[offset:offset+75]
        query={**params,'latitude':','.join(f'{p[0]:.5f}' for p in batch),'longitude':','.join(f'{p[1]:.5f}' for p in batch)}
        url=ENDPOINTS[layer]+'?'+urlencode(query)
        try:raw=fetch(url)
        except VideoFailure as error:
            if not error.transient:raise
            raw=fetch(url)
        with sample('video_decode_slowest'):result=json.loads(raw)
        if not isinstance(result,list) or len(result)!=len(batch):raise VideoFailure('VIDEO_SOURCE_INVALID')
        return result
    # Each batch covers distinct coordinates. Keep grid order even when the
    # last request finishes first.
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows=[row for batch in pool.map(read_batch,range(0,len(points),75)) for row in batch]
    grids=[[None]*(N*N) for _ in times]
    unit={'cloud_cover':'%','pm25':'μg/m³','temperature':'°C','precipitation':'mm'}[layer]
    bounds={'cloud_cover':(0,100),'pm25':(0,5000),'temperature':(-100,70),'precipitation':(0,1000)}[layer]
    for n,row in enumerate(rows):
        h=row.get('hourly',{});tt=h.get('time');values=h.get(v)
        if row.get('utc_offset_seconds')!=0 or row.get('hourly_units',{}).get(v)!=unit or not isinstance(tt,list) or not isinstance(values,list) or len(tt)!=len(values) or len(tt)>100 or len(set(tt))!=len(tt) or tt!=sorted(tt):raise VideoFailure('VIDEO_SOURCE_INVALID')
        if any(type(x) is not int for x in tt):raise VideoFailure('VIDEO_SOURCE_INVALID')
        # API list order is the documented location order. Verify coordinates remain near requested grid points.
        if type(row.get('latitude')) not in (int,float) or type(row.get('longitude')) not in (int,float) or abs(row['latitude']-points[n][0])>1 or abs((row['longitude']-points[n][1]+180)%360-180)>1:raise VideoFailure('VIDEO_SOURCE_INVALID')
        for k,t in enumerate(times):
            if t not in tt:continue
            val=values[tt.index(t)]
            if val is None:continue
            if type(val) not in (int,float) or not math.isfinite(val) or not bounds[0]<=val<=bounds[1]:raise VideoFailure('VIDEO_SOURCE_INVALID')
            grids[k][n]=val
    if any(sum(v is not None for v in g)<N*N*.8 or g[(N*N)//2] is None for g in grids):raise VideoFailure('VIDEO_DATA_MISSING')
    return a,times,grids

def cloud_times(rows,now):
    valid=[]
    if not isinstance(rows,list) or len(rows)>1000:raise VideoFailure('VIDEO_SOURCE_INVALID')
    for row in rows:
        try:
            b=row['basetime'];v=row['validtime']
            if not isinstance(b,str) or not isinstance(v,str) or len(b)!=14 or not b.isdigit() or b!=v:continue
            t=datetime.strptime(v,'%Y%m%d%H%M%S').replace(tzinfo=timezone.utc).timestamp()
            if now-8*3600<=t<=now+60:valid.append((t,row))
        except (ValueError,KeyError,TypeError):continue
    valid=sorted({x[0]:x for x in valid}.values())
    if not valid or now-valid[-1][0]>90*60:raise VideoFailure('VIDEO_SOURCE_STALE')
    end=valid[-1][0]
    chosen=[(int(t),row) for t,row in valid if end-21600<=t<=end and int(t)%600==0]
    check_cloud_times([t for t,_ in chosen])
    return chosen

def check_cloud_times(times):
    if not (2<=len(times)<=37 and 0<times[-1]-times[0]<=21600):
        raise VideoFailure('VIDEO_DATA_MISSING')
    if any(b<=a for a,b in zip(times,times[1:])):
        raise VideoFailure('VIDEO_DATA_MISSING')

def cloud_window(a):
    for zoom in range(5,0,-1):
        scale=(256 << zoom)/a['world']
        left,top,side=a['left']*scale,a['top']*scale,a['size']*scale
        right,bottom=left+side,top+side
        columns=range(math.floor(left/256),math.ceil(right/256))
        rows=range(math.floor(top/256),math.ceil(bottom/256))
        if side<=384 and len(columns)*len(rows)<=6:return zoom,left,top,side,columns,rows
    raise VideoFailure('VIDEO_NO_COVERAGE')


def cloud_frame(a,row,fetch=request):
    zoom,left,top,side,columns,rows=cloud_window(a)
    x0,y0=math.floor(left),math.floor(top)
    image=Image.new('L',(math.ceil(left+side)-x0,math.ceil(top+side)-y0))
    try:
        for y in rows:
            for x in columns:
                url=f"https://www.jma.go.jp/bosai/himawari/data/satimg/{row['basetime']}/fd/{row['validtime']}/B13/TBB/{zoom}/{x%(1<<zoom)}/{y}.jpg"
                raw=fetch(url,300000)
                with sample('video_decode_slowest'), Image.open(io.BytesIO(raw)) as tile:
                    if tile.format!='JPEG' or tile.size!=(256,256):raise VideoFailure('VIDEO_SOURCE_INVALID')
                    with tile.convert('L') as gray:image.paste(gray,(256*x-x0,256*y-y0))
        if image.getextrema()[1]<5:raise VideoFailure('VIDEO_NO_COVERAGE')
        size=max(1,round(side))
        return image.transform((size,size),Image.Transform.EXTENT,(left-x0,top-y0,left-x0+side,top-y0+side),Image.Resampling.BILINEAR)
    except (OSError, ValueError) as error:
        raise VideoFailure('VIDEO_SOURCE_INVALID') from error
    finally:image.close()

def cloud_sequence(area, selection, fetch, deadline, now):
    def get_tile(url,limit):
        for attempt in range(2):
            if time.monotonic()>=deadline:raise VideoFailure('VIDEO_TIMEOUT')
            try:return fetch(url,limit)
            except VideoFailure as error:
                if not error.transient or attempt:raise
    def capture(item):
        t,row=item
        try:return t,cloud_frame(area,row,get_tile),None
        except VideoFailure as error:return t,None,error.code
    with ThreadPoolExecutor(max_workers=4) as pool:
        records=list(pool.map(capture,selection))
    data=[(t,img) for t,img,_ in records if img is not None]
    try:
        if not data:
            code=records[0][2] if len({r[2] for r in records})==1 else 'VIDEO_SOURCE_UNAVAILABLE'
            raise VideoFailure(code)
        times=[t for t,_ in data];check_cloud_times(times)
        if now-times[-1]>5400:raise VideoFailure('VIDEO_SOURCE_STALE')
        return times,[img for _,img in data]
    except BaseException:
        for _,img in data:img.close()
        raise

def color(v,scale):
    if v is None:return (155,161,163)
    from PIL.ImageColor import getrgb
    if v<=scale[0][0]:return getrgb(scale[0][1])
    for (lo,lc),(hi,hc) in zip(scale,scale[1:]):
        if v<=hi:
            f=(v-lo)/(hi-lo);return tuple(round(a*(1-f)+b*f) for a,b in zip(getrgb(lc),getrgb(hc)))
    return getrgb(scale[-1][1])

@lru_cache(maxsize=1)
def color_tables(layer):
    scale=SCALES[layer];low=scale[0][0];high=scale[-1][0]
    tables=[bytearray(),bytearray(),bytearray()]
    for i in range(65536):
        for table,value in zip(tables,color(low+(high-low)*i/65535,scale)):
            table.append(value)
    return tables

def forecast_map(layer,grid):
    # Interpolate the physical field before applying the color ramp. RGB blending
    # across unrelated scale bands would invent colors unrelated to the value.
    scale=SCALES[layer];low=scale[0][0];high=scale[-1][0]
    raster=isinstance(grid,Image.Image)
    if raster:
        # GeoTIFF pixels fill the viewport edge to edge; legacy point samples sit on its edges.
        with grid.convert('F') as small:field=small.resize((SIZE,SIZE),Image.Resampling.BILINEAR)
    else:
        with Image.new('F',(N,N)) as small:
            small.putdata([low if v is None else v for v in grid])
            field=small.resize((SIZE,SIZE),Image.Resampling.BILINEAR,box=(.5,.5,N-.5,N-.5))
    indexes=field.point(lambda v:(v-low)*(65535/(high-low))).convert('I');field.close()
    channels=[indexes.point(table,'L') for table in color_tables(layer)];indexes.close()
    result=Image.merge('RGB',channels)
    for channel in channels:channel.close()
    if not raster and any(v is None for v in grid):
        mask=Image.new('L',(N,N));mask.putdata([255 if v is None else 0 for v in grid])
        expanded=mask.resize((SIZE,SIZE),Image.Resampling.BILINEAR,box=(.5,.5,N-.5,N-.5)).point(lambda v:255 if v else 0)
        result.paste('#9ba1a3',(0,0),expanded);mask.close();expanded.close()
    return result

def static_overlay(layer, name, area, times):
    size = OUTPUT_SIZE
    ratio = size/720
    focus = '' if 'members' in area else name.split('·')[-1][:12]
    image = map_overlay(area,size,layer,focus)
    for start,end,first,last in [(0,140,150,0),(540 if layer!='cloud' else 590,720,0,205)]:
        height=round((end-start)*ratio)
        strip=Image.new('RGBA',(1,height));strip.putdata([(7,25,32,round(first+(last-first)*y/(height-1))) for y in range(height)])
        with strip.resize((size,height)) as gradient:image.alpha_composite(gradient,(0,round(start*ratio)))
        strip.close()
    draw=ImageDraw.Draw(image)
    def put(x,y,value,px,bold=False,ink='#ffffff',outline=False):
        draw.text((round(x*ratio),round(y*ratio)),value,font=ImageFont.truetype(font_path(bold),round(px*ratio)),fill=ink,stroke_width=round(ratio) if outline else 0,stroke_fill='#40505b')
    title=name
    title_size=30
    while title_size>18 and draw.textlength(title,font=ImageFont.truetype(font_path(True),round(title_size*ratio)))>size*.94:title_size-=1
    put(24,20,title,title_size,True,outline=True)
    subtitle='近6小时·历史卫星云图' if layer=='cloud' else f'{len(times)}小时·'+{'temperature':'温度预报','precipitation':'降水预报','pm25':'PM2.5预报','cloud_cover':'云量预报'}[layer]
    if layer=='cloud' and len(times)<37:subtitle+=' · 缺测跳时'
    if area.get('forecast_detail')=='sampled':subtitle+=' · 简略版'
    put(25,64,subtitle,16,outline=True)
    tibet='54' in area.get('members',())
    if area.get('members')==['71']:
        put(424,30,'◎ 省级行政中心   • 地级行政中心   + 岛屿位置',14,ink='#edf4f4')
    if focus:
        center=size//2; radius=round(6*ratio)
        draw.ellipse((center-radius,center-radius,center+radius,center+radius),fill='white',outline='#173842',width=round(2*ratio))
        draw.text((center+round(11*ratio),center-round(13*ratio)),focus,font=ImageFont.truetype(font_path(True),round(18*ratio)),
                  fill='white',stroke_fill='#152637',stroke_width=round(2*ratio))
    if layer!='cloud':
        scale=SCALES[layer];width=round(530*ratio);step=width/(len(scale)-1)
        for pixel in range(width+1):
            position=pixel/step;k=min(len(scale)-2,int(position));f=position-k
            value=scale[k][0]*(1-f)+scale[k+1][0]*f
            draw.line((round(24*ratio)+pixel,round(572*ratio),round(24*ratio)+pixel,round(580*ratio)),fill=color(value,scale))
        for i,(value,_) in enumerate(scale):put(24+i*step/ratio-(6 if i else 0),587,str(value),13)
        put(584,568,UNITS[layer],16)
    put(24,674,stamp(times[0]),13,ink='#e4eeee');put(604,674,stamp(times[-1]),13,ink='#e4eeee')
    source='JMA Himawari（裁切）' if layer=='cloud' else ('CAMS / ECMWF' if layer=='pm25' else 'ECMWF IFS')+' · Open-Meteo'
    if layer!='cloud':source=area.get('forecast_source',source)
    credit='Natural Earth · geoBoundaries · CTAmap'
    if image.info.get('registered_boundary_ink'):
        credit+=' · 界线参考自然资源部监制《中国地图》'
    footer=source+'  |  '+credit+(' · 西藏自治区自然资源厅' if tibet else '')
    freshness=''
    if layer=='cloud':
        freshness='最新观测 '+stamp(times[-1])
    elif (updated_at:=area.get('forecast_updated_at')) is not None:
        label='最近可用' if area.get('forecast_detail')=='sampled' else '更新于'
        freshness=f'{label} {stamp(updated_at)}'
    footer_size=round(11*ratio)
    footer_font=ImageFont.truetype(font_path(),footer_size)
    if freshness:
        footer+='  |  '+freshness
        width=size-2*round(24*ratio)
        while draw.textlength(footer,font=footer_font)>width:
            footer_size-=1
            footer_font=ImageFont.truetype(font_path(),footer_size)
    draw.text((round(24*ratio),round(699*ratio)),footer,font=footer_font,fill='#d1dedf')
    return image


def transition_steps(layer, first, second):
    if layer=='cloud':return 4 if second-first==600 else 1
    return 6


def clock_text(layer, start, end):
    def short(t,reference):
        value=stamp(t)
        return value[-5:] if value[:5]==stamp(reference)[:5] else value
    if layer=='precipitation':
        text=stamp(start-3600)+'–'+short(start,start-3600)
        if end is not None:text+=' → '+short(end-3600,start-3600)+'–'+short(end,start-3600)
    else:
        text=stamp(start)
        if end is not None:text+=' → '+short(end,start)
    return text+'  北京时间'


def render_sequence(spool, layer, name, area, times, sources, deadline):
    size=OUTPUT_SIZE; ratio=size/720
    decorations=static_overlay(layer,name,area,times)
    time_font=ImageFont.truetype(font_path(True),round(21*ratio))
    def load(index):
        return sources[index].copy() if layer=='cloud' else forecast_map(layer,sources[index])
    def write(source,caption,timestamp):
        if time.monotonic()>=deadline:raise VideoFailure('VIDEO_TIMEOUT')
        frame=source.resize((size,size),Image.Resampling.LANCZOS if layer=='cloud' else Image.Resampling.BILINEAR)
        if frame.mode!='RGB':
            gray=frame;frame=gray.convert('RGB');gray.close()
        with frame:
            frame.paste(decorations,(0,0),decorations)
            draw=ImageDraw.Draw(frame)
            draw.text((round(24*ratio),round(622*ratio)),caption,font=time_font,fill='white')
            y=round(662*ratio);left=round(24*ratio);right=size-left;r=round(4*ratio)
            x=left+round((right-left)*(timestamp-times[0])/(times[-1]-times[0]))
            draw.line((left,y,right,y),fill='#83999c',width=round(3*ratio));draw.line((left,y,x,y),fill='white',width=round(3*ratio))
            draw.ellipse((x-r,y-r,x+r,y+r),fill='white')
            spool.append(frame)
    previous=following=None; count=0
    try:
        previous=load(0)
        for i,(start,end) in enumerate(zip(times,times[1:])):
            following=load(i+1);steps=3 if layer!='cloud' and len(times)==48 else transition_steps(layer,start,end)
            caption=clock_text(layer,start,end if steps>1 else None)
            for j in range(steps):
                fraction=j/steps
                if j==0:write(previous,caption,start)
                else:
                    with Image.blend(previous,following,fraction) as blended:write(blended,caption,start+(end-start)*fraction)
                count+=1
            previous.close();previous=following;following=None
        write(previous,clock_text(layer,times[-1],None),times[-1])
        return count+1
    finally:
        if previous is not None:previous.close()
        if following is not None:following.close()
        decorations.close()


def check_area(args):
    if any(c in args['name'] for c in '\r\n\x00<>'):raise VideoFailure('VIDEO_INPUT_INVALID')
    if args.get('region_id') is not None:
        if args['region_id'] not in REGIONS:raise VideoFailure('VIDEO_INPUT_INVALID')
        return
    lat,lon=args['latitude'],args['longitude']
    if args['layer']=='cloud' and not (-60<=lat<=60 and (75<=lon<=180 or -180<=lon<=-160)):
        raise VideoFailure('VIDEO_NO_COVERAGE')


def prepare_video(args,spool,now=None,fetch=None):
    check_area(args)
    now=time.time() if now is None else now; started=time.monotonic()
    layer=args['layer'];lat=args.get('latitude');lon=args.get('longitude')
    target=REGIONS.get(args.get('region_id'))
    viewport=regional_area(target) if target else None
    name=target['name'] if target else args['name']
    with (pooled_downloads() if fetch is None else nullcontext(fetch)) as download:
        if layer=='cloud':
            with stage('video_fetch_satellite'):
                selection=cloud_times(json.loads(download(ENDPOINTS['cloud'],200000)),now);region=viewport or area(lat,lon,True)
                times,frames=cloud_sequence(region,selection,download,started+100,now)
        else:
            region=viewport or area(lat,lon)
            start=math.ceil(now/3600)*3600
            times=[start+i*3600 for i in range(args.get('hours',24))]
            detail='native'
            try:
                with stage('video_fetch_cams' if layer=='pm25' else 'video_fetch_ifs',fallback_on=VideoFailure):
                    cache_dir=spool.directory.parent if isinstance(spool,FrameFiles) else None
                    frames,source,updated_at=native_forecast(layer,region,times,now,started+25,cache_dir)
            except VideoFailure:
                # The whole forecast comes from the same model through its point API.
                with stage('video_fetch_forecast'), ThreadPoolExecutor(max_workers=1) as pool:
                    metadata_fetch=fetch if fetch is not None else partial(request,timeout=2)
                    availability=pool.submit(latest_source_availability,layer,region,now,metadata_fetch)
                    region,times,frames=forecast_frames(layer,lat,lon,now,download,viewport=viewport,hours=len(times))
                    updated_at=availability.result()
                source=DOMAINS[domain_for(layer,region)]+' · Open-Meteo'
                detail='sampled'
            region={**region,'forecast_source':source,'forecast_detail':detail,'forecast_updated_at':updated_at}
    try:
        with stage('video_render_frames'):count=render_sequence(spool,layer,name,region,times,frames,started+165)
        metadata={'ok':True,'format_version':2,'layer':layer,'start':times[0],'end':times[-1],
                'frames':count,'source_times':times,'fps':FPS,'generated_at':int(now),'width':OUTPUT_SIZE,'height':OUTPUT_SIZE}
        if layer!='cloud':metadata['forecast_detail']=region['forecast_detail']
        if target:
            north,west=latlon(region['left'],region['top'],region['world'])
            south,east=latlon(region['left']+region['size'],region['top']+region['size'],region['world'])
            metadata.update(region_id=target['id'],view_bounds=[west,south,east,north])
        return metadata
    finally:
        for img in frames:
            if isinstance(img,Image.Image):img.close()

def build_video(args,private,now=None,fetch=None):
    check_area(args)
    directory=output_directory(private);deadline=time.monotonic()+170
    with frame_folder(directory) as job:
        metadata=prepare_video(args,FrameFiles(job),now,fetch)
        return finish_video(job,metadata,directory,deadline)


def build_tool(private, *, frame_output=None):
    @tool(args_schema=Args)
    def weather_video(layer:str,name:str,latitude:float|None=None,longitude:float|None=None,region_id:str|None=None,hours:int=24)->dict:
        """Create a timestamped satellite or forecast map video from fixed public sources, no recipients or user URLs."""
        try:
            args={'layer':layer,'name':name,'latitude':latitude,'longitude':longitude,'region_id':region_id,'hours':hours}
            if frame_output is not None:return prepare_video(args,frame_output)
            return build_video(args,private)
        except VideoFailure as e:return {'ok':False,'code':e.code}
        except Exception:return {'ok':False,'code':'VIDEO_SOURCE_UNAVAILABLE'}
    return weather_video
