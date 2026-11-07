"""LangChain tools with identity, source-message and write consent bound by the host."""
from __future__ import annotations

import hashlib
import re
from typing import Annotated, Literal

from langchain_core.tools import tool
from pydantic import BaseModel,ConfigDict,Field
from rag_retriever import observation


class KnowledgeArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    query:Annotated[str,Field(min_length=1,max_length=1000)]
    domain:Literal['campus','weather','bot','outdoor']='campus'
    limit:Annotated[int,Field(ge=1,le=4)]=4
    outdoor_topic:Annotated[str,Field(min_length=2,max_length=24,description='仅户外查询可选：本条原文逐字出现的公开户外地点短名；资料缺失时登记受限搜索。不要传整段行程。')]|None=None


class RecallArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    query:Annotated[str,Field(min_length=1,max_length=1000)]
    project_key:Annotated[str,Field(min_length=1,max_length=80)]|None=None
    limit:Annotated[int,Field(ge=1,le=4)]=4


class SaveArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    project_key:Annotated[str,Field(min_length=1,max_length=80)]
    text:Annotated[str,Field(min_length=1,max_length=2000)]


class DeleteArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    project_key:Annotated[str,Field(min_length=1,max_length=80)]


_KEY=re.compile(r'[\w\u3400-\u9fff .-]{1,80}\Z')
_SECRET=re.compile(r'-----BEGIN|\b(?:sk-|gh[pousr]_|lsv2_pt_)[A-Za-z0-9_-]{12,}|Bearer\s+\S+|(?:密码|密钥|令牌|password|api[_ -]?key)\s*[:：=]',re.I)
_QUOTED=re.compile(r'[“”「」『』`"]|(?:他说|她说|有人说|例如|假设|如果|举例|转述)')


def explicit_note_request(source,project_key,text=None,*,delete=False):
    """Conservative first-version grammar: whole request must carry the operation.

    Example: 保存项目 天气助手：已经确认使用 ECMWF 数据。
    No inferred summaries or quoted/conditional instructions are accepted.
    """
    if not isinstance(source,str) or len(source)>4000 or not _KEY.fullmatch(project_key):
        return False
    source=source.strip()
    if _QUOTED.search(source) or _SECRET.search(source):
        return False
    if delete:
        pattern=r'(?:请)?(?:删除|忘记|忘掉)\s*(?:项目|项目摘要)\s*[：:]?\s*'+re.escape(project_key)+r'(?:\s*的(?:摘要|记录|笔记))?[。！!]?'
        return bool(re.fullmatch(pattern,source))
    if not isinstance(text,str) or text.strip()!=text or not text or len(text)>2000:
        return False
    pattern=r'(?:请)?(?:保存|记住|记录|更新)\s*(?:项目|项目摘要)\s*[：:]?\s*'+re.escape(project_key)+r'\s*[：:]\s*(.+)'
    match=re.fullmatch(pattern,source,re.S)
    return bool(match and match.group(1).strip()==text)


def build_rag_tools(retriever,*,namespace,source,source_ref,allow_shared=False,allow_write=False,research_queue=None,allow_research=False):
    def safely(action):
        try:
            return action()
        except Exception:
            return observation('unavailable',error_code='RAG_STORE_UNAVAILABLE',missing_fields=['supporting_evidence'])

    @tool('search_domain_knowledge',args_schema=KnowledgeArgs)
    def search_domain_knowledge(query:str,domain:str='campus',limit:int=4,outdoor_topic:str|None=None)->dict:
        """检索已授权的校园、气象解释、机器人项目及户外路线、景观、公告资料，返回来源和有效原文。公告不是实时开放结论；实时天气和空教室需使用对应查询工具。"""
        result=safely(lambda:retriever.search(query,namespace=namespace,domain=domain,include_shared=allow_shared,limit=limit))
        if domain=='outdoor' and outdoor_topic is not None and research_queue is not None and allow_research:
            from bounded_research import foreground_research,public_outdoor_topic,topic_matches
            topic=public_outdoor_topic(outdoor_topic,source)
            # Model similarity is not proof of a route match; only explicit
            # names in canonical text/title suppress the bounded fallback.
            if topic and not any(topic_matches(topic,item) for item in result.get('evidence',[])):
                fallback=foreground_research(research_queue,topic=topic,source=source,allow_public_search=True)
                fallback['timings']=result.get('timings',{})
                return fallback
        return result

    @tool('recall_project_notes',args_schema=RecallArgs)
    def recall_project_notes(query:str,project_key:str|None=None,limit:int=4)->dict:
        """查找当前会话对象明确保存的项目记录；只引用有效版本，有缺项如实说明。"""
        return safely(lambda:retriever.search(query,namespace=namespace,domain='project',project_key=project_key,limit=limit))

    @tool('save_project_note',args_schema=SaveArgs)
    def save_project_note(project_key:str,text:str)->dict:
        """仅保存当前用户本条明确要求保存的项目原文。格式：保存项目 项目名：摘要原文。"""
        if not allow_write or not explicit_note_request(source,project_key,text):
            return observation('denied',error_code='RAG_EXPLICIT_SAVE_REQUIRED')
        def save():
            doc_id=hashlib.sha256(('project\0'+namespace+'\0'+project_key).encode()).hexdigest()
            result=retriever.store.put_document(namespace=namespace,domain='project',title=project_key,
                text=text,source_ref=source_ref,doc_id=doc_id,visibility='private',project_key=project_key)
            return observation('ok',operation='save',doc_id=result['doc_id'],revision=result['revision'],changed=result['changed'])
        return safely(save)

    @tool('delete_project_note',args_schema=DeleteArgs)
    def delete_project_note(project_key:str)->dict:
        """仅在本条明确请求删除时删除当前对象的指定项目摘要。格式：删除项目 项目名。"""
        if not allow_write or not explicit_note_request(source,project_key,delete=True):
            return observation('denied',error_code='RAG_EXPLICIT_DELETE_REQUIRED')
        def delete():
            rows=retriever.store.find_project_documents(project_key,namespace=namespace)
            changed=sum(bool(retriever.store.delete_document(row['doc_id'],namespace=namespace)) for row in rows)
            return observation('ok',operation='delete',changed=changed)
        return safely(delete)

    return {tool.name:tool for tool in [search_domain_knowledge,recall_project_notes,save_project_note,delete_project_note]}
