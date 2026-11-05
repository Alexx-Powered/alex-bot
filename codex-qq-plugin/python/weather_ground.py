"""Render real water, hillshade and local administrative lines for one viewport."""
import io
import math
import sqlite3
import struct
import zlib
from contextlib import closing
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

DATABASE = Path(__file__).resolve().parents[1] / 'data/weather-ground.sqlite3'


def latitude(y, world):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2*y/world))))


class Viewport:
    def __init__(self, area, pixels):
        self.area = area
        self.pixels = pixels
        self.west = area['left'] / area['world'] * 360 - 180
        self.east = (area['left']+area['size']) / area['world'] * 360 - 180
        self.north = latitude(area['top'], area['world'])
        self.south = latitude(area['top']+area['size'], area['world'])

    def point(self, lon, lat):
        center = (self.west + self.east)/2
        dx = (lon-center+180) % 360-180
        y = (1-math.asinh(math.tan(math.radians(max(-85.05,min(85.05,lat)))))/math.pi)/2
        return ((.5+dx/(self.east-self.west))*self.pixels,
                (y*self.area['world']-self.area['top'])/self.area['size']*self.pixels)

    def geographic(self, x, y):
        lon = (self.west + x/self.pixels*(self.east-self.west) + 180) % 360-180
        lat = latitude(self.area['top']+y/self.pixels*self.area['size'], self.area['world'])
        return lon, lat

    def features(self, db, kind):
        seen = set()
        for offset in (-360,0,360):
            west,east = max(-180,self.west+offset),min(180,self.east+offset)
            if west>east:continue
            sql = '''SELECT f.id,f.name,f.coords FROM bounds b JOIN features f ON f.id=b.id
                     WHERE b.west<=? AND b.east>=? AND b.south<=? AND b.north>=? AND f.kind=?'''
            for index,name,data in db.execute(sql,(east,west,self.north,self.south,kind)):
                if index not in seen:
                    seen.add(index)
                    yield name, decode(data)


def decode(compressed):
    raw = memoryview(zlib.decompress(compressed))
    rings = []; offset = 0
    while offset<len(raw):
        count, = struct.unpack_from('<I',raw,offset); offset += 4
        stop = offset + count*8
        x = y = 0; points = []
        for dx,dy in struct.iter_unpack('<ii',raw[offset:stop]):
            x += dx; y += dy; points.append((x/10000,y/10000))
        rings.append(points); offset = stop
    return rings


