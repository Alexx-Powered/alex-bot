"""Build the local video gazetteer from the same verified CTAmap prefectures as the basemap."""
import hashlib
import gzip
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from pathlib import Path
from PIL import Image,ImageDraw

PROVINCES = {
    '11':'北京市','12':'天津市','13':'河北省','14':'山西省','15':'内蒙古自治区',
    '21':'辽宁省','22':'吉林省','23':'黑龙江省','31':'上海市','32':'江苏省','33':'浙江省',
    '34':'安徽省','35':'福建省','36':'江西省','37':'山东省','41':'河南省','42':'湖北省',
    '43':'湖南省','44':'广东省','45':'广西壮族自治区','46':'海南省','50':'重庆市',
    '51':'四川省','52':'贵州省','53':'云南省','54':'西藏自治区','61':'陕西省','62':'甘肃省',
    '63':'青海省','64':'宁夏回族自治区','65':'新疆维吾尔自治区','71':'台湾省',
    '81':'香港特别行政区','82':'澳门特别行政区',
}
GROUPS = {
    'north':('华北','11 12 13 14'), 'northeast':('东北','21 22 23'),
    'east':('华东','31 32 33 34 35 36 37 71'), 'central':('华中','41 42 43'),
    'south':('华南','44 45 46 81 82'), 'southwest':('西南','50 51 52 53'),
    'northwest':('西北','61 62 63 64'),
}
SHORT = {'15':'内蒙古','45':'广西','54':'西藏','64':'宁夏','65':'新疆','81':'香港','82':'澳门'}


def build(source, target):
    raw=source.read_bytes()
    digest=hashlib.sha256(raw).hexdigest()
    if digest!='2ee25af1abd1cfceceb83e20d14623879fe6005b8095237cdbf198c4b39b90e1':
        raise ValueError('Unexpected prefecture source')
    bounds=defaultdict(list); polygons=defaultdict(list)
    for feature in json.loads(raw)['features']:
        geom=feature['geometry']
        polys=geom['coordinates'] if geom['type']=='MultiPolygon' else [geom['coordinates']]
        code=feature['properties']['id'][:2]
        xs,ys=zip(*(p for poly in polys for p in poly[0]))
        bounds[code].append([min(xs),min(ys),max(xs),max(ys)])
        polygons[code].extend(polys)
    reference=json.loads(gzip.decompress(target.with_name('weather-xizang-reference.json.gz').read_bytes()))
    g=reference['province']
    polygons['54']=g['coordinates'] if g['type']=='MultiPolygon' else [g['coordinates']]
    xs,ys=zip(*(point for poly in polygons['54'] for point in poly[0]))
    bounds['54']=[[min(xs),min(ys),max(xs),max(ys)]]
    assert set(bounds)==set(PROVINCES)
    regions=[]

    def add(key,name,codes,base,suffix,point_aliases=()):
        pieces=[piece for code in codes for piece in bounds[code]]
        box=[(math.floor(min(p[i] for p in pieces)*10000) if i<2 else math.ceil(max(p[i] for p in pieces)*10000))/10000 for i in range(4)]
        aliases=set(base)-set(point_aliases)
        for value in base:
            aliases.update(('整个'+value,'全'+value,value+'全境',value+'全域',value+suffix))
        regions.append({'id':'cn-'+key,'name':name,'members':codes,'bounds':box,'aliases':sorted(aliases)})

    for code,full in PROVINCES.items():
        short=SHORT.get(code,full[:-1])
        base={short,full}
        if code in ('15','54','65'):base.add(short+'地区')
        if code=='15':base.add('内蒙')
        municipal=full.endswith('市')
        suffix='全市' if municipal else '全省' if full.endswith('省') else '全区'
        add(code,full if municipal or code=='71' else short,[code],base,suffix,base if municipal else ())
    for key,(name,members) in GROUPS.items():
        add(key,name,members.split(),{name,name+'地区'},'全区')
    keys=[alias for region in regions for alias in region['aliases']]
    assert len(keys)==len(set(keys)) and len(regions)==41
    # A georeferenced mask in each region's own Mercator bounding box keeps
    # labels and the surrounding context aligned at any output size.
    masks=target.with_name('weather-region-masks.zip')
    def mercator(lat):return math.asinh(math.tan(math.radians(lat)))
    with zipfile.ZipFile(masks,'w') as archive:
        for row in regions:
            w,s,e,n=row['bounds'];top,bottom=mercator(n),mercator(s)
            with Image.new('L',(512,512)) as mask:
                draw=ImageDraw.Draw(mask)
                for code in row['members']:
                    for poly in polygons[code]:
                        for i,ring in enumerate(poly):
                            points=[((lon-w)/(e-w)*512,(top-mercator(lat))/(top-bottom)*512) for lon,lat in ring]
                            draw.polygon(points,fill=0 if i else 255)
                if len(row['members'])==1:
                    with mask.resize((64,64),Image.Resampling.BOX) as thumb:
                        land=[(x+.5,y+.5) for y in range(64) for x in range(64) if thumb.getpixel((x,y))>200]
                    cx=sum(x for x,y in land)/len(land);cy=sum(y for x,y in land)/len(land)
                    x,y=min(land,key=lambda p:(p[0]-cx)**2+(p[1]-cy)**2)
                    row['label']={'name':PROVINCES[row['members'][0]],'lon':round(w+x/64*(e-w),5),
                                  'lat':round(math.degrees(math.atan(math.sinh(top-y/64*(top-bottom)))),5)}
                buffer=io.BytesIO();mask.save(buffer,'PNG',bits=8)
                archive.writestr(zipfile.ZipInfo(row['id']+'.png'),buffer.getvalue())
    data={'source':'CTAmap / cn-atlas 2023, prefectures.json','sourceSha256':digest,
          'tibetSource':reference['url'],'tibetArchiveSha256':reference['sha256'],
          'masksSha256':hashlib.sha256(masks.read_bytes()).hexdigest(),
          'classification':'中国气象局《气象地理区划规范》一级地区区划，内蒙古、西藏、新疆单列',
          'reference':'https://news.weather.com.cn/2022/01/3513034.shtml','regions':regions}
    target.write_text(json.dumps(data,ensure_ascii=False,indent=1)+'\n',encoding='utf-8')


if __name__=='__main__':
    build(Path(sys.argv[1]),Path(__file__).resolve().parents[1]/'data/weather-video-regions.json')
