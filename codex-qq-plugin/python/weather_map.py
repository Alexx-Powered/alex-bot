"""Small offline administrative map overlay; no remote tiles or user paths."""
import json,math,zipfile
from pathlib import Path
from weather_ground import ground_layer
from weather_regions import focus_mask
from PIL import Image,ImageDraw,ImageFont
from render_fonts import font_path

DATA=Path(__file__).resolve().parents[1]/'data/weather-map.zip'
def xy(lon,lat,world):return (lon+180)/360*world,(1-math.asinh(math.tan(math.radians(max(-85.0511,min(85.0511,lat)))))/math.pi)/2*world
def latitude(y,world):return math.degrees(math.atan(math.sinh(math.pi*(1-2*y/world))))

def viewport_data(a):
    west=a['left']/a['world']*360-180;east=(a['left']+a['size'])/a['world']*360-180
    north=latitude(a['top'],a['world']);south=latitude(a['top']+a['size'],a['world'])
    columns={x%36 for x in range(math.floor((west+180)/10),math.floor((east+180)/10)+1)}
    rows=range(max(0,math.floor((south+90)/10)),min(17,math.floor((north+90)/10))+1)
    lines={};labels=[]
    with zipfile.ZipFile(DATA) as z:
        names=set(z.namelist())
        for x in sorted(columns):
            for y in rows:
                name=f'{x}-{y}.json'
                if name not in names:continue
                info=z.getinfo(name)
                if info.file_size>2_000_000:raise ValueError('MAP_TILE_TOO_LARGE')
                data=json.loads(z.read(info))
                # Internal boundaries and physical water polygons come from
                # the shared-edge ground database. Keep only national lines.
                lines.update({r[0]:r for r in data['lines'] if r[1] in ('country','review_trace','review_river','review_maritime','review_region','review_ceasefire')})
                labels.extend(data['labels'])
    return list(lines.values()),labels

def project(lon,lat,a,size=640):
    x,y=xy(lon,lat,a['world']);center=a['left']+a['size']/2
    dx=(x-center+a['world']/2)%a['world']-a['world']/2
    return size/2+dx/a['size']*size,(y-a['top'])/a['size']*size

def label_layout(rows, a, size=640, focus_name='', *, show_boundary_captions=False):
    if not show_boundary_captions:
        rows=[r for r in rows if r['kind']!='review_caption']
    if 'members' in a:
        members=set(a['members'])
        # The Taiwan sheet includes the Fujian coast. Identify it at a visible,
        # coded mainland city without displacing a provincial administrative seat.
        mainland_coast = [dict(r, name='福建省莆田市', kind='coast_context') for r in rows
                          if r.get('code')=='350300'] if a.get('region_id')=='cn-71' else []
        rows=[r for r in rows if r['kind'] in ('water','review_caption') or
              (r.get('province') in members and (r['kind']!='province' or len(members)>1))] + mainland_coast
    measure = ImageDraw.Draw(Image.new('L',(1,1)))
    order = {'capital':0,'province':1,'island':2,'review_caption':3,'prefecture':4,'coast_context':5,'water':6,'city':7}
    fonts = {kind:ImageFont.truetype(font_path(kind in ('province','capital')),18 if kind=='province' else 14) for kind in order}
    focus_width = measure.textlength(focus_name[:12],font=fonts['province']) if focus_name else 65
    occupied = [(0,0,size,90),(0,490,size,size)]
    if focus_name:occupied.append((309,302,335+focus_width,335))
    counts = dict.fromkeys(order,0)
    limits={'water':2 if 'members' in a else 4,'city':12,'province':8}
    seen = {focus_name.removesuffix('市')}; chosen = []
    for row in sorted(rows,key=lambda r:(order[r['kind']],r['rank'],r['name'])):
        kind=row['kind']; text=row['name']; key=text.removesuffix('市')
        if key in seen or (kind in limits and counts[kind]>=limits[kind]) or len(text)>24:continue
        x,y=project(row['lon'],row['lat'],a,size)
        if not 6<x<size-6 or not 85<y<495:continue
        if kind=='prefecture' and len(text)>6:text=row.get('short') or text
        width=measure.textlength(text,font=fonts[kind])
        marked=kind in ('capital','prefecture','island','coast_context')
        positions=((7,-11),(-width-7,-11),(-width/2,-25),(-width/2,5),
                   (8,-34),(-width-8,-34),(8,17),(-width-8,17),(12,-48),(-width/2,32)) if marked else ((-width/2,-10),)
        if marked and len(a.get('members',()))==1:
            positions+=((-width-12,-48),(-width/2,-57),(-width/2,47),(32,-12),(-width-32,-12),
                        (30,28),(-width-30,28),(36,-35),(-width-36,-35))
        for dx,dy in positions:
            left,top=x+dx,y+dy
            box=(left-2,top-2,left+width+2,top+18)
            if box[0]<8 or box[2]>size-8 or box[1]<90 or box[3]>490:continue
            if any(box[0]<b[2] and box[2]>b[0] and box[1]<b[3] and box[3]>b[1] for b in occupied):continue
            chosen.append({**row,'text':text,'x':left,'y':top,'box':box,'anchor':(x,y) if marked else None})
            occupied.append(box);counts[kind]+=1;seen.add(key)
            break
    return chosen


