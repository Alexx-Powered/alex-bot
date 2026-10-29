"""Compact deterministic classroom cards; no skill, network or QQ access."""
import uuid
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from campus_recommendations import timestamp, verified_explanation


def render_compact(report, private_root, explanation='', *,demo=False):
    if not report.get('ok') or not 1<=len(report.get('candidates',[]))<=12:
        raise ValueError('CAMPUS_RENDER_FAILED')
    image=Image.new('RGB',(1080,8000),'#f6f3ed');draw=ImageDraw.Draw(image)
    fonts={s:ImageFont.truetype('C:/Windows/Fonts/msyh.ttc',s) for s in (22,26,30,36,44)}
    bold=ImageFont.truetype('C:/Windows/Fonts/msyhbd.ttc',36)
    def text(value,x,y,width=960,size=26,fill='#40352b'):
        for paragraph in str(value).split('\n'):
            line=''
            for char in paragraph:
                if line and draw.textlength(line+char,font=fonts[size])>width:
                    draw.text((x,y),line,font=fonts[size],fill=fill);y+=size+10;line=''
                line+=char
            draw.text((x,y),line,font=fonts[size],fill=fill);y+=size+10
        return y
    draw.rectangle((0,0,1080,155),fill='#bd704c')
    text(report.get('building','三号楼')+' · 教室推荐',45,25,size=44,fill='white')
    text(report['date']+' / '+report['session']+' / 简略版'+(' / 示例数据' if demo else ''),45,97,size=26,fill='white')
    current=timestamp(report['now']);fetched=timestamp(report['fetched_at'])
    y=text(f'推荐时间 {current:%m-%d %H:%M}    数据采集 {fetched:%m-%d %H:%M}',45,180,size=22)
    y=text('按课表与当前时间推荐 · 空闲不保证到场有座',45,y,size=22,fill='#8b705d')+18
    for rank,item in enumerate(report['candidates'],1):
        start=y
        title=f"{rank}. {item.get('building','三号楼')} {item['room']}"+(' · 小教室' if item['small'] else '')
        count=1;line=''
        for char in title:
            if line and draw.textlength(line+char,font=fonts[30])>950:count+=1;line=''
            line+=char
        # Drawing the card before text keeps dynamic wrapped content within it.
        draw.rounded_rectangle((30,y,1050,y+125+count*40),radius=16,fill='white')
        color,pale=('#8f3b16','#edb17d') if item['tier']==1 else ('#a85b26','#fbe3ca')
        draw.rounded_rectangle((46,y+18,1034,y+57),radius=8,fill=pale)
        label=f"优先级 {item['tier']}"
        if item.get('just_released'):label+=' · 前节下课后空闲'
        if item.get('release_pending'):label+=' · 10分钟内下课，须等待'
        text(label,60,y+20,size=22,fill=color)
        y=text(title,60,y+68,width=950,size=30)
        state='现在可进入' if item['available_now'] else '需等到 '+item['usable_from']
        y=text(f"{item['usable_from']}—{item['usable_until']}  /  {state}"+(' / 局部空闲' if not item['complete_remaining'] else ''),60,y,size=26,fill=color)
        y=max(start+182,y+24)
    explanation=verified_explanation(report,explanation)
    if explanation:
        y=text('选择建议',45,y+10,size=30)
        y=text(explanation,45,y,size=26)+16
    y=text('来源：北航学院路空教室接口 · 基于所示采集时间的缓存',45,y+15,size=22,fill='#8b705d')
    y=text('亚历克斯 / 固定 Python 计算与绘图',45,y,size=22,fill='#8b705d')+25
    output=Path(private_root)/'campus-output';output.mkdir(parents=True,exist_ok=True)
    artifact=uuid.uuid4().hex
    target=output/(artifact+'.png');image.crop((0,0,1080,y)).save(target,optimize=True)
    if target.stat().st_size>1_500_000:target.unlink();raise ValueError('CAMPUS_RENDER_FAILED')
    return artifact
