"""Resolve report scope independently of fresh/cached data acquisition."""
import re
from datetime import datetime,timedelta,timezone
from typing import Annotated,Literal
from pydantic import BaseModel,ConfigDict,Field
from langchain.tools import tool

class IntentArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    text: Annotated[str,Field(max_length=320)]=''
    requested: Literal['auto','full','compact']='auto'
    origin: Literal['query','recommend']='query'

def resolve_intent(text='',requested='auto',origin='query'):
    if re.search(r'全天|全日|整天|一整天|完整.{0,5}(?:报告|简报|课表|情况)|所有课节|全部课节',text):
        return dict(view='full',session='now')
    session=next((value for words,value in [('上午|早上','morning'),('下午','afternoon'),('晚上|晚间|今晚','evening')] if re.search(words,text)),'now')
    if session!='now' or re.search(r'去哪|去哪个|哪间.{0,6}自习|找.{0,4}教室|换.{0,4}教室|马上|此刻|眼下|(?:现在|当前|目前).{0,12}(?:自习|可用|能去|空闲)',text):
        return dict(view='compact',session=session)
    day=re.search(r'今天|今日|明天|后天|\d{4}-\d{2}-\d{2}',text)
    if not day and re.search(r'现在|当前|目前',text):return dict(view='compact',session='now')
    if re.search(r'情况|总览|概览|一览|课表',text) or (day and '推荐' not in text):
        return dict(view='full',session='now')
    if re.search(r'推荐|现在|当前|目前|接下来',text):return dict(view='compact',session='now')
    return dict(view=requested if requested!='auto' else 'compact' if origin=='recommend' else 'full',session=session)

@tool(args_schema=IntentArgs,return_direct=True)
def classroom_report_intent(text: str='',requested: str='auto',origin: str='query')->dict:
    """区分全天课表总览与当前/指定时段推荐；不读取凭据、数据或调用模型。"""
    return resolve_intent(text,requested,origin)

class RecognitionArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    text: Annotated[str,Field(max_length=320)]

@tool(args_schema=RecognitionArgs,return_direct=True)
def recognized_classroom_request(text: str)->bool:
    """仅识别明确校园教室查询作为模型忽略后的受限兜底，不执行查询。"""
    if re.search(r'什么意思|怎么说|翻译|英文|原理|代码|爬虫|程序|实现',text):return False
    if re.search(r'空教室|教室.{0,6}(?:空闲|可用|情况|课表)|(?:推荐|换).{0,6}教室|哪.{0,8}教室.{0,6}自习',text):return True
    return bool(re.search(r'三号楼|3号楼|主楼|主M|主北|主南',text,re.I) and re.search(r'查|看|情况|空闲|推荐|去哪|自习|课表|概览|一览|报告|哪些|可用',text))

def recovery_date(text,now):
    """Recover only unambiguous supported dates; never replace a future date with today."""
    today=datetime.fromisoformat(now).astimezone(timezone(timedelta(hours=8))).date()
    explicit=re.findall(r'\d{4}-\d{2}-\d{2}',text)
    if explicit:return explicit[0] if len(set(explicit))==1 else None
    if re.search(r'周|星期|礼拜|\d+月|\d+[日号]|昨天|前天|大后天',text):return None
    offsets=[offset for word,offset in [('今天',0),('今日',0),('今晚',0),('明天',1),('后天',2)] if word in text]
    if len(set(offsets))>1:return None
    return (today+timedelta(days=offsets[0] if offsets else 0)).isoformat()

class RecoveryArgs(RecognitionArgs):
    now: Annotated[str,Field(max_length=40)]

@tool(args_schema=RecoveryArgs,return_direct=True)
def recover_classroom_request(text: str,now: str)->dict:
    """模型忽略时只恢复明确的校园查询和无歧义日期，不获取校园数据。"""
    day=recovery_date(text,now)
    return {'recognized':day is not None and recognized_classroom_request.invoke({'text':text}),'date':day}
