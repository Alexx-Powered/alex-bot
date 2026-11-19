"""Build small offline 10-degree tiles from pinned, verified Natural Earth inputs.

Development-only: python scripts/build-weather-map.py <download-directory>
No network or extra GIS dependencies are needed at runtime.
"""
import hashlib,json,math,sys,zipfile
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

def build(source):
    manifest=json.loads((source/'downloaded.json').read_text());tiles=defaultdict(lambda:{'lines':[],'labels':[]});used=[];counter=0
    def read(name):
        row=next(r for r in manifest['files'] if r['name']==name);raw=(source/name).read_bytes()
        assert hashlib.sha256(raw).hexdigest()==row['sha256'];used.append(row)
        return json.loads(raw)['features']
    def cell(lon,lat):return max(0,min(35,math.floor((lon+180)/10))),max(0,min(17,math.floor((lat+90)/10)))
    def line(points,kind):
        nonlocal counter
        pieces=[];part=[]
        for p in points:
            if part and abs(p[0]-part[-1][0])>180:
                pieces.append(part);part=[]
            part.append(p[:2])
        pieces.append(part)
        for part in pieces:
            if len(part)<2:continue
            slim=simplify(part)
            for start in range(0,len(slim)-1,48):
                pts=slim[start:start+49];counter+=1
                xs=[p[0] for p in pts];ys=[p[1] for p in pts];box=[min(xs),min(ys),max(xs),max(ys)]
                x0,y0=cell(box[0],box[1]);x1,y1=cell(box[2],box[3]);entry=[counter,kind,box,pts]
                for x in range(x0,x1+1):
                    for y in range(y0,y1+1):tiles[x,y]['lines'].append(entry)
    for f in read('ne_50m_admin_0_boundary_lines_land.geojson'):
        g=f['geometry']
        # Zhuhai–Macao and Shenzhen–Hong Kong use the shared municipal path.
        if not g or f['properties'].get('NE_ID') in {1746705295,1746708389}:continue
        classification=str(f['properties'].get('FEATURECLA','')).lower()
        style='disputed' if any(x in classification for x in ['disputed','indefinite','control','unrecognized']) else 'country'
        for pts in ([g['coordinates']] if g['type']=='LineString' else g['coordinates']):line(pts,style)
    def label(name,lon,lat,kind,rank):
        if not isinstance(name,str) or not name.strip() or not all(type(v) in (float,int) and math.isfinite(v) for v in [lon,lat]):return
        if not -180<=lon<=180 or not -85<=lat<=85:return
        tiles[cell(lon,lat)]['labels'].append({'name':name.strip(),'lon':round(lon,5),'lat':round(lat,5),'kind':kind,'rank':rank})
    for f in read('ne_10m_admin_1_states_provinces.geojson'):
        p=f['properties']
        if p.get('adm0_a3') in {'HKG','MAC'}:continue
        label(p.get('name_zh') or p.get('name_en') or p.get('name'),p.get('longitude'),p.get('latitude'),'province',p.get('scalerank',10))
    for f in read('ne_10m_populated_places.geojson'):
        p=f['properties'];lon,lat=f['geometry']['coordinates'][:2]
        label(p.get('NAME_ZH') or p.get('NAME_EN') or p.get('NAME'),lon,lat,'city',-(p.get('POP_MAX') or 0))
    target=APP/'data/weather-map.zip'
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for (x,y),data in sorted(tiles.items()):
            entry=zipfile.ZipInfo(f'{x}-{y}.json')
            z.writestr(entry,json.dumps(data,ensure_ascii=False,separators=(',',':')),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    note={'source':'Natural Earth, public domain','terms':'https://www.naturalearthdata.com/about/terms-of-use/','commit':manifest['commit'],'description':'National boundary lines and province/city names. WGS84, 10-degree tiles. Subnational lines and water come exclusively from weather-ground.sqlite3.','files':used,'bundleSha256':hashlib.sha256(target.read_bytes()).hexdigest(),'tiles':len(tiles),'bytes':target.stat().st_size}
    (APP/'data/weather-map-NOTICE.json').write_text(json.dumps(note,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'tiles':len(tiles),'lineChunks':counter,'bytes':target.stat().st_size,'sha256':note['bundleSha256']}))
if __name__=='__main__':build(Path(sys.argv[1]).resolve())
