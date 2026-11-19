"""Route-derived weather, bounded point lookup and a presentation-only payload.

No model-supplied coordinates, source URLs, arbitrary paths or recipients. Exact
hourly progress is illustrative. Incompletely located days use an explicitly
named route-point forecast, never an invented camp night or interpolated data.
Precipitation uses the following interval endpoint.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
import json, math, re, time
from typing import Literal
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
from hiking_catalog import HikingStore, clean_name, seed_profiles

TZ=timezone(timedelta(hours=8))
FIELDS={'temperature_2m':('°C',-100,70),'cloud_cover':('%',0,100),
        'precipitation':('mm',0,1000),'rain':('mm',0,1000),'showers':('mm',0,1000),
        'snowfall':('cm',0,1000),'wind_gusts_10m':('m/s',0,150)}
_cache={}

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('HIKING_REDIRECT_DENIED')

def public_json(url,timeout=10,maximum=3_000_000):
    # Callers construct only the two constant, public service endpoints below.
    with build_opener(NoRedirect()).open(Request(url,headers={'User-Agent':'AlexBot-Hiking/1.0'}),timeout=timeout) as response:
        raw=response.read(maximum+1)
    if len(raw)>maximum:raise ValueError('HIKING_RESPONSE_TOO_LARGE')
    return json.loads(raw)

def distance(a,b):
    lat1,lat2=math.radians(a['lat']),math.radians(b['lat'])
    dlat=lat2-lat1;dlon=math.radians(b['lon']-a['lon'])
    return 12742*math.asin(min(1,math.sqrt(math.sin(dlat/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2)))

def locate(name,anchor=None,*,fetcher=public_json):
    args={'q':name,'lang':'default','limit':8}
    if anchor:args.update(lat=anchor['lat'],lon=anchor['lon'],location_bias_scale=.8)
    value=fetcher('https://photon.komoot.io/api/?'+urlencode(args),timeout=3,maximum=100000)
    found=[]
    for row in value.get('features',[])[:8]:
        prop=row.get('properties',{});coord=row.get('geometry',{}).get('coordinates',[])
        from outdoor_places import TAGS
        permitted={**TAGS,'mountain_pass':{'yes'},'tourism':TAGS['tourism']|{'camp_site','alpine_hut','hotel','guest_house'}}
        if prop.get('osm_value') not in permitted.get(prop.get('osm_key'),set()):continue
        names={str(prop.get(k,'')) for k in ('name','name:zh','name:en')}
        if name not in names or len(coord)!=2 or any(type(x) not in (int,float) or not math.isfinite(x) for x in coord):continue
        p={'lat':coord[1],'lon':coord[0]}
        if not -90<=p['lat']<=90 or not -180<=p['lon']<=180:continue
        if anchor and distance(p,anchor)>150:continue
        typ={'N':'node','W':'way','R':'relation'}.get(prop.get('osm_type'))
        if not typ or type(prop.get('osm_id')) is not int:continue
        p['source']=f"https://www.openstreetmap.org/{typ}/{prop['osm_id']}"
        found.append(p)
    if not found or any(distance(found[0],p)>5 for p in found[1:]):return None
    return found[0]

def resolve_points(topic,profiles,store=None,*,locator=locate):
    points={k:v for p in profiles for k,v in p['points'].items()}
    names=list(dict.fromkeys(n for p in profiles for d in p['days'] for n in [*d['route'],*([d['sleep']['name']] if d['sleep'] else [])]))
    for name in names:
        if name not in points and store:
            try:
                hit=store.point(name,topic+'|geo-v2')
                if hit:points[name]=hit
            except Exception:pass
    anchor=next(iter(points.values()),None)
    if not anchor:
        try:anchor=locator(topic)
        except Exception:pass
    # Prioritize overnight sites, then walking sites. If the route name is not
    # mapped, require agreement between multiple distinct source-named points;
    # a unique global homonym (e.g. 亚贡村 in another prefecture) is not an anchor.
    sleep_names=[d['sleep']['name'] for p in profiles for d in p['days'] if d['sleep']]
    missing=[n for n in dict.fromkeys([*sleep_names,*names]) if n not in points][:6]
    if missing:
        pool=ThreadPoolExecutor(max_workers=2)
        jobs={pool.submit(locator,n,anchor):n for n in missing}
        found={}
        try:
            done,_=wait(jobs,timeout=10)
            for job in done:
                try:
                    hit=job.result()
                    if hit and (not anchor or distance(hit,anchor)<=150):found[jobs[job]]=hit
                except Exception:pass
        finally:pool.shutdown(wait=False,cancel_futures=True)
        if not anchor:
            clusters={tuple(sorted(n for n,p in found.items() if distance(p,center)<=50)) for center in found.values()}
            clusters=[c for c in clusters if len({found[n]['source'] for n in c})>=2 and all(distance(found[a],found[b])<=75 for a in c for b in c)]
            clusters.sort(key=lambda c:(-len(c),c))
            # Equal-sized disjoint clusters have no reliable geographic winner.
            selected=clusters[0] if clusters and not any(len(c)==len(clusters[0]) and set(c)!=set(clusters[0]) for c in clusters[1:]) else ()
            found={n:found[n] for n in selected}
        for name,hit in found.items():
            points[name]=hit
            if store:store.point(name,topic+'|geo-v2',hit)
    # Bounded HTTP request and memory, even for long, densely described routes.
    return dict([(name,points[name]) for name in names if name in points][:24])

def forecasts(points,start,end,*,fetcher=public_json,now=None):
    now=now or datetime.now(TZ);today=now.date()
    lo=max(start,today);hi=min(end,today+timedelta(days=13))
    if not points or hi<lo:return {},None,'FORECAST_OUTSIDE_HORIZON' if hi<lo else 'HIKING_COORDINATES_MISSING'
    key=json.dumps([points,lo.isoformat(),hi.isoformat()],sort_keys=True)
    hit=_cache.get(key)
    if hit and time.monotonic()-hit[0]<600:return hit[1],hit[2],None
    args={'latitude':','.join(str(p['lat']) for p in points.values()),'longitude':','.join(str(p['lon']) for p in points.values()),
          'models':'ecmwf_ifs','hourly':','.join(FIELDS),'start_date':lo.isoformat(),'end_date':hi.isoformat(),
          'timezone':'Asia/Shanghai','wind_speed_unit':'ms','temperature_unit':'celsius','precipitation_unit':'mm'}
    try:
        response=fetcher('https://api.open-meteo.com/v1/forecast?'+urlencode(args),timeout=15)
        responses=response if isinstance(response,list) else [response]
        if len(responses)!=len(points):raise ValueError('FORECAST_COUNT_INVALID')
        result={}
        for (name,point),item in zip(points.items(),responses):
            if item['utc_offset_seconds']!=28800 or abs(item['latitude']-point['lat'])>.25 or abs(item['longitude']-point['lon'])>.25:raise ValueError('FORECAST_POSITION_INVALID')
            hours=item['hourly'];times=hours['time'];expected=(hi-lo).days*24+24
            if len(times)!=expected or any(t!=(datetime.combine(lo,datetime.min.time())+timedelta(hours=i)).isoformat(timespec='minutes') for i,t in enumerate(times)):raise ValueError('FORECAST_TIME_INVALID')
            values={}
            for field,(unit,minimum,maximum) in FIELDS.items():
                if item['hourly_units'].get(field)!=unit or len(hours.get(field,[]))!=len(times):raise ValueError('FORECAST_UNITS_INVALID')
                values[field]=[round(float(v),2) if type(v) in (int,float) and math.isfinite(v) and minimum<=v<=maximum else None for v in hours[field]]
            result[name]={t:{f:values[f][i] for f in FIELDS} for i,t in enumerate(times)}
        stamp=now.isoformat(timespec='seconds')
        if len(_cache)>=4:_cache.pop(next(iter(_cache)))
        _cache[key]=(time.monotonic(),result,stamp)
        return result,stamp,None
    except Exception as exc:
        return {},None,'HIKING_FORECAST_TIMEOUT' if 'timeout' in type(exc).__name__.lower() or 'timed out' in str(exc).lower() else 'HIKING_FORECAST_UNAVAILABLE'

def complete(values,operation):
    return round(operation(values),2) if values and all(v is not None for v in values) else None

def day_statistics(series):
    """Summarize available hourly samples, without filling a missing interval.

    Coverage travels with each number: a partial precipitation sum must never be
    presented as a complete daily total. Night comfort retains its separate,
    complete-night requirement below.
    """
    columns=[[r[i] for r in series if type(r[i]) in (int,float) and math.isfinite(r[i])] for i in range(6)]
    operations={'min':(0,min),'max':(0,max),'cloud':(1,lambda a:sum(a)/len(a)),
                'precip':(2,sum),'rain':(3,sum),'snow':(4,sum),'gust':(5,max)}
    stats={name:round(operation(columns[i]),2) if columns[i] else None for name,(i,operation) in operations.items()}
    coverage={name:len(columns[i]) for name,(i,_) in operations.items()}
    return stats,coverage

def plan_weather(profile,start,weather,*,rows=True):
    days=[];nights=[];sites={}
    for index,day in enumerate(profile['days']):
        stamp=start+timedelta(days=index);route=day['route'];series=[]
        previous=profile['days'][index-1]['sleep'] if index else None
        required=set(route+[s['name'] for s in (previous,day['sleep']) if s])
        # This is a full-day reference at ONE located walking point, not a
        # synthetic fill of unknown trail/camp observations. Night lows below
        # continue to query only the exact camp, with all 13 hours required.
        reference=None
        if not required.issubset(weather):
            available=list(dict.fromkeys(n for n in route if n in weather))
            if available:reference=available[len(available)//2]
        for hour in range(24):
            name=(previous['name'] if previous else route[0]) if hour<8 else (day['sleep']['name'] if day['sleep'] else route[-1]) if hour>=18 else route[min(len(route)-1,int((hour-8)*len(route)/10))]
            if reference:name=reference
            at=datetime.combine(stamp,datetime.min.time())+timedelta(hours=hour)
            instant=weather.get(name,{}).get(at.isoformat(timespec='minutes'),{})
            interval=weather.get(name,{}).get((at+timedelta(hours=1)).isoformat(timespec='minutes'),{})
            # [temperature, cloud, precipitation, rain, snowfall, gust, site].
            if name not in sites:sites[name]=len(sites)
            liquid=complete([interval.get('rain'),interval.get('showers')],sum)
            series.append([instant.get('temperature_2m'),instant.get('cloud_cover'),interval.get('precipitation'),liquid,interval.get('snowfall'),instant.get('wind_gusts_10m'),sites[name]])
        stats,coverage=day_statistics(series)
        days.append({'date':stamp.isoformat(),'route':route,'sleep':day['sleep'],'distance':day['distance_km'],'stats':stats,'coverage':coverage,
                     **({'weather_reference':reference} if reference else {}),**({'series':series} if rows else {})})
        if day['sleep']:
            name=day['sleep']['name'];begin=datetime.combine(stamp,datetime.min.time())+timedelta(hours=20)
            temperatures=[weather.get(name,{}).get((begin+timedelta(hours=h)).isoformat(timespec='minutes'),{}).get('temperature_2m') for h in range(13)]
            low=complete(temperatures,min)
            nights.append({'day':index+1,**day['sleep'],'low':low,'comfort':low if day['sleep']['kind']=='tent' else None})
    return {'variant':profile['variant'],'days':days,'nights':nights,'reviewed':profile['reviewed'],'sources':profile['sources']}

@lru_cache(maxsize=1)
def catalog():return seed_profiles()

def inn_plan(profile):
    return all(d['sleep'] and d['sleep']['kind']=='inn' for d in profile['days'][:-1]) and (profile['days'][-1]['sleep'] is None or profile['days'][-1]['sleep']['kind']=='inn')

def room_variant(profile):
    """Keep documented beds as a separate option, never erase camping."""
    if inn_plan(profile) or not profile['days'][:-1]:return None
    if any(not d['sleep'] or ('inn' not in d['sleep'].get('options',[]) and d['sleep']['kind']!='inn') for d in profile['days'][:-1]):return None
    if profile['days'][-1]['sleep'] and 'inn' not in profile['days'][-1]['sleep'].get('options',[profile['days'][-1]['sleep']['kind']]):return None
    return {**profile,'variant':profile['variant'][:32]+' · 住店参考',
            'days':[{**d,'sleep':{**d['sleep'],'kind':'inn'} if d['sleep'] else None} for d in profile['days']]}

def make_trip(destination,start_date=None,route_variant=None,overnight='auto',*,queue=None,source='',fetcher=public_json,locator=locate,now=None):
    tick=time.monotonic();now=now or datetime.now(TZ);topic=clean_name(destination,24)
    from bounded_research import public_outdoor_topic,foreground_research
    if public_outdoor_topic(topic,source) is None:raise ValueError('HIKING_PUBLIC_NAME_REQUIRED')
    start=date.fromisoformat(start_date) if start_date else now.date()
    if not -1<=(start-now.date()).days<=365:raise ValueError('HIKING_DATE_INVALID')
    profiles=[p for p in catalog() if p['topic']==topic]
    store=HikingStore(queue) if queue else None
    if store:
        try:
            saved=store.get(topic)
            profiles += [p for p in saved if p['variant'] not in {s['variant'] for s in profiles}]
        except Exception:pass
    research={}
    if queue:
        research=foreground_research(queue,topic=topic,source=source,allow_public_search=True)
    base={'schema':'hiking.card.v1','topic':topic,'start':start.isoformat(),'retrieved':None,'days':[],
          'nights':[],'alternate':None,'sources':[],'missing':[],'notice':'','season':'',
          'research':research.get('status','disabled'),'timings':{}}
    if not profiles:
        return {**base,'status':'pending','message':'尚无可核对的逐日行程与住宿资料。'+('已安排后台补查，下次询问会复用结果。' if base['research'] in {'queued','running'} else '补充资料暂不足，未猜测天数或营地。')}
    profiles += [alternative for p in list(profiles) if (alternative:=room_variant(p)) is not None]
    if route_variant:
        chosen=[p for p in profiles if route_variant==p['variant']]
        if not chosen:return {**base,'status':'pending','message':'可用走法：'+'、'.join(p['variant'] for p in profiles[:4])+'。请指定其中一种。'}
        primary=chosen[0]
    elif overnight in {'inn','tent'}:
        primary=next((p for p in profiles if (inn_plan(p) if overnight=='inn' else any(d['sleep'] and d['sleep']['kind']=='tent' for d in p['days']))),None)
        if primary is None:return {**base,'status':'pending','message':'暂未找到有来源支持的'+('不露营' if overnight=='inn' else '露营')+'走法；后续查询会复用后台补查资料。'}
    else:primary=profiles[0]
    alt=next((p for p in profiles if p['variant']!=primary['variant'] and inn_plan(p)),None)
    chosen=[primary,*([alt] if alt else [])]
    # Known coordinates are shared only inside one exact route family.
    shared={name:value for p in profiles for name,value in p['points'].items()}
    chosen=[{**p,'points':shared} for p in chosen]
    route_ms=(time.monotonic()-tick)*1000;tick=time.monotonic()
    points=resolve_points(topic,chosen,store,locator=locator)
    locate_ms=(time.monotonic()-tick)*1000;tick=time.monotonic()
    weather,stamp,error=forecasts(points,start,start+timedelta(days=max(len(p['days']) for p in chosen)),fetcher=fetcher,now=now)
    fetch_ms=(time.monotonic()-tick)*1000
    plan=plan_weather(primary,start,weather)
    alternative=plan_weather(alt,start,weather,rows=False) if alt else None
    names=list(dict.fromkeys(n for p in chosen for d in p['days'] for n in d['route']+([d['sleep']['name']] if d['sleep'] else [])))
    from route_notices import bundled_route_notices,notice_sentence
    notice=bundled_route_notices().lookup('',topic,start_date=start.isoformat(),end_date=(start+timedelta(days=len(primary['days'])-1)).isoformat(),route_variant=primary['variant'])
    missing=[n for n in names if n not in points]
    status='partial' if missing or error or any(count<24 for d in plan['days'] for count in d['coverage'].values()) else 'ok'
    return {**base,**plan,'status':status,'retrieved':stamp,'alternate':alternative,'missing':missing,
            'error':error,'notice':notice_sentence(notice) if notice else primary['notice'],
            'season':primary['season'],'timings':{'hiking_route_ms':round(route_ms,2),'hiking_locate_ms':round(locate_ms,2),'hiking_fetch_ms':round(fetch_ms,2)},
            'coordinate_sources':list(dict.fromkeys(p['source'] for p in points.values()))}

def build_hiking_tool(*,source,queue=None,outdoor_config=None):
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel,ConfigDict,Field
    class Args(BaseModel):
        model_config=ConfigDict(extra='forbid',strict=True)
        destination:str=Field(min_length=2,max_length=24,description='本条消息明确提到的公开户外路线，如党岭、武功山、哈巴西坡。只传名称。')
        start_date:str|None=Field(default=None,pattern=r'^\d{4}-\d{2}-\d{2}$',description='第一个徒步日；省略为今天。根据当前日期解析周末等。')
        route_variant:str|None=Field(default=None,max_length=40)
        overnight:Literal['auto','tent','inn']=Field(default='auto',description='默认auto：主路线与住店替代一起展示。询问有没有不露营方案仍选auto；明确只住店、不要露营才选inn，明确只露营才选tent。')
    def invoke(**args):
        try:
            card=make_trip(**args,queue=queue,source=source)
            if outdoor_config and card['days']:
                try:
                    matched=[k for k,v in outdoor_config['location_names'].items() if v==card['topic'] or v.removesuffix('代表点').endswith(card['topic'])]
                    if len(matched)!=1:raise KeyError('CLIMATE_LOCATION_AMBIGUOUS')
                    ident=matched[0]
                    climate=outdoor_config['climate_service'].normals(outdoor_config['locations'][ident],date.fromisoformat(card['start']).month)
                    row=climate['months'][0]
                    if row['complete']:
                        card['climate']=f"常年{row['month']}月：均温 {row['temperature_mean_c']:.1f}°C · 月降水 {row['precipitation_mm']:.1f} mm（ERA5 1991—2020，区域参考）。"
                except (KeyError,StopIteration,TypeError,ValueError):pass
            return {'status':card['status'],'hikingCard':card,'timings':card['timings'],
                    **({'error_code':card['error'],'failed_stage':'hiking_fetch'} if (card.get('error') or '').startswith('HIKING_FORECAST_') else {})}
        except (ValueError,KeyError):return {'status':'invalid','message':'请提供路线名和有效出发日期，例如：发 徒步 党岭 2026-11-14。'}
    return StructuredTool.from_function(invoke,name='hiking_trip_card',args_schema=Args,
        description='按路线典型徒步天数、沿途位置和营地生成温度、云量、雨雪图片，并列出有来源的住店替代与睡袋舒适温标。徒步路线的天气、装备、季节、住宿问题优先用此工具。资料不足安排一次受限后台补查，不猜营地；不要求调用聊天模型。')