def overlay(area, size, layer, focus_name):
    image, extra_labels = ground_layer(area,size,layer)
    draw=ImageDraw.Draw(image); lines,labels=viewport_data(area)
    kashmir=set()
    for _,kind,_,coords in lines:
        points=[project(lon,lat,area,size) for lon,lat in coords]
        if max(x for x,y in points)<-3 or min(x for x,y in points)>size+3 or max(y for x,y in points)<-3 or min(y for x,y in points)>size+3:continue
        if any(abs(x-x2)>size*3 for (x,y),(x2,y2) in zip(points,points[1:])):continue
        width=3
        if kind in ('review_maritime','review_ceasefire','review_region','review_river'):
            image.info['registered_boundary_ink']=True
        if kind=='review_ceasefire':
            x,y=points[0];radius=max(1,round(size/540))
            draw.ellipse((x-radius,y-radius,x+radius,y+radius),fill='#1f2630',outline='#d7dce0',width=1)
            kashmir.add(kind)
        elif kind=='review_region':
            draw.line(points,fill=(87,93,99,245),width=width)
            kashmir.add(kind)
        elif kind=='review_maritime':
            draw.line(points,fill=(31,37,44,245),width=width+1)
            draw.line(points,fill=(235,240,243,220),width=1)
        elif kind=='review_river':
            draw.line(points,fill='#66dce2',width=max(1,round(size/540)))
        elif kind=='review_trace':
            draw.line(points,fill=(206,149,229,225),width=width)
        else:
            draw.line(points,fill=(15,29,40,175),width=width+1)
            draw.line(points,fill=(243,248,250,170),width=1)
    labels=labels+extra_labels
    if 'region_id' in area:
        with focus_mask(area,size) as mask:
            with Image.new('RGBA',image.size,(15,25,32,0)) as tint:
                with mask.point([round(40*(1-v/255)) for v in range(256)]) as alpha:tint.putalpha(alpha)
                image.alpha_composite(tint)
    ratio=size/640
    fonts={kind:ImageFont.truetype(font_path(kind in ('province','capital')),round(ratio*(18 if kind=='province' else 14)))
           for kind in ('water','city','province','capital','prefecture','island','coast_context','review_caption')}
    layout=label_layout(labels,area,focus_name=focus_name,show_boundary_captions=bool(kashmir))
    for row in layout:
        if row['anchor'] is None:continue
        ax,ay=row['anchor'];left,top,right,bottom=row['box']
        endpoint=(min(max(ax,left),right),min(max(ay,top),bottom))
        if math.dist((ax,ay),endpoint)>11:
            draw.line((ax*ratio,ay*ratio,endpoint[0]*ratio,endpoint[1]*ratio),fill=(205,216,222,210),width=max(1,round(ratio)))
        x,y=ax*ratio,ay*ratio
        if row['kind']=='island':
            arm=4*ratio
            for stroke,ink in ((3,'#20343d'),(1,'#f5f8fa')):
                width=max(1,round(stroke*ratio))
                draw.line((x-arm,y,x+arm,y),fill=ink,width=width)
                draw.line((x,y-arm,x,y+arm),fill=ink,width=width)
            continue
        r=(3.6 if row['kind']=='capital' else 2.5)*ratio
        draw.ellipse((x-r,y-r,x+r,y+r),fill='#f5f8fa',outline='#20343d',width=max(1,round(ratio)))
        if row['kind']=='capital':draw.ellipse((x-r/2,y-r/2,x+r/2,y+r/2),fill='#20343d')
    for row in layout:
        ink=(194,239,252,255) if row['kind']=='water' else (255,255,255,245)
        draw.text((round(row['x']*ratio),round(row['y']*ratio)),row['text'],font=fonts[row['kind']],fill=ink,
                  stroke_width=max(1,round(ratio)),stroke_fill=(18,30,40,200))
    if kashmir:
        legend='   '.join(text for key,text in (('review_region','— — 地区界'),('review_ceasefire','··· 印巴停火线')) if key in kashmir)
        draw.text((size*.97,size*.098),legend,font=fonts['water'],anchor='ra',fill='white',
                  stroke_width=max(1,round(ratio)),stroke_fill='#263541')
        if 'review_ceasefire' in kashmir and sum('实际控制区' in r['text'] for r in layout)<2:
            draw.text((size*.97,size*.123),'两侧为巴基斯坦实际控制区、印度实际控制区',font=fonts['water'],
                      anchor='ra',fill='white',stroke_width=max(1,round(ratio)),stroke_fill='#263541')
    return image
