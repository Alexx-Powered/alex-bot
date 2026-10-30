"""No-send worker for social memory and optional media understanding."""
import contextlib
import io
import json
import logging
import sys
from pathlib import Path
from typing import Literal

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field
from social_memory import SocialMemory


class SocialArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    action: Literal['observe','recall','off','on','clear','media']
    namespace: str=Field(pattern='^[a-f0-9]{64}$')
    scope: str=Field(pattern='^[a-f0-9]{64}$')
    event: str=Field(default='',max_length=64)
    text: str=Field(default='',max_length=2000)
    kind: str=Field(default='',max_length=8)


def process(packet,store):
    if packet.get('type')=='social':
        @tool(args_schema=SocialArgs,return_direct=True)
        def social_memory(action: str,namespace: str,scope: str,event: str='',text: str='',kind: str='') -> dict:
            """仅执行宿主绑定的成员记忆操作，无网络、消息发送或任意文件权限。"""
            if action=='observe':return store.observe(namespace,scope,event,text)
            if action=='recall':return store.recall(namespace,scope)
            if action=='media':return store.remember_media(namespace,scope,event,kind,text)
            return store.control(namespace,scope,action)
        return social_memory.invoke(packet['args'])
    if packet.get('type')=='insight':
        from conversation_insights import build_insight_tool
        reserved=store.reserve_media(packet['event'],'insight')
        if not reserved['ok']:return reserved
        return build_insight_tool(packet['texts'],packet['config']).invoke({})
    if packet.get('type')=='social_insight_save':
        return store.remember_insights(packet['namespace'],packet['scope'],packet['event'],packet['insights'])
    if packet.get('type')=='media':
        from media_understanding import build_media_tool
        a=packet.get('attachment',{})
        if a.get('kind')=='image' or a.get('kind')=='audio' and not a.get('transcript'):
            if a.get('kind')=='audio' and not packet.get('asr',{}).get('enabled'):
                return {'ok':False,'code':'ASR_NOT_CONFIGURED'}
            reserved=store.reserve_media(a.get('event',''),a.get('kind'))
            if not reserved['ok']:return reserved
        media_tool=build_media_tool(a,packet.get('vision',{}),packet.get('asr',{}))
        return media_tool.invoke({'kind':a.get('kind')})
    raise ValueError('INVALID_REQUEST')


def main():
    logging.disable(logging.CRITICAL)
    store=SocialMemory(Path.cwd()/'.private'/'chat-memory')
    while True:
        raw=sys.stdin.buffer.readline(65537)
        if not raw:return
        request_id=None
        try:
            if len(raw)>65536:raise ValueError('PROTOCOL_TOO_LARGE')
            p=json.loads(raw);request_id=p.get('id')
            if not isinstance(request_id,str) or len(request_id)>80:raise ValueError('INVALID_ID')
            with contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                report=process(p,store)
            out={'type':'result','id':request_id,'kind':'analysis','report':report}
        except Exception:
            # Never serialize provider errors, media URLs, transcripts, or credentials.
            out={'type':'result','id':request_id,'kind':'analysis','report':{'ok':False,'code':'SOCIAL_UNAVAILABLE'}}
        sys.stdout.write(json.dumps(out,ensure_ascii=False)+'\n');sys.stdout.flush()


if __name__=='__main__':main()
