"""Build small offline 10-degree tiles from pinned, verified Natural Earth inputs.

Development-only: python scripts/build-weather-map.py <download-directory>
No network or extra GIS dependencies are needed at runtime.
"""
import gzip,hashlib,json,math,sys,zipfile
from collections import defaultdict
from pathlib import Path

APP=Path(__file__).resolve().parents[1]
def simplify(points,tolerance=.006):
    if len(points)<3:return points
    keep={0,len(points)-1};stack=[(0,len(points)-1)];limit=tolerance*tolerance
    while stack:
        lo,hi=stack.pop();ax,ay=points[lo];bx,by=points[hi];dx=bx-ax;dy=by-ay;length=dx*dx+dy*dy;best=limit;chosen=None
        for i in range(lo+1,hi):
            x,y=points[i];t=max(0,min(1,((x-ax)*dx+(y-ay)*dy)/length)) if length else 0
            d=(x-ax-t*dx)**2+(y-ay-t*dy)**2
            if d>best:best=d;chosen=i
        if chosen is not None:keep.add(chosen);stack.extend([(lo,chosen),(chosen,hi)])
    return [[round(points[i][0],4),round(points[i][1],4)] for i in sorted(keep)]

def build(source, prefectures):
    from shapely.geometry import Point,shape
    from shapely.ops import unary_union
    from shapely.prepared import prep
    from shapely import make_valid
    manifest=json.loads((source/'downloaded.json').read_text());tiles=defaultdict(lambda:{'lines':[],'labels':[]});used=[];counter=0
    cn=json.loads(prefectures.read_bytes())
    if hashlib.sha256(prefectures.read_bytes()).hexdigest()!='2ee25af1abd1cfceceb83e20d14623879fe6005b8095237cdbf198c4b39b90e1':
        raise ValueError('Unexpected prefectures')
    ref=json.loads(gzip.decompress((APP/'data/weather-xizang-reference.json.gz').read_bytes()))
    tibet=shape(ref['province'])
    domestic=prep(unary_union([tibet,*[make_valid(shape(f['geometry'])) for f in cn['features'] if not f['properties']['id'].startswith('54')]]))
    # Remove the old national border and any northern control line inside the
    # official Tibetan footprint. The small band covers source generalization.
    source_lines=unary_union([shape(f['geometry']) for f in ref['national']])
    tibet_cut=unary_union([tibet,source_lines.buffer(.045)])
    def read(name):
        row=next(r for r in manifest['files'] if r['name']==name);raw=(source/name).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'];used.append(row)
        return json.loads(raw)['features']
    def cell(lon,lat):return max(0,min(35,math.floor((lon+180)/10))),max(0,min(17,math.floor((lat+90)/10)))
    def line(points,kind,*,keep_vertices=False):
        nonlocal counter
        pieces=[];part=[]
        for p in points:
            if part and abs(p[0]-part[-1][0])>180:
                pieces.append(part);part=[]
            part.append(p[:2])
        pieces.append(part)
        for part in pieces:
            if len(part)<2:continue
            slim=part if keep_vertices else simplify(part)
            for start in range(0,len(slim)-1,48):
                pts=slim[start:start+49];counter+=1
                xs=[p[0] for p in pts];ys=[p[1] for p in pts];box=[min(xs),min(ys),max(xs),max(ys)]
                x0,y0=cell(box[0],box[1]);x1,y1=cell(box[2],box[3]);entry=[counter,kind,box,pts]
                for x in range(x0,x1+1):
                    for y in range(y0,y1+1):tiles[x,y]['lines'].append(entry)
    def linear(g):
        if g.is_empty:return
        if g.geom_type=='LineString':yield list(g.coords)
        elif hasattr(g,'geoms'):
            for part in g.geoms:yield from linear(part)

    for f in read('ne_50m_admin_0_boundary_lines_land.geojson'):
        g=f['geometry']
        props=f['properties']
        # The entire set of exceptional base features is in the review ledger.
        # In the unpublished draft none may default to an international border.
        if not g or props.get('FCLASS_CN') or props['FEATURECLA']!='International boundary (verify)':continue
        for pts in linear(shape(g).difference(tibet_cut)):line(pts,'country')
    for record in ref['national']:
        # NAME=国界 is not a treaty/delimitation status. Keep all five real
        # geometries in a distinct internal-review style, never infer a symbol.
        # At Chayu River the national originals carry the reach in cyan between
        # two black boundary symbols. This is a cartographic observation only.
        style='review_river' if record['fid']==368 else 'review_trace'
        for pts in linear(shape(record['geometry'])):line(pts,style,keep_vertices=True)
    ink_bytes=(APP/'data/weather-regional-ink-review.json').read_bytes()
    if hashlib.sha256(ink_bytes).hexdigest()!='59d4c57de54a46a33a1eef225f60d354672178dcbd8476cffa594ff8ed77ee4e':
        raise ValueError('Unrecognised registered reference geometry')
    ink=json.loads(ink_bytes)
    # Keep each printed component separate, including the dots on the ceasefire line.
    for mark in ink['marine']:
        for run in mark['ink']:line(run,'review_maritime',keep_vertices=True)
    for run in ink['kashmir']['districtDashes']:line(run,'review_region',keep_vertices=True)
    for point in ink['kashmir']['ceasefireDots']:line([point,point],'review_ceasefire',keep_vertices=True)
    def label(name,lon,lat,kind,rank,**meta):
        if not isinstance(name,str) or not name.strip() or not all(type(v) in (float,int) and math.isfinite(v) for v in [lon,lat]):return
        if not -180<=lon<=180 or not -85<=lat<=85:return
        tiles[cell(lon,lat)]['labels'].append({'name':name.strip(),'lon':round(lon,5),'lat':round(lat,5),'kind':kind,'rank':rank,**meta})
    for caption in ink['kashmir']['captions']:
        label(caption['text'],*caption['point'],'review_caption',0)
    units={r['id'][3:]:r for r in json.loads((APP/'data/weather-video-regions.json').read_bytes())['regions'] if r['id'][3:].isdigit()}
    for code,region in units.items():
        p=region['label'];label(p['name'],p['lon'],p['lat'],'province',0,province=code)
    catalog=json.loads((APP/'data/weather-locations.json').read_bytes())['places']
    by_code=defaultdict(list)
    for row in catalog:by_code[row.get('administrativeCode')].append(row)
    tibet_centres={r['name']:r for r in ref['centres']}
    for f in cn['features']:
        p=f['properties'];code=p['id'];province=code[:2]
        if not code.endswith('00') or code.endswith('0000'):continue
        seat,=by_code[code]
        name=p['地名'];lon,lat=seat['longitude'],seat['latitude']
        capital=code.endswith('0100')
        if province=='54':
            centre=tibet_centres[name];lon,lat=centre['point'];capital=centre['level']=='省级'
        label(name,lon,lat,'capital' if capital else 'prefecture',0,province=province,code=code,short=seat['sourceName'].removesuffix('市'))
    # Article 8 of MNR 2023/2 specifies these six administrative centres.
    for name in ('台北市','新北市','桃园市','台中市','台南市','高雄市'):
        seat,=[r for r in by_code['710000'] if r['admin2']==name and r['sourceName'].removesuffix('市')==name[:-1]]
        label(name,seat['longitude'],seat['latitude'],'capital' if name=='台北市' else 'prefecture',0,province='71',code='71-'+name)
    for name,lon,lat in [('钓鱼岛',123+28.4/60,25+44.6/60),('赤尾屿',124+33.5/60,25+55.3/60)]:
        label(name,lon,lat,'island',0,province='71')
    for f in read('ne_10m_admin_1_states_provinces.geojson'):
        p=f['properties']
        if p.get('adm0_a3') in {'CHN','TWN','HKG','MAC'}:continue
        if p.get('adm1_code') in {'IND-20012','IND-2431','PAK-1111','PAK-1109','KAS+00?'}:continue
        lon,lat=p['longitude'],p['latitude']
        if p.get('adm1_code')=='JPN-3502':
            # Its offshore label anchor falls east of Taiwan near the reviewed island marks.
            geom=shape(f['geometry'])
            island=max(geom.geoms,key=lambda g:g.area) if geom.geom_type=='MultiPolygon' else geom
            lon,lat=island.representative_point().coords[0]
        if domestic.covers(Point(lon,lat)):continue
        label(p.get('name_zh') or p.get('name_en') or p.get('name'),lon,lat,'province',p.get('scalerank',10))
    for f in read('ne_10m_populated_places.geojson'):
        p=f['properties'];lon,lat=f['geometry']['coordinates'][:2]
        if p.get('ADM0_A3') in {'CHN','TWN','HKG','MAC'} or domestic.covers(Point(lon,lat)):continue
        if p.get('FEATURECLA') in ('Admin-0 capital','Admin-1 capital','Admin-0 region capital'):
            label(p.get('NAME_ZH') or p.get('NAME_EN') or p.get('NAME'),lon,lat,'city',-(p.get('POP_MAX') or 0))
    target=APP/'data/weather-map.zip'
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for (x,y),data in sorted(tiles.items()):
            entry=zipfile.ZipInfo(f'{x}-{y}.json')
            z.writestr(entry,json.dumps(data,ensure_ascii=False,separators=(',',':')),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    note={'source':'Natural Earth, Tibet Natural Resources Department, CTAmap and QWeather GeoInfo','terms':'https://www.naturalearthdata.com/about/terms-of-use/','commit':manifest['commit'],'description':'Unpublished review draft. Exceptional global lines withheld pending Chinese standard-sheet review. Chinese labels use coded administrative units, not settlement population.','tibetSource':ref['url'],'tibetArchiveSha256':ref['sha256'],'taiwanCentres':'https://www.cgs.gov.cn/tzgg/tzgg/202302/t20230214_805031.html','islands':'https://www.mfa.gov.cn/diaoyudao/chn/xwdt/201209/t20120915_8523866.htm','files':used,'bundleSha256':hashlib.sha256(target.read_bytes()).hexdigest(),'tiles':len(tiles),'bytes':target.stat().st_size}
    note['regionalReview']={'source':ink['sourcePage'],'sheets':ink['sheets'],'sha256':hashlib.sha256(ink_bytes).hexdigest(),'use':'Registered printed marks for internal review.'}
    (APP/'data/weather-map-NOTICE.json').write_text(json.dumps(note,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'tiles':len(tiles),'lineChunks':counter,'bytes':target.stat().st_size,'sha256':note['bundleSha256']}))
if __name__=='__main__':build(Path(sys.argv[1]).resolve(),Path(sys.argv[2]).resolve())
