"""Build the read-only, spatially indexed ground layer on the developer machine.

Inputs and upstream hashes are pinned below. Build dependencies: pyshp, shapely, Pillow.
The deployed reader uses only sqlite3, struct, zlib and Pillow.
"""
import hashlib
import gzip
import io
import json
import math
import sqlite3
import struct
import sys
import zipfile
import zlib
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    'world-adm1.zip': ('https://www.geoboundaries.org/globalDownloads.html', '767ed22dfddf8a82d5c7d23149628378f8d2d95a2bb915401afaa65c5593e6f8'),
    'world-adm2.zip': ('https://www.geoboundaries.org/globalDownloads.html', '598f6c70893d60a35b96eb0dc31fd1c045e69177e4b8203407710306f6585de1'),
    'prefectures.json': ('https://github.com/BarbarossaWang/cn-atlas/blob/6e83a19923e39f2c0e58a0a7ad29b349b2a71b9f/prefectures.json', '2ee25af1abd1cfceceb83e20d14623879fe6005b8095237cdbf198c4b39b90e1'),
    'ne_10m_land.zip': ('https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_land.zip', 'e547d749445eaa0964aba76738090ec88f5e63c4585122170f98c67a7ea922dc'),
    'ne_10m_lakes.zip': ('https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_lakes.zip', '0803a06f9c3cb4671d89b68c48b142aad9366ba40f665245e12a913fbc61722a'),
    'ne_10m_geography_marine_polys.zip': ('https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_geography_marine_polys.zip', 'a2d3395904c41e718e02c3ec5bc988712164c524c236fad32d95d282ca303b2a'),
    'SR_50M.zip': ('https://naturalearth.s3.amazonaws.com/50m_raster/SR_50M.zip', 'ff810f5f2747463fd8ffa612b23e5f5e5d593a345218976872b6749610976ab7'),
}


def digest(path):
    with path.open('rb') as reader:
        return hashlib.file_digest(reader, 'sha256').hexdigest()


