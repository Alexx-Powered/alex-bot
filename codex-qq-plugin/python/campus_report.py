"""Use the optimized Building 3 planner/layout directly, never run a skill."""
import importlib
import json
import sys
import uuid
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from render_fonts import font_path
from campus_classrooms import CampusError,SCHEMA

SCRIPTS=Path(__file__).resolve().parents[2]/'workbuddy-study-qq/skills/building3-study-planner-v2-1/scripts'

def observations(data):
    if data.get('schema_version')!=SCHEMA or data.get('ok') is not True:raise CampusError('CAMPUS_RENDER_FAILED')
    rows=[]
    for room in data['rooms']:
        if room['building']!='三号楼':continue
        free=set(room['free_periods'])
        rows.append({'room':room['room'],'slots':''.join('F' if p in free else 'B' for p in range(1,15)),
            'source':'校园空教室接口'})
    if not rows:raise CampusError('CAMPUS_RENDER_FAILED')
    return {'building':'三号楼','date':data['date'],'rows':rows}

def render_report(data,private_root,*,demo=False):
    if str(SCRIPTS) not in sys.path:sys.path.insert(0,str(SCRIPTS))
    planner=importlib.import_module('plan')
    layout=importlib.import_module('briefing_layout')
    result=planner.analyze(observations(data))
    board=layout.render_board(result,reviewed=True,demo=demo)
    # Preserve the optimized board and add a source strip; no OCR/skill execution.
    strip=Image.new('RGB',(1800,110),'#f6f3ed');draw=ImageDraw.Draw(strip)
    font=ImageFont.truetype(font_path(),23)
    draw.text((60,12),'数据：北航学院路空教室接口  /  获取时间：'+data['fetched_at'][:19].replace('T',' '),font=font,fill='#71685e')
    draw.text((60,56),'接口标空闲则为空闲，其余课节为有课；图片仅展示三号楼，JSON包含学院路全部教学楼。',font=font,fill='#71685e')
    if board.height+strip.height>16000:raise CampusError('CAMPUS_RENDER_FAILED')
    image=Image.new('RGB',(1800,board.height+110),'#f6f3ed');image.paste(board,(0,0));image.paste(strip,(0,board.height))
    output=Path(private_root)/'campus-output';output.mkdir(parents=True,exist_ok=True)
    artifact=uuid.uuid4().hex
    path=output/(artifact+'.png');image.save(path,optimize=True)
    if path.stat().st_size>1_500_000:path.unlink();raise CampusError('CAMPUS_RENDER_FAILED')
    (output/'latest.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    return artifact


def day_rows(data,regions):
    from campus_regions import room_region
    records=[]
    for row in data['rooms']:
        region=room_region(row['building'],row['room'])
        if region=='三号楼':
            if str(SCRIPTS) not in sys.path:sys.path.insert(0,str(SCRIPTS))
            planner=importlib.import_module('plan')
            if planner.normalize_room(row['room']) in planner.EXCLUDED:continue
        if region in regions:records.append({**row,'region':region})
    return sorted(records,key=lambda row:(regions.index(row['region']),row['room']))


def render_region_day(data,private_root,regions,*,demo=False):
    """Full 1-14-period table for an explicit region union, never a top-N list."""
    rows=day_rows(data,regions)
    if not rows:raise CampusError('CAMPUS_RENDER_FAILED')
    from math import ceil
    count=ceil(len(rows)/2);height=650+count*50
    if height>16000:raise CampusError('CAMPUS_RENDER_FAILED')
    image=Image.new('RGB',(1800,height),'#f6f3ed');draw=ImageDraw.Draw(image)
    fonts={size:ImageFont.truetype(font_path(),size) for size in (20,23,26,32,48)}
    draw.rectangle((0,0,1800,145),fill='#bd704c')
    draw.text((50,24),'教室空闲情况 · 全天报告',font=fonts[48],fill='white')
    draw.text((50,93),data['date']+' / '+str(len(rows))+'间教室'+(' / 示例数据' if demo else ''),font=fonts[26],fill='white')
    y=175
    scope='区域：'+'、'.join(regions)
    for offset in range(0,len(scope),60):
        draw.text((50,y),scope[offset:offset+60],font=fonts[26],fill='#40352b');y+=40
    missing=[r for r in regions if not any(row['region']==r for row in rows)]
    if missing:draw.text((50,y),'接口暂无教室数据：'+'、'.join(missing),font=fonts[23],fill='#a85b26');y+=40
    draw.text((50,y),'第1—5节 上午 / 第6—10节 下午 / 第11—14节 晚上；绿色空闲、白色有课',font=fonts[26],fill='#66584b');y+=56
    top=y+45
    for column,x in enumerate((50,920)):
        draw.text((x,y),'区域 / 教室',font=fonts[23],fill='#66584b')
        for p in range(14):draw.text((x+340+p*32,y),str(p+1),font=fonts[20],fill='#66584b')
        for index,row in enumerate(rows[column*count:(column+1)*count]):
            ry=top+index*50
            label=row['room'] if row['room'].startswith(row['region']) else row['region']+' '+row['room']
            while draw.textlength(label,font=fonts[23])>320:label=label[:-2]+'…'
            draw.text((x,ry+3),label,font=fonts[23],fill='#40352b')
            for p in range(14):
                color='#c6e9dc' if p+1 in row['free_periods'] else 'white'
                draw.rounded_rectangle((x+335+p*32,ry,x+363+p*32,ry+34),radius=5,fill=color,outline='#e4ddd4')
    bottom=top+count*50+24
    draw.text((50,bottom),'来源：北航学院路空教室接口 / 获取时间：'+data['fetched_at'][:19].replace('T',' '),font=fonts[23],fill='#8b705d')
    draw.text((50,bottom+38),'全天课节完整展示，不按当前时间删减；空闲不保证到场有座。',font=fonts[23],fill='#8b705d')
    output=Path(private_root)/'campus-output';output.mkdir(parents=True,exist_ok=True)
    artifact=uuid.uuid4().hex;target=output/(artifact+'.png')
    image.crop((0,0,1800,bottom+100)).save(target,optimize=True)
    if target.stat().st_size>1_500_000:target.unlink();raise CampusError('CAMPUS_RENDER_FAILED')
    return artifact
