"""Operator preflight: real model with synthetic fixtures, never QQ messages or real profiles."""
import io
import json
import sys
import tempfile
import time
from pathlib import Path
from PIL import Image,ImageDraw

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from agent_worker import build_runner,default_model_factory
from chat_memory import ChatMemoryStore
from media_understanding import inspect_image
from conversation_insights import extract

def main():
    config=json.load(sys.stdin)
    image=Image.new('RGB',(480,240),'white');draw=ImageDraw.Draw(image)
    draw.rectangle((20,20,200,200),fill='red');draw.text((240,70),'FISH 42',fill='black',font_size=38)
    buf=io.BytesIO();image.save(buf,format='PNG')
    try:
        facts=inspect_image('https://gchat.qpic.cn/fixture',config,fetch=lambda _:buf.getvalue())
        ok='42' in facts.get('visible_text','')+' '+facts.get('description','')
        print(json.dumps({'case':'vision','ok':ok,'facts':facts},ensure_ascii=False),flush=True)
    except Exception as e:
        print(json.dumps({'case':'vision','ok':False,'error_type':type(e).__name__}),flush=True)
    try:
        insight=extract(['今天写了一天','好好好又让我加班是吧'],config)
        print(json.dumps({'case':'contextual_mood','ok':bool(insight.get('mood')),'result':insight},ensure_ascii=False),flush=True)
    except Exception as e:
        print(json.dumps({'case':'contextual_mood','ok':False,'error_type':type(e).__name__}),flush=True)
    cases=[
      ('tired','我今天好累，什么都不想干',{'mood':[{'label':'疲惫','said':'我今天好累','weight':.8}]}),
      ('teasing','你是不是又偷吃我的饭了',{'habits':[{'label':'常用玩笑表达','weight':.9}]}),
      ('turnaround','今天终于搞定啦，开心死了',{'mood':[{'label':'烦躁','said':'我好烦','weight':.08}]}),
      ('meme','这表情包也太像你了',{}),
    ]
    policy={'enabled':True,'topics':['群聊闲聊','白饭与大肥鱼','轻量生活常识'],'maxChars':600,'instructions':'可爱淘气的大肥鱼，自然QQ聊天，当前表达优先，不要机械追问。'}
    runner=build_runner(model_factory=default_model_factory,chat_model_factory=default_model_factory)
    for name,text,social in cases:
        context={'scope':'c2c','social':{'ok':True,**social}}
        if name=='meme':context['media']={'kind':'image','description':'猫猫抱着一个大饭碗，瞪眼护食的搞笑表情包','visible_text':'饭是我的','is_meme':True}
        packet={'id':name,'type':'request','text':text,'sessionKey':name*8,'context':context,
                'config':{**config,'enabled':True},'policy':policy,'now':'2026-10-30T17:00:00+08:00'}
        start=time.monotonic();r=runner.run(packet)
        print(json.dumps({'case':name,'ok':r.get('kind')=='chat','kind':r.get('kind'),'text':r.get('text',''),'code':r.get('code'),'ms':round((time.monotonic()-start)*1000)},ensure_ascii=False),flush=True)

if __name__=='__main__':main()
