"""Use the optimized Building 3 planner/layout directly, never run a skill."""
import importlib
import json
import sys
import uuid
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
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
    font=ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',23)
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