def polygons(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type == 'Polygon':
        yield geometry
    elif hasattr(geometry, 'geoms'):
        for part in geometry.geoms:
            yield from polygons(part)


def encode_rings(rings):
    data = bytearray()
    for points in rings:
        coords = [(round(x * 10000), round(y * 10000)) for x, y in points]
        data.extend(struct.pack('<I', len(coords)))
        last_x = last_y = 0
        for x, y in coords:
            data.extend(struct.pack('<ii', x-last_x, y-last_y))
            last_x, last_y = x, y
    return zlib.compress(data)


def vertex_id(coord):
    x, y = coord
    return ((round(x * 1_000_000) + 180_000_000) << 28) | (round(y * 1_000_000) + 90_000_000)


def shared_boundaries(units, insert, country, tolerance):
    """Store each shared municipal edge once. The owners supply the pen width."""
    from shapely.geometry import LineString

    edges = {}
    parents = {}

    def write_run(owner, neighbor, coords):
        if neighbor is None or len(coords) < 2:
            return
        a, b = parents[owner], parents[neighbor]
        kind = 'province' if a and b and a != b else 'district'
        if country == 'CHN' and kind == 'district' and not (owner.endswith('00') or neighbor.endswith('00')):
            return  # Directly administered counties complete the province edge.
        name = '|'.join(sorted((owner,neighbor))) if country == 'CHN' else country
        if tolerance and len(coords) > 2:
            coords = list(LineString(coords).simplify(tolerance).coords)
        for i in range(0, len(coords)-1, 96):
            part = coords[i:i+97]
            xs, ys = zip(*part)
            insert(kind, name, (min(xs),min(ys),max(xs),max(ys)), [part])

    for owner, parent, geom in units:
        parents[owner] = parent
        for poly in polygons(geom):
            for ring in (poly.exterior, *poly.interiors):
                coords = iter(ring.coords)
                last = next(coords)
                previous = vertex_id(last)
                neighbor = None
                run = []
                for point in coords:
                    current = vertex_id(point)
                    if previous == current:
                        continue
                    edge = (previous,current) if previous < current else (current,previous)
                    other = edges.pop(edge,None)
                    if other is None:
                        edges[edge] = owner
                    if other == owner:
                        other = None
                    if other != neighbor:
                        write_run(owner, neighbor, run)
                        neighbor = other
                        run = [last] if other is not None else []
                    if neighbor is not None:
                        run.append(point)
                    last, previous = point, current
                write_run(owner, neighbor, run)


def global_boundaries(folder, insert):
    import shapefile
    from shapely import STRtree
    from shapely.geometry import shape

    # These four upstream parent units overlap the Kashmir area. The government
    # originals use a region boundary and ceasefire symbols drawn by the map layer.
    kashmir_parents={'70912109B54485417915534','70912109B7720427584286',
                     '1811400B23769854471902','1811400B42025667129192'}

    def index_by_country(reader, level):
        groups = defaultdict(list)
        for i,row in enumerate(reader.iterRecords(fields=['shapeID','shapeGroup','shapeType'])):
            if row.shapeType == level and row.shapeGroup not in {'CHN','TWN','MAC','HKG'}:
                groups[row.shapeGroup].append((i,row.shapeID))
        return groups

    def assign_parent(geom, tree, parent_ids):
        matches = tree.query(geom.representative_point(), predicate='intersects')
        if len(matches) == 1:
            return parent_ids[matches[0]]
        # Multipart offshore districts can have their representative point
        # outside ADM1. In those cases use the largest positive area overlap.
        best = 0
        chosen = None
        for i in tree.query(geom):
            parent = tree.geometries[i]
            if not parent.is_valid:
                parent = parent.buffer(0)
            overlap = parent.intersection(geom if geom.is_valid else geom.buffer(0)).area
            if overlap > best:
                chosen, best = parent_ids[i], overlap
        return chosen

    count = 0
    with shapefile.Reader(str(folder/'geoBoundariesCGAZ_ADM1.shp'),encoding='latin1') as adm1, \
         shapefile.Reader(str(folder/'geoBoundariesCGAZ_ADM2.shp'),encoding='latin1') as adm2:
        provinces = index_by_country(adm1,'ADM1')
        districts = index_by_country(adm2,'ADM2')
        for country in sorted(provinces.keys() | districts.keys()):
            ids = [code for _,code in provinces[country]]
            geoms = [shape(adm1.shape(i).__geo_interface__) for i,_ in provinces[country]]
            if districts[country]:
                tree = STRtree(geoms)
                def units():
                    for i, code in districts[country]:
                        geom = shape(adm2.shape(i).__geo_interface__)
                        parent=assign_parent(geom,tree,ids)
                        if parent not in kashmir_parents:yield code,parent,geom
                shared_boundaries(units(), insert, country, .002)
                count += len(districts[country])
            else:
                shared_boundaries(((code,code,geom) for code,geom in zip(ids,geoms) if code not in kashmir_parents), insert, country, .002)
    return count


def build(folder):
    import shapefile
    from shapely.geometry import shape,LineString
    from shapely.ops import clip_by_rect,unary_union
    from shapely.prepared import prep
    from shapely import make_valid
    from PIL import Image

    for name, (_, expected) in SOURCES.items():
        if digest(folder/name) != expected:
            raise ValueError(f'Unexpected source file: {name}')
        if name.endswith('.zip'):
            with zipfile.ZipFile(folder/name) as archive:
                archive.extractall(folder/'inputs')

    target = ROOT/'data/weather-ground.sqlite3'
    draft = folder/'ground-building.sqlite3'
    draft.unlink(missing_ok=True)
    db = sqlite3.connect(draft)
    db.executescript('''
        PRAGMA journal_mode=OFF;
        CREATE TABLE features(id INTEGER PRIMARY KEY,kind TEXT,name TEXT,coords BLOB);
        CREATE VIRTUAL TABLE bounds USING rtree(id,west,east,south,north);
        CREATE TABLE relief(x INTEGER,y INTEGER,png BLOB,PRIMARY KEY(x,y)) WITHOUT ROWID;
    ''')

    def insert(kind, name, bounds, rings):
        west, south, east, north = bounds
        row = db.execute('INSERT INTO features(kind,name,coords) VALUES (?,?,?)', (kind,name,encode_rings(rings)))
        db.execute('INSERT INTO bounds VALUES (?,?,?,?,?)',(row.lastrowid, west,east,south,north))

    mainland = []
    china_count = 0
    domestic=[]
    tibet=json.loads(gzip.decompress((ROOT/'data/weather-xizang-reference.json.gz').read_bytes()))
    domestic.append(shape(tibet['province']))
    for row in json.loads((folder/'prefectures.json').read_text(encoding='utf-8'))['features']:
        prop = row['properties']; code = str(prop['id'])
        geom = shape(row['geometry'])
        if not code.startswith('54'):domestic.append(make_valid(geom))
        if code.startswith('71'):
            continue
        name=prop['地名']
        mainland.append((code, code[:2], geom))
        if code.endswith('00') and not code.startswith(('81','82')):
            china_count += 1
            point = geom.representative_point()
            insert('citylabel',name,point.bounds,[[(point.x,point.y)]])
    shared_boundaries(mainland,insert,'CHN',0)
    footprint=unary_union(domestic)
    prepared=prep(footprint)
    west,south,east,north=footprint.bounds
    def foreign_insert(kind,name,bounds,rings):
        w,s,e,n=bounds
        if e<west or w>east or n<south or s>north:
            insert(kind,name,bounds,rings)
            return
        line=LineString(rings[0])
        if not prepared.intersects(line):
            insert(kind,name,bounds,rings)
            return
        outside=line.difference(footprint)
        parts=outside.geoms if hasattr(outside,'geoms') else [outside]
        for part in parts:
            if not part.is_empty and part.geom_type=='LineString':
                insert(kind,name,part.bounds,[part.coords])
    count = global_boundaries(folder/'inputs',foreign_insert)
    print('Municipal geometries',count,china_count,flush=True)

    def store_surface(geometry,kind,name):
        for poly in polygons(geometry.simplify(.0025, preserve_topology=False)):
            west,south,east,north=poly.bounds
            for x in range(math.floor(west/5),math.ceil(east/5)):
                for y in range(math.floor(south/5),math.ceil(north/5)):
                    for piece in polygons(clip_by_rect(poly,x*5,y*5,x*5+5,y*5+5)):
                        rings = [piece.exterior.coords, *(r.coords for r in piece.interiors)]
                        insert(kind,name,piece.bounds,rings)

    for source,kind in [('land','land'),('lakes','lake'),('geography_marine_polys','sea')]:
        reader=shapefile.Reader(str(folder/f'inputs/ne_10m_{source}.shp'))
        for rec in reader.iterShapeRecords():
            prop=rec.record.as_dict(); name=prop.get('name_zh') or prop.get('name') or ''
            store_surface(shape(rec.shape.__geo_interface__),kind,name)
    with Image.open(folder/'inputs/SR_50M.tif') as raster:
        if raster.size!=(10800,5400) or raster.mode!='L':raise ValueError('Unexpected relief grid')
        for x in range(36):
            for y in range(18):
                tile=raster.crop((300*x,300*y,300*x+300,300*y+300)); stream=io.BytesIO()
                tile.save(stream,'PNG'); db.execute('INSERT INTO relief VALUES (?,?,?)',(x,y,stream.getvalue()))
    db.commit(); db.execute('VACUUM'); db.close(); draft.replace(target)
    note={'sources':SOURCES,'geometry':'EPSG:4326','mainlandUnits':china_count,'otherADM2':count,
          'tibetClip':{'source':tibet['url'],'sha256':tibet['sha256']},'foreignAdminExcludes':['CHN','TWN','HKG','MAC'],
          'credit':['Natural Earth, public domain','Runfola et al. (2020), geoBoundaries, CC BY 4.0, https://doi.org/10.1371/journal.pone.0231866',
                    'Rui Cheng, CTAmap provincial, municipal and county administrative divisions, 2023 edition. Prefectures redistributed by Amll/cn-atlas (ISC). https://github.com/ruiduobao/shengshixian.com'],
          'processing':'Internal lines are shared polygon edges, stored once and styled by the two owners. Mainland Chinese province membership uses the first two digits of the administrative code, including directly administered county-level units. CGAZ ADM1 identifies parents of other ADM2 units, or supplies shared edges where ADM2 is unavailable. No coastlines inferred from administrative polygons. Physical polygons tiled, land relief cropped from SR_50M.', 'sha256':digest(target)}
    note['kashmir']='Four unverified upstream IND/PAK ADM1 units and their assigned internal edges are excluded from the internal map candidate.'
    (target.parent/'weather-ground-NOTICE.json').write_text(json.dumps(note,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print('Built',target.stat().st_size,note['sha256'],flush=True)


if __name__=='__main__':
    build(Path(sys.argv[1]).resolve())