def relief_image(db, view):
    # Source pixel edges are at -180 / +90 degrees, 30 samples per degree.
    x0=math.floor((view.west+180)*30)-2; x1=math.ceil((view.east+180)*30)+2
    y0=math.floor((90-view.north)*30)-2; y1=math.ceil((90-view.south)*30)+2
    region=Image.new('L',(x1-x0,y1-y0),204)
    for x in range(x0//300,(x1-1)//300+1):
        for y in range(y0//300,(y1-1)//300+1):
            row=db.execute('SELECT png FROM relief WHERE x=? AND y=?',(x%36,y)).fetchone()
            if row:
                with Image.open(io.BytesIO(row[0])) as tile:region.paste(tile,(300*x-x0,300*y-y0))
    size=view.pixels; mesh=[]; left=(view.west+180)*30-x0; right=(view.east+180)*30-x0
    for top in range(0,size,32):
        bottom=min(size,top+32)
        t=(90-view.geographic(0,top)[1])*30-y0; b=(90-view.geographic(0,bottom)[1])*30-y0
        mesh.append(((0,top,size,bottom),(left,t,left,b,right,b,right,t)))
    image=region.transform((size,size),Image.Transform.MESH,mesh,Image.Resampling.BICUBIC)
    region.close()
    return image


def paint_polygon(draw, view, rings, fill, hole):
    for i,ring in enumerate(rings):
        if len(ring)>=3:draw.polygon([view.point(*p) for p in ring],fill=hole if i else fill)


def water_candidates(masks, water, view):
    candidates=[]
    with water.resize((128,128),Image.Resampling.NEAREST) as wet:
        for (kind,name),mask in masks.items():
            visible=ImageChops.multiply(mask,wet); mask.close()
            # Keep water names inside visible water and away from the HUD. The
            # largest interior patch first, alternate anchors if labels collide.
            bounds=visible.getbbox()
            if bounds:
                samples=[]; cx=(bounds[0]+bounds[2])/2; cy=(bounds[1]+bounds[3])/2
                for y in range(max(20,bounds[1]),min(96,bounds[3]),2):
                    for x in range(max(4,bounds[0]),min(124,bounds[2]),2):
                        if visible.getpixel((x,y)) and visible.getpixel((x-2,y)) and visible.getpixel((x+2,y)):
                            samples.append(((cx-x)**2+(cy-y)**2,x,y))
                selected=[]
                for _,x,y in sorted(samples):
                    if any(abs(x-a)+abs(y-b)<12 for a,b in selected):continue
                    selected.append((x,y));lon,lat=view.geographic((x+.5)*view.pixels/128,(y+.5)*view.pixels/128)
                    candidates.append({'kind':'water','name':name,'lon':lon,'lat':lat,'rank':0 if kind=='lake' else 1})
                    if len(selected)==4:break
            visible.close()
    return candidates


def ground_layer(area, size, layer):
    view=Viewport(area,size); small_view=Viewport(area,128); labels=[]; masks={}
    water=Image.new('L',(size,size),255); wet_draw=ImageDraw.Draw(water)
    with closing(sqlite3.connect(DATABASE.resolve().as_uri()+'?mode=ro&immutable=1',uri=True)) as db:
        db.execute('PRAGMA cache_size=-384')
        for kind in ('land','lake','sea'):
            for name,rings in view.features(db,kind):
                if kind!='sea':paint_polygon(wet_draw,view,rings,0 if kind=='land' else 255,255 if kind=='land' else 0)
                if kind!='land' and name:
                    key=(kind,name)
                    if key not in masks:masks[key]=Image.new('L',(128,128))
                    paint_polygon(ImageDraw.Draw(masks[key]),small_view,rings,255,0)
        labels.extend(water_candidates(masks,water,view))
        shade=relief_image(db,view)
        intensity=.23 if layer=='cloud' else .53
        alpha=shade.point([min(43,round(abs(v-204)*intensity)) for v in range(256)])
        tone=shade.point([0 if v<204 else 255 for v in range(256)])
        ground=Image.merge('RGBA',(tone,tone,tone,alpha));shade.close();alpha.close();tone.close()
        ground.paste((30,107,151,19 if layer=='cloud' else 53),(0,0),water)
        water.close()
        # A shore is the edge of the water fill. Only shared administrative
        # edges receive a stroke, including real boundaries crossing a lake.
        draw=ImageDraw.Draw(ground)
        ink={'temperature':(35,40,43,139),'cloud':(152,157,160,183)}.get(layer,(229,234,237,145))
        thin=max(1,round(size/900))
        members=set(area.get('members',()))
        for kind,width in (('district',thin),('province',max(thin+1,round(size/380)))):
            for owners,rings in view.features(db,kind):
                selected=False
                if members and kind=='province' and '|' in owners:
                    left,right=owners.split('|',1)
                    selected=(left[:2] in members)!=(right[:2] in members)
                stroke=(*ink[:3],222) if selected else ink
                for ring in rings:
                    points=[view.point(*p) for p in ring]
                    if len(points)>=2 and all(abs(a[0]-b[0])<=size*3 for a,b in zip(points,points[1:])):
                        draw.line(points,fill=stroke,width=width+int(selected),joint='curve')
        # Administrative centres and their codes come from the label bundle.
        # Polygon representative points in older ground databases are not seats.
    return ground,labels
