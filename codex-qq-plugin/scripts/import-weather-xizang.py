"""Offline import of the public Tibet A2 FileGDB. No GIS dependency on the bot."""
import gzip
import hashlib
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

ROOT=Path(__file__).resolve().parents[1]
SOURCE='https://zrzyt.xizang.gov.cn/fw/zyxz/202004/P020220513410027712343.rar'
DIGEST='49d601fdc3c1dd1000556a727d4c6bd184e60635abf7bc1c36a8befc81674a7c'


def build(archive):
    from pyogrio.raw import read
    from pyproj import Transformer
    import shapely
    from shapely.ops import transform

    if hashlib.sha256(archive.read_bytes()).hexdigest()!=DIGEST:raise ValueError('Unexpected official FileGDB archive')
    tar=shutil.which('bsdtar') or shutil.which('tar')
    listing=subprocess.check_output([tar,'-tf',str(archive)])
    try:names=listing.decode('utf8')
    except UnicodeDecodeError:names=listing.decode('gb18030')
    for name in names.splitlines():
        path=PurePosixPath(name.replace('\\','/'))
        if path.is_absolute() or '..' in path.parts or ':' in name:raise ValueError('Unsafe archive path')
    source={'url':SOURCE,'sha256':DIGEST,'sourceCRS':'EPSG:4490','geometryCRS':'EPSG:4326','national':[],'centres':[]}
    with tempfile.TemporaryDirectory() as folder:
        subprocess.run([tar,'-xf',str(archive),'-C',folder],check=True)
        db,=list(Path(folder).rglob('a00000001.gdbtable'))
        project=Transformer.from_crs(4490,4326,always_xy=True).transform
        for layer in ('境界线','行政居民地','政区_西藏自治区'):
            meta,ids,wkb,arrays=read(db.parent,layer=layer,return_fids=True)
            if meta['crs']!='EPSG:4490':raise ValueError('Unexpected source CRS')
            for i,fid in enumerate(ids):
                attrs={name:col[i] for name,col in zip(meta['fields'],arrays)}
                geom=transform(project,shapely.from_wkb(wkb[i]))
                geometry=json.loads(shapely.to_geojson(shapely.set_precision(geom,0.00001)))
                if layer=='境界线' and attrs['NAME']=='国界':
                    rule=attrs['RuleID']
                    source['national'].append({'fid':int(fid),'gb':str(attrs['GB']),'name':attrs['NAME'],
                                               'rule':None if not math.isfinite(rule) else int(rule),'geometry':geometry})
                elif layer=='行政居民地' and attrs['LB'] in ('省级','地市级'):
                    source['centres'].append({'fid':int(fid),'name':attrs['NAME'],'level':attrs['LB'],
                                              'point':geometry['coordinates']})
                elif layer=='政区_西藏自治区':
                    source['province']=geometry
    assert len(source['national'])==5 and len(source['centres'])==7 and source['province']
    raw=json.dumps(source,ensure_ascii=False,separators=(',',':')).encode('utf8')
    (ROOT/'data/weather-xizang-reference.json.gz').write_bytes(gzip.compress(raw,mtime=0))


if __name__=='__main__':
    build(Path(sys.argv[1]).resolve())
