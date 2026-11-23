"""Resolve named mainland POIs and normalize their GCJ-02 coordinates for weather."""
import hashlib
import json
import math
import os
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener


def forecast_coords(lon, lat):
    # Invert the mainland GCJ displacement at the POI; return WGS84 lon, lat.
    if not (72 <= lon <= 138 and 0.8 <= lat <= 56):
        raise ValueError('UNSUPPORTED_COORDINATE')
    xlon, ylat = lon, lat
    for _ in range(3):
        x, y = xlon - 105, ylat - 35
        wave = lambda a: math.sin(math.pi * a)
        common = (20 * wave(6*x) + 20 * wave(2*x)) * 2/3
        dy = (-100+2*x+3*y+.2*y*y+.1*x*y+.2*math.sqrt(abs(x)) + common
              + (20*wave(y)+40*wave(y/3)+160*wave(y/12)+320*wave(y/30))*2/3)
        dx = (300+x+2*y+.1*x*x+.1*x*y+.1*math.sqrt(abs(x)) + common
              + (20*wave(x)+40*wave(x/3)+150*wave(x/12)+300*wave(x/30))*2/3)
        rad = math.radians(ylat)
        eccentricity = 0.006693421622965943
        m = 1 - eccentricity*math.sin(rad)**2
        ylat = lat - math.degrees(dy*m**1.5/(6378245*(1-eccentricity)))
        xlon = lon - math.degrees(dx*math.sqrt(m)/(6378245*math.cos(rad)))
    return round(xlon, 6), round(ylat, 6)


def candidates(payload, query):
    if payload.get('status') != '1' or not isinstance(payload.get('pois'), list):
        raise ValueError('AMAP_UNAVAILABLE')
    query = re.sub(r'[\s·]', '', query)
    matches = []
    for row in payload['pois']:
        name, kind, ident = (row.get(k) for k in ('name','type','id'))
        if not all(isinstance(x,str) and x for x in (name, kind, ident)) or not re.fullmatch('[A-Za-z0-9]+',ident):
            continue
        parts = [v for k in ('pname','cityname','adname') if isinstance(v:=row.get(k),str) and v]
        if query != name:
            prefix = query.removesuffix(name)
            if prefix == query or not prefix or prefix not in ''.join(parts):
                continue
        if query.endswith(('山','峰','岭')) and not any(t in kind for t in ('自然地名','山岳','风景名胜')):
            continue
        if query.endswith('村') and not any(t in kind for t in ('村庄','村级','普通地名','行政地名')):
            continue
        coords = str(row.get('location','')).split(',')
        if len(coords) != 2:
            continue
        try:
            lon, lat = forecast_coords(*map(float,coords))
        except ValueError:
            continue
        matches.append(dict(id='amap-'+ident,name='·'.join(dict.fromkeys(parts+[name])),longitude=lon,latitude=lat))
    return matches[:8]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise ValueError('AMAP_REDIRECT')


def credential(name):
    value = os.environ.get(name)
    if value:
        return value.strip()
    filename = os.environ.get(name+'_FILE')
    if filename:
        value = Path(filename).read_text(encoding='utf-8-sig').strip()
        if not value:
            raise ValueError('AMAP_EMPTY_CREDENTIAL')
    return value


def fetch(endpoint, **params):
    request = Request('https://restapi.amap.com/'+endpoint+'?'+urlencode(params))
    with build_opener(NoRedirect()).open(request,timeout=5) as response:
        raw=response.read(524289)
    if len(raw)>524288:
        raise ValueError('AMAP_RESPONSE_TOO_LARGE')
    return json.loads(raw)


def search(query):
    key = credential('AMAP_WEB_KEY')
    if not key:
        return []
    rows = candidates(fetch('v5/place/text',key=key,keywords=query,page_size=20,output='json'),query)
    if rows or not query.endswith('村'):
        return rows
    data = fetch('v3/geocode/geo',key=key,address=query,output='json')
    if data.get('status') != '1':
        raise ValueError('AMAP_UNAVAILABLE')
    for item in data.get('geocodes',[]):
        address = item.get('formatted_address')
        if item.get('level') != '村庄' or not isinstance(address,str) or not address.endswith(re.sub(r'[\s·]','',query)):
            continue
        coords=item.get('location','').split(',')
        if len(coords)!=2:
            continue
        lon,lat=forecast_coords(*map(float,coords))
        ident=hashlib.sha256(address.encode()).hexdigest()[:24]
        return [dict(id='amap-geo'+ident,name=address,longitude=lon,latitude=lat)]
    return []
