"""Two-column classroom board. All observed rooms and five real plans per session."""
from datetime import date
from pathlib import Path
import re
import os
from PIL import Image, ImageDraw, ImageFont
import plan

def render_board(result, reviewed, demo):
    font=Path(os.environ.get('QQ_FONT_REGULAR') or ('C:/Windows/Fonts/msyh.ttc' if os.name=='nt' else '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'))
    if not font.exists():raise ValueError('CHINESE_FONT_MISSING')
    fonts={n:ImageFont.truetype(str(font),n) for n in (21,23,25,27,30,34,42,62,150)}
    bold_path=os.environ.get('QQ_FONT_BOLD') or ('C:/Windows/Fonts/msyhbd.ttc' if os.name=='nt' else '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc')
    bold={n:ImageFont.truetype(bold_path,n) for n in fonts}
    bg='#f6f3ed';ink='#302d29';muted='#71685e'
    im=Image.new('RGB',(1800,16000),bg);d=ImageDraw.Draw(im)
    def text(s,x,y,width=900,size=25,color=ink,strong=False):
        face=bold[size] if strong else fonts[size]
        for para in str(s).split('\n'):
            line=''
            for c in re.findall(r'[A-Za-z0-9:—.\-]+|.',para):
                if line and d.textlength(line+c,font=face)>width:
                    d.text((x,y),line,font=face,fill=color);y+=size+12;line=''
                line+=c
            d.text((x,y),line,font=face,fill=color);y+=size+12
        if y>15700:raise ValueError('BRIEFING_TOO_LONG')
        return y
    def card_finish(x,top,width,bottom):
        content=im.crop((x,top,x+width,bottom))
        mask=Image.new('L',content.size,0)
        ImageDraw.Draw(mask).rounded_rectangle((0,0,width-1,bottom-top-1),radius=24,fill=255)
        d.rectangle((x,top,x+width,15999),fill=bg)
        im.paste(content,(x,top),mask)

    d.rectangle((0,0,1800,220),fill='#c46f4e')
    d.rectangle((58,47,67,170),fill='#e7b99e')
    text('三号楼自习指南',92,46,size=62,color='white',strong=True)
    text('完整空闲表与分时段选房建议',97,134,size=27,color='#f4e7df')
    day=result['date']
    text(day if day else '日期待确认',1370,70,size=34,color='white',strong=True)
    text(('星期'+'一二三四五六日'[date.fromisoformat(day).weekday()]) if day else '暂不发送',1370,125,size=27,color='#f4e7df')
    y=245
    unknown=sum(s.count('?') for s in result['rooms'].values())
    y=text(f"{len(result['rooms'])} 间纳入规划    /    {unknown} 节待确认    /    优先小教室",60,y,size=25)
    if demo:y=text('模拟预览',60,y,size=23,color='#a15e32')
    if not reviewed:y=text('待核对预览 · 尚未发送',60,y,size=23,color='#a15e32')
    y+=30;top=y
    # Left column: every included room, all 14 periods, never a recommendation-only subset.
    lx=40;lw=682;ly=top
    d.rectangle((lx,ly,lx+lw,15999),fill='white')
    ly=text('教室空闲信息',lx+28,ly+25,width=626,size=34,strong=True)
    ly=text('每格一节课 · 直接看连续空闲区间',lx+28,ly+5,width=626,size=23,color=muted)
    ly+=12
    for j,(label,fill,fg) in enumerate([('空闲','#c8eadb','#14654e'),('有课','#ffffff','#80796f'),('待确认','#f8e7af','#805e13')]):
        xx=lx+28+j*202
        d.rounded_rectangle((xx,ly,xx+26,ly+26),radius=6,fill=fill,outline='#ddd8d0' if label=='有课' else fill)
        text(label,xx+36,ly-3,width=150,size=21,color=fg)
    ly+=48
    def tile_x(n):
        return lx+113+(n-1)*35+(12 if n>5 else 0)+(12 if n>10 else 0)
    for n,label in [(1,'上午 1—5'),(6,'下午 6—10'),(11,'晚上 11—14')]:
        text(label,tile_x(n),ly,width=180,size=21,strong=True)
    ly+=34
    for n,span in [(1,'08:00—12:15'),(6,'14:00—18:15'),(11,'19:00 起')]:
        text(span,tile_x(n),ly,width=180,size=21,color=muted)
    ly+=35
    ly=text('晚间常用起点：第12节 19:50',lx+113,ly,width=530,size=21,color='#9c5235')
    ly+=14
    last_group=None
    for room in sorted(result['rooms'],key=lambda r:(r not in plan.SMALL,int(r))):
        group='小教室优先' if room in plan.SMALL else '其他教室'
        if group!=last_group:
            d.rectangle((lx+20,ly,lx+lw-20,ly+38),fill='#f3eee6')
            d.text((lx+27,ly+3),group,font=bold[21],fill=muted)
            ly+=50;last_group=group
        d.text((lx+27,ly+5),room,font=bold[27],fill=ink)
        for n,state in enumerate(result['rooms'][room],1):
            fill,fg={'F':('#c8eadb','#14654e'),'B':('#ffffff','#80796f'),'?':('#f8e7af','#805e13')}[state]
            xx=tile_x(n)
            d.rounded_rectangle((xx,ly,xx+30,ly+55),radius=6,fill=fill,outline='#ddd8d0' if state=='B' else fill)
            value='?' if state=='?' else str(n)
            face=bold[21] if state=='F' else fonts[21]
            d.text((xx+(30-d.textlength(value,font=face))/2,ly+13),value,font=face,fill=fg)
        ly+=78
    ly+=18
    ly=text('已按规则排除：204、205、211、213、303、304、310、311。',lx+28,ly,width=626,size=23,color=muted)
    if result['missing_small_rooms']:
        ly=text('本次未提供的小教室：'+ '、'.join(result['missing_small_rooms'])+'。不补造状态。',lx+28,ly+10,width=626,size=23,color=muted)
    if result['conflicts']:
        ly=text('重叠截图存在冲突，相关格保留待确认，不按空闲推荐。',lx+28,ly+10,width=626,size=23,color='#a15e32')
    ly+=25;card_finish(lx,top,lw,ly)

    # Compact lesson-time reference below the complete table.
    ref_top=ly+25;ly=ref_top
    d.rectangle((lx,ly,lx+lw,15999),fill='white')
    ly=text('课节时间速查',lx+28,ly+24,width=626,size=30,strong=True)
    for i in range(7):
        for col,n in enumerate((i+1,i+8)):
            start,end=plan.RULES['periods'][n-1]
            text(f'{n:02d}   {start}—{end}',lx+28+col*325,ly,width=310,size=23,color=muted)
        ly+=38
    ly+=18
    ly=text('晚间习惯：19:50 起\n同等级优先整晚空闲。',lx+28,ly,width=626,size=23)
    ly+=23;card_finish(lx,ref_top,lw,ly)

    # Right column: full original recommendations and explanations, up to five per session.
    rx=750;rw=1010;ry=top
    for idx,(label,session) in enumerate(result['sessions'].items()):
        accent=ink
        ct=ry;d.rectangle((rx,ry,rx+rw,15999),fill='white')
        ry+=24
        d.rectangle((rx+26,ry,rx+32,ry+46),fill=accent)
        d.text((rx+50,ry),label+'建议',font=bold[34],fill=accent)
        d.text((rx+570,ry+8),['第1—5节 / 08:00—12:15','第6—10节 / 14:00—18:15','常用第12—14节 / 19:50起'][idx],font=fonts[23],fill=muted)
        ry+=60
        legend = '下午：小教室第5节有课且整段空闲为1级，其余小教室、普通教室、换房、局部依次顺延' if label=='下午' else '小教室整段空闲为1级，普通教室2级；换房3级、局部4级，不看前节是否有课'
        ry+=18
        if not session['recommendations']:ry=text('没有已确认可行的方案。',rx+28,ry,width=950,size=27)
        for rank,item in enumerate(session['recommendations'][:5],1):
            level=plan.recommendation_tier(item,result['rooms'])
            accent,pale=[('#8f3b16','#edb17d'),('#a85b26','#fbe3ca'),('#98734e','#f6ecdf'),('#8a7864','#f3eee7'),('#847a71','#f4f1ee')][level-1]
            labels = ['小教室第5节有课 / 下午整段空闲','小教室整段空闲','普通教室整段空闲','换房衔接','局部可用'] if label=='下午' else ['小教室连续空闲','普通教室连续空闲','换房衔接','局部可用']
            tier=f'{level}级 · {labels[level-1]}'
            item_top=ry
            ry+=16
            d.rounded_rectangle((rx+27,ry,rx+rw-27,ry+40),radius=8,fill=pale)
            text(tier,rx+40,ry+3,width=850,size=21,color=accent,strong=True)
            ry+=55
            if item['kind']=='route':
                title=' → '.join(s['room'] for s in item['segments'])+' · 换房'
            else:
                title=item['room']+(' · 小教室' if item['room'] in plan.SMALL else ' · 普通教室')
            if item['kind']=='partial':title+=' · 短时可用'
            d.rounded_rectangle((rx+27,ry+2,rx+67,ry+41),radius=10,fill=pale)
            d.text((rx+38,ry+2),str(rank),font=fonts[25],fill=accent)
            ry=text(title,rx+86,ry,width=895,size=30,color=ink,strong=True)
            ry=text(plan.render_route(item) if item['kind']=='route' else plan.window_text(item['start'],item['end']),rx+28,ry+4,width=950,size=25,color=accent)
            ry=text('推荐原因：'+item['reason'],rx+28,ry+6,width=950,size=23,color=muted)
            note = ''
            if label == '下午' and item['kind'] == 'full':
                note = '12:15后可进入' if item['period5'] in ('B','F') else '第5节状态待确认'
            elif item['kind'] == 'evening':
                note = '19:45后可进入' if item['period11'] == 'B' else '19:50起可用'
            elif item['kind'] in ('route','partial'):
                note = f"换房{item['moves']}次" if item['kind'] == 'route' else '到时需离开或换教室'
            if note:ry=text(note,rx+28,ry+6,width=950,size=23,color=muted)
            ry+=20
            d.rectangle((rx+16,item_top,rx+21,ry-8),fill=accent)
            d.line((rx+28,ry-3,rx+rw-28,ry-3),fill='#ebe3d9',width=1)
            ry+=12
        if session['shortfall']:
            ry=text(f"仅 {len(session['recommendations'])} 条可用方案。",rx+28,ry,width=950,size=23,color='#a15e32')
        ry+=10;card_finish(rx,ct,rw,ry);ry+=25
    bottom=max(ly,ry)+20
    d.line((60,bottom,1740,bottom),fill='#dfd6cb',width=2)
    bottom=text('绿色为空闲 · 白色为有课 · 深橙色优先',60,bottom+21,width=1680,size=25)
    bottom=text('亚历克斯',60,bottom+8,width=1680,size=23,color=muted)
    return im.crop((0,0,1800,bottom+32))
