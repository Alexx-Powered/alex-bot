"""Owner-only QQ delivery as a directly invoked LangChain tool; no model call."""
import argparse
import base64
import hashlib
import json
import re
import secrets
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler
from datetime import date, datetime, timedelta, timezone
from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

BOT_HOME=Path('D:/Projects/Alex Bot/codex-qq-plugin')
ORIGIN='http://127.0.0.1:19327'
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def request(route, token, body=None):
    raw=None if body is None else json.dumps(body,separators=(',',':')).encode()
    req=Request(ORIGIN+route,data=raw,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with build_opener(ProxyHandler({}),NoRedirect()).open(req,timeout=35) as response:
        data=response.read(65537)
    if len(data)>65536: raise ValueError('INVALID_RESPONSE')
    return json.loads(data)

def send(manifest_path, *, transport=request, bot_home=BOT_HOME):
    manifest_path=Path(manifest_path).resolve()
    if manifest_path.stat().st_size>8192: return {'ok':False,'code':'INVALID_MANIFEST'}
    m=json.loads(manifest_path.read_text(encoding='utf-8'))
    if m.get('version')!='study-briefing-v1' or m.get('reviewed') is not True or m.get('image')!='study-briefing.png':
        return {'ok':False,'code':'REVIEW_REQUIRED'}
    try:
        day=date.fromisoformat(m['date'])
        if day.isoformat()!=m['date']:raise ValueError()
        generated=datetime.fromisoformat(m['generatedAt'])
        age=datetime.now(timezone.utc)-generated
        if age<timedelta(minutes=-5) or age>timedelta(hours=2):return {'ok':False,'code':'PREVIEW_EXPIRED'}
    except (KeyError,ValueError,TypeError):return {'ok':False,'code':'QUERY_DATE_REQUIRED'}
    key=m.get('idempotencyKey','')
    if not re.fullmatch(r'study:[0-9a-f]{64}',key):return {'ok':False,'code':'INVALID_MANIFEST'}
    image_path=manifest_path.parent/'study-briefing.png'
    if image_path.stat().st_size>1_500_000:return {'ok':False,'code':'IMAGE_TOO_LARGE'}
    image=image_path.read_bytes()
    if not image.startswith(b'\x89PNG\r\n\x1a\n') or hashlib.sha256(image).hexdigest()!=m.get('sha256'):
        return {'ok':False,'code':'IMAGE_CHANGED'}
    token=(bot_home/'.private/admin-token').read_text().strip()
    if not re.fullmatch('[0-9a-f]{64}',token):return {'ok':False,'code':'INVALID_LOCAL_AUTH'}
    status=transport('/api/status',token)
    if not status.get('ok') or not status.get('configured') or not status.get('core',{}).get('paired'):
        return {'ok':False,'code':'NOT_READY'}
    if status['core'].get('paused'):return {'ok':False,'code':'PAUSED'}
    if status.get('transport',{}).get('state')!='connected':return {'ok':False,'code':'NOT_CONNECTED'}
    core=status['core'];limits=core.get('limits',{})
    if core.get('remainingDailyAttempts')==0 or core.get('minuteAttempts',0)>=limits.get('minuteAttempts',15):
        return {'ok':False,'code':'LOCAL_QUOTA_EXHAUSTED'}
    # Each explicit invocation is a new send, even for the same manifest/image.
    # The bridge key identifies this one HTTP operation, never the report content.
    key='study:'+secrets.token_hex(32)
    journal=manifest_path.parent/'.qq-delivery'
    journal.mkdir(exist_ok=True)
    claim=journal/(key[6:]+'.json')
    try:
        with claim.open('x',encoding='utf-8') as f:
            json.dump({'state':'attempted','idempotencyKey':key},f)
    except FileExistsError:return {'ok':False,'code':'REQUEST_ID_COLLISION'}
    try:
        response=transport('/api/study-briefing',token,{'idempotencyKey':key,'pngBase64':base64.b64encode(image).decode()})
        code=response.get('code','UNKNOWN')
        result={'ok':response.get('ok') is True,'code':code if isinstance(code,str) and re.fullmatch('[A-Z_]{2,60}',code) else 'UNKNOWN'}
    except Exception:result={'ok':False,'code':'DELIVERY_UNKNOWN'}
    try:claim.write_text(json.dumps(result),encoding='utf-8')
    except OSError:pass # Server retains the per-operation receipt too.
    return result

class SendArgs(BaseModel):
    model_config=ConfigDict(extra='forbid')
    manifest_path:str=Field(min_length=1,max_length=1024,description='本次核对后生成的 briefing-manifest.json 绝对路径')

@tool(args_schema=SendArgs)
def send_study_briefing(manifest_path:str)->dict:
    """将本次核对后的自习简报发给唯一已配对本人；不指定收件人，不调用大模型，不重试发送。"""
    try:return send(manifest_path)
    except Exception:return {'ok':False,'code':'LOCAL_BRIEFING_UNAVAILABLE'}

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('manifest',type=Path);args=p.parse_args()
    result=send_study_briefing.invoke({'manifest_path':str(args.manifest.resolve())})
    print(json.dumps(result,ensure_ascii=False));raise SystemExit(0 if result['ok'] else 1)
