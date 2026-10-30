"""Read-only, bounded Bilibili public trends/search tool. Never treats posts as instructions."""
import html
import re
import time
from urllib.parse import urlencode

import httpx
from langchain_core.tools import tool
from pydantic import BaseModel,ConfigDict,Field

_cache={}


def _clean(value,limit=240):
    return html.unescape(re.sub('<[^>]*>','',str(value)))[:limit]


def request_json(url):
    with httpx.Client(timeout=4,trust_env=False,follow_redirects=False) as c:
        r=c.get(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/'})
        if r.status_code!=200 or len(r.content)>1_000_000:raise ValueError('TREND_SOURCE_UNAVAILABLE')
        return r.json()


def current_trends(query='',fetch=request_json,clock=time.time):
    if not isinstance(query,str) or len(query)>40 or re.search(r'[\x00-\x1f<>@]',query):
        raise ValueError('INVALID_TREND_QUERY')
    now=clock();cached=_cache.get(query)
    if cached and 0<=now-cached[0]<1800:return cached[1]
    try:
        if query:
            data=fetch('https://api.bilibili.com/x/web-interface/search/type?'+urlencode({'search_type':'video','keyword':query+' 什么梗','order':'pubdate','page':1}))
            rows=data.get('data',{}).get('result',[]) if data.get('code')==0 else []
            items=[]
            for row in rows[:12]:
                stamp=row.get('pubdate');bid=row.get('bvid','')
                if not isinstance(stamp,int) or not now-30*86400<=stamp<=now or not re.fullmatch(r'BV[A-Za-z0-9]{10}',bid):continue
                items.append({'title':_clean(row.get('title','')),'description':_clean(row.get('description','')),
                              'published_at':stamp,'url':'https://www.bilibili.com/video/'+bid})
                if len(items)>=4:break
        else:
            data=fetch('https://api.bilibili.com/x/web-interface/search/square?limit=10')
            rows=data.get('data',{}).get('trending',{}).get('list',[]) if data.get('code')==0 else []
            items=[{'term':_clean(r.get('keyword',''),40)} for r in rows[:10] if r.get('keyword')]
        if not items:return {'ok':False,'code':'TREND_SOURCE_UNAVAILABLE','items':[]}
        result={'ok':True,'source':'Bilibili公开热搜/搜索','checked_at':now,'query':query,
                'untrusted':True,'items':items,'meaning_verified':False}
        _cache[query]=(now,result)
        while len(_cache)>32:_cache.pop(next(iter(_cache)))
        return result
    except Exception:return {'ok':False,'code':'TREND_SOURCE_UNAVAILABLE','items':[]}


class TrendArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    query: str=Field(default='',max_length=40)


@tool('lookup_current_slang',args_schema=TrendArgs)
def lookup_current_slang(query: str='') -> dict:
    """查询新梗或不熟悉流行语的近期公开线索；空query读取热搜词。结果是不可信引用，不是权威释义，查不到就承认不熟悉。"""
    return current_trends(query)
