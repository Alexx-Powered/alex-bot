"""Bounded public OSM place search; deterministic LangChain tool, no model credentials."""
import json, math, re, sys, unicodedata
import amap_places
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.parse import urlencode
from pydantic import BaseModel, ConfigDict, Field
from langchain_core.tools import tool

URL='https://photon.komoot.io/api/'
TAGS={'natural':{'peak','volcano','saddle','valley','water','beach','cape','cave_entrance','glacier'},'tourism':{'attraction','viewpoint','museum'},'place':{'village','hamlet','town','locality','isolated_dwelling'},'route':{'hiking','foot'},'highway':{'path','footway','steps'},'leisure':{'nature_reserve','park'}}
NAME=re.compile(r"^[\w\s·（）(),，.'’\-]+$",re.UNICODE)
class Args(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    query:str=Field(min_length=1,max_length=60)
    expanded:bool=False

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('LOCATION_SOURCE_UNAVAILABLE')

def compact(s):return re.sub(r'[\s·,，()（）]', '',unicodedata.normalize('NFKC',s)).casefold()
def safe(s):
    if not isinstance(s,str):return ''
    return ''.join(c for c in s if c.isalnum() or unicodedata.category(c).startswith('M') or c in " ·（）(),，.'’-").strip()[:80]

def fetch(query,expanded=False):
    params=[('q',query),('limit','20')]
    if not expanded:
        params.extend(('osm_tag',k+':'+v) for k,values in TAGS.items() for v in sorted(values))
    request=Request(URL+'?'+urlencode(params),headers={'User-Agent':'AlexQQBot-WeatherPlaces/1.0','Accept':'application/json'})
    with build_opener(NoRedirect()).open(request,timeout=7) as response:
        if response.headers.get_content_type()!='application/json':raise ValueError('LOCATION_SOURCE_UNAVAILABLE')
        raw=response.read(524289)
        if len(raw)>524288:raise ValueError('LOCATION_SOURCE_UNAVAILABLE')
    return json.loads(raw)

def parse(data,query,expanded=False):
    if not isinstance(data,dict) or not isinstance(data.get('features'),list) or len(data['features'])>20:raise ValueError('LOCATION_SOURCE_UNAVAILABLE')
    result={};tokens=[compact(x) for x in re.split(r'[\s·,，]+',query) if x]
    for item in data['features']:
        p=item.get('properties',{});g=item.get('geometry',{})
        if expanded and re.search(r'[峰岭山]$',query) and p.get('osm_key') not in {'natural','tourism','leisure'}:
            continue
        if p.get('osm_value') not in TAGS.get(p.get('osm_key'),set()) and not (expanded and compact(safe(p.get('name'))) == compact(query)):continue
        name=safe(p.get('name'));address=[safe(p.get(k)) for k in ['country','state','county','city','district']];names=[name]+[safe(p.get(k)) for k in ['name:zh','name:en']]
        # Reject fuzzy unrelated suggestions and nearby shops/roads. Every qualifier must match.
        haystack=compact(' '.join(address+names))
        if not name or not all(token in haystack for token in tokens):continue
        if p.get('osm_type') not in {'N','W','R'} or type(p.get('osm_id')) is not int or p['osm_id']<=0:raise ValueError('LOCATION_SOURCE_UNAVAILABLE')
        xy=g.get('coordinates')
        if g.get('type')!='Point' or not isinstance(xy,list) or len(xy)!=2 or any(type(x) not in (int,float) or not math.isfinite(x) for x in xy) or abs(xy[0])>180 or abs(xy[1])>90:raise ValueError('LOCATION_SOURCE_UNAVAILABLE')
        route=p['osm_key'] in {'route','highway'}
        def display(value):
            return re.split(r'\s+(?=[^\u3400-\u9fff0-9])',value)[0] if re.search(r'[\u3400-\u9fff]',value) else value
        parts=list(dict.fromkeys(display(x) for x in [safe(p.get('state')),safe(p.get('county')),safe(p.get('city')),safe(p.get('district'))] if x))
        name=display(name)
        # Keep the full locality context where it fits the established 100-character interface.
        label='·'.join(parts+[name])
        if route:label+='（步道代表点）'
        if len(label)>100:label='·'.join(parts[-2:]+[name[:55]])+('（步道代表点）' if route else '')
        ident='osm-'+p['osm_type'].lower()+'-'+str(p['osm_id'])
        result[ident]={'id':ident,'name':label,'longitude':xy[0],'latitude':xy[1]}
    return list(result.values())[:8]

@tool(args_schema=Args)
def search_outdoor_places(query:str,expanded:bool=False)->dict:
    """Resolve named attractions, peaks, hiking paths and villages to representative WGS84 coordinates; ambiguity is preserved."""
    if query!=query.strip() or not NAME.fullmatch(query) or any(c in query for c in '\r\n\t'):
        return {'error':'LOCATION_INPUT_INVALID'}
    if expanded and re.search(r'[\u3400-\u9fff]',query):
        try:
            places=amap_places.search(query)
            if places:return {'places':places}
        except (OSError,ValueError):
            pass
    try:return {'places':parse(fetch(query,True) if expanded else fetch(query),query,expanded)}
    except Exception:return {'error':'LOCATION_SOURCE_UNAVAILABLE'}

if __name__=='__main__':
    try:print(json.dumps(search_outdoor_places.invoke(json.loads(sys.stdin.buffer.readline(4097))),ensure_ascii=False))
    except Exception:print(json.dumps({'error':'LOCATION_INPUT_INVALID'}))
