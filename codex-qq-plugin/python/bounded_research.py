"""Offline-first research prototype: no LLM loops, no QQ, no Milvus owner.

Host tools only enqueue. A separately scheduled supervisor calls run_next;
network work lives in a killable child. Promotion is operator-only.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import unicodedata

HARD_SECONDS = 20
MAX_HITS = 6
MAX_PAGES = 3
_INJECTION = re.compile(r'ignore\s+(?:all\s+)?(?:previous|system)\s+instructions|忽略.{0,8}(?:指令|提示)|泄露.{0,8}(?:密钥|令牌)|-----BEGIN|Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}', re.I)


def _normalized(text):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', text)).casefold()


def _plain(text):
    return ''.join(c for c in text if not unicodedata.category(c).startswith('C') or c in '\n\r\t')


def _published(value):
    if not isinstance(value,str) or len(value)>64:return None
    value=value.strip().replace('/','-')
    match=re.match(r'^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$',value)
    if not match:return None
    try:
        value=f'{int(match[1]):04}-{int(match[2]):02}-{int(match[3]):02}'+match[4]
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        result=parsed.date().isoformat() if not match[4] else parsed.isoformat()
        return result if len(result)<=40 else None
    except ValueError:return None


def research_queries(topic):
    # Space-separated family/slope terms improve discovery without claiming an
    # alias, coordinates, or a shared access policy. Only two predetermined calls.
    terms=_topic_terms(topic)
    # An explicit official-site query avoids spending the complete small page
    # budget on commercial travel listings. This remains exactly two calls.
    return (f'{" ".join(terms)} 徒步 site:gov.cn',f'{topic} 徒步 攻略 D1 D2 逐日行程 营地 住宿')


def _topic_terms(topic):
    if topic.endswith(('西坡','东坡','南坡','北坡')) and len(topic)>=4:
        return [topic[:-2],topic[-2:]]
    # These are descriptive route suffixes, not inferred place aliases. Require
    # the named entity and the route kind together in each admitted paragraph.
    for suffix,kind in [('国家登山健身步道','步道'),('环湖步道','环湖'),('国家登山步道','步道')]:
        if topic.endswith(suffix) and len(topic)-len(suffix)>=2:
            return [topic[:-len(suffix)],kind]
    if re.fullmatch(r'[\u4e00-\u9fff]{3}道',topic):
        return [topic[:2],topic[2:]]
    return [topic]


def matching_excerpt(topic, text):
    """Only complete relevant paragraphs; never treat proximity as route identity."""
    if not isinstance(text, str):
        return ''
    text=_plain(text)
    if _INJECTION.search(text):return ''
    # A west-slope name is often split by the full mountain name. The result
    # remains a candidate, not an inferred alias or a current access conclusion.
    terms = _topic_terms(topic)
    paragraphs=[p.strip() for p in re.split(r'\n+',text) if 12<=len(p.strip())<=1300]
    anchors=[i for i,p in enumerate(paragraphs) if all(_normalized(t) in _normalized(p) for t in terms)]
    if not anchors:return ''
    # Keep adjacent qualifications instead of saving only the paragraph naming
    # a slope. They remain untrusted candidates and require source review.
    indices=set(anchors)
    for i in anchors:
        for j in range(max(0,i-4),min(len(paragraphs),i+5)):
            if re.search(r'公告|未开发|未开放|不受|仅限|适用范围',paragraphs[j]):indices.add(j)
    ordered=sorted(indices,key=lambda i:(not bool(re.search(r'公告|未开发|未开放|不受',paragraphs[i])),i))
    parts=[]
    for i in ordered:
        if sum(map(len,parts))+len(paragraphs[i])+2<=1500:parts.append(paragraphs[i])
        if len(parts)>=3:break
    return '\n\n'.join(parts)


def research_once(topic, provider, *, clock=time.monotonic, wall_clock=time.time, initial_hits=None,profile_pages=None,budget_seconds=HARD_SECONDS):
    """Two searches, three pages, bounded threads. Child supervisor enforces time."""
    started = clock(); deadline = started+min(HARD_SECONDS,budget_seconds)
    metrics = {'search_calls':0,'fetch_calls':0,'retries':0,'llm_calls':0,
               'search_ms':0,'fetch_ms':0,'validate_ms':0,'errors':[],
               'raw_hits':0,'discovered_hits':0,'eligible_pages':0,'search_hosts':[]}
    hits = list(initial_hits[:MAX_PAGES]) if initial_hits is not None else []; seen = set(); candidates = []
    metrics['discovery']='operator_supplied_urls' if initial_hits is not None else 'live_search_adapter'
    def remaining(limit=4.0): return max(0.001, min(limit,deadline-clock()))
    for query in (() if initial_hits is not None else research_queries(topic)):
        if clock()>=deadline: break
        metrics['search_calls']+=1; tick=clock()
        try:
            rows=provider.search(query, timeout=remaining(), limit=4)
            stats=getattr(provider,'last_search_stats',{})
            metrics['raw_hits']+=stats.get('raw_count',len(rows))
            metrics['search_hosts']=list(dict.fromkeys([*metrics['search_hosts'],*stats.get('hosts',[])]))[:8]
            for hit in rows[:4]:
                if hit.url not in seen:
                    hits.append(hit);seen.add(hit.url)
        except Exception as exc:
            code=getattr(exc,'code','SEARCH_UNAVAILABLE')
            metrics['errors'].append(code if re.fullmatch(r'[A-Z0-9_]{1,64}',str(code)) else 'SEARCH_UNAVAILABLE')
            if code in {'HTTP_401','HTTP_402','HTTP_403','HTTP_429'}: break
        finally: metrics['search_ms']+=round((clock()-tick)*1000,3)
    # Filtering is host policy, not a model-selected arbitrary URL fetch.
    from urllib.parse import urlsplit
    # Procurement/consultation notices mentioning landscaping are not walking
    # route descriptions. Discard them before spending the bounded page budget.
    hits=[hit for hit in hits if not re.search(r'采购|招标|中标|招租|征求.*意见|意见.*反馈',hit.title)]
    eligible=[hit for hit in hits if provider.can_fetch(hit.url)]
    # Keep a notice slot and two route-description slots. Three official press
    # releases often mention a mountain but contain no day-by-day itinerary.
    official=[hit for hit in eligible if (urlsplit(hit.url).hostname or '').lower().endswith('.gov.cn')]
    routes=sorted([hit for hit in eligible if hit not in official],key=lambda hit:not bool(re.search(r'攻略|路线|行程|环线|穿越',hit.title)))
    # Reserve the route slots before the six-hit cap; otherwise four official
    # news results can crowd out the itinerary found by the second query.
    hits=(official[:1]+routes+official[1:])[:MAX_HITS]
    allowed=(official[:1]+routes+official[1:])[:MAX_PAGES] if routes and initial_hits is None else eligible[:MAX_PAGES]
    metrics['discovered_hits']=len(hits);metrics['eligible_pages']=len(allowed)
    pool=ThreadPoolExecutor(max_workers=2)
    tick=clock()
    futures={}
    try:
        for hit in allowed:
            if clock()>=deadline: break
            metrics['fetch_calls']+=1
            futures[pool.submit(lambda target=hit:provider.fetch(target,timeout=remaining(8.0)))]=hit
        done,_=wait(futures,timeout=max(0,deadline-clock()))
        metrics['fetch_ms']=round((clock()-tick)*1000,3)
        tick=clock()
        for future in sorted(done,key=lambda f: futures[f].url):
            try:
                page=future.result();text=matching_excerpt(topic,page.text)
                if not text: continue
                if page.url != futures[future].url: continue
                title=_plain(page.title)[:200].strip()
                if not title:continue
                if profile_pages is not None:
                    full=_plain(page.text)[:12000]
                    if not _INJECTION.search(full):profile_pages.append({'url':page.url,'title':title,'text':full,'published_at':_published(page.published_at)})
                candidates.append({'url':page.url,'title':title, 'text':text,
                    'published_at':_published(page.published_at),
                    'fetched_at':datetime.fromtimestamp(wall_clock(),timezone.utc).isoformat(),
                    'content_hash':hashlib.sha256(text.encode()).hexdigest()})
            except Exception as exc:
                code=getattr(exc,'code','FETCH_UNAVAILABLE')
                metrics['errors'].append(code if re.fullmatch(r'[A-Z0-9_]{1,64}',str(code)) else 'FETCH_UNAVAILABLE')
        metrics['validate_ms']=round((clock()-tick)*1000,3)
    finally:
        pool.shutdown(wait=False,cancel_futures=True)
    metrics['total_ms']=round((clock()-started)*1000,3)
    expired=clock()>=deadline
    failed=not candidates and bool(metrics['errors'])
    metrics['partial_fetch']=expired or len(done)<len(futures)
    # A slow third page must not erase the complete, validated first two pages.
    # Keep the same deadline and leave unfinished requests to the supervisor.
    return {'status':'completed' if candidates else ('timeout' if expired else ('failed' if failed else 'empty')),
            'error_code':None if candidates else ('RESEARCH_DEADLINE' if expired else ('RESEARCH_SOURCE_UNAVAILABLE' if failed else None)),
            'metrics':metrics,'candidates':candidates}


def run_child(packet, *, timeout=HARD_SECONDS, worker_script=None):
    """Supervisor deadline includes startup and shutdown of all request threads."""
    script=Path(worker_script or Path(__file__).with_name('research_worker.py')).resolve()
    # The network child has no QQ credentials/config or model tracing environment.
    env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LANG','LC_ALL','SYSTEMDRIVE'}}
    env.update(PYTHONIOENCODING='utf-8',PYTHONDONTWRITEBYTECODE='1')
    options={'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}
    try:
        process=subprocess.Popen([sys.executable,'-B',str(script)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL,env=env,**options)
    except OSError:
        return {'status':'failed','error_code':'RESEARCH_CHILD_START_FAILED','candidates':[],'metrics':{}}
    tick=time.monotonic()
    terminated=False
    try:
        output,_=process.communicate(json.dumps(packet,ensure_ascii=False).encode(),timeout=timeout)
    except subprocess.TimeoutExpired:
        process.kill();output,_=process.communicate(timeout=2);terminated=True
    if (process.returncode and not terminated) or len(output)>65536:
        return {'status':'failed','error_code':'RESEARCH_CHILD_FAILED','candidates':[],'metrics':{}}
    try:
        # The child checkpoints admitted pages before starting its one optional
        # extraction. Killing a stalled model/fetch preserves that checkpoint.
        result=None
        for line in reversed(output.strip().splitlines()):
            try:
                candidate=json.loads(line)
                if isinstance(candidate,dict) and candidate.get('status') in {'completed','empty','timeout','failed'}:
                    result=candidate;break
            except ValueError:
                if not terminated:raise
        if result is None:raise ValueError()
        if terminated:
            if result.get('status')!='completed' or not result.get('candidates'):raise ValueError()
            result.setdefault('metrics',{}).update(child_terminated=True,partial_fetch=True,total_ms=round((time.monotonic()-tick)*1000,3))
        return result
    except (ValueError,IndexError):
        if terminated:return {'status':'timeout','error_code':'RESEARCH_HARD_TIMEOUT','candidates':[],
                              'metrics':{'total_ms':round((time.monotonic()-tick)*1000,3),'child_terminated':True}}
        return {'status':'failed','error_code':'RESEARCH_INVALID_OUTPUT','candidates':[],'metrics':{}}


def run_next(queue, *, provider='bing_rss', api_key='',store=None):
    """Call only from the separate research scheduler, never the answer worker."""
    from research_queue import ResearchQueueBusy,ResearchQueueError
    try:job=queue.claim_next()
    except ResearchQueueBusy:return {'status':'busy'}
    if not job:return {'status':'idle'}
    result=run_child({'topic':job['topic'],'provider':provider,'api_key':api_key})
    profiles=result.pop('hiking_profiles',[])
    try:
        queue.finish(job['job_id'],result)
        final=queue.status(job['topic'])
        if final.get('status') not in {'completed','empty','timeout','failed'}:
            return {'status':'failed','error_code':'RESEARCH_RESULT_NOT_COMMITTED','candidates':[],'metrics':result.get('metrics',{})}
        if final['status']!=result['status']:
            return {'status':final['status'],'error_code':'RESEARCH_RESULT_NOT_ADMITTED','candidates':[],'metrics':result.get('metrics',{})}
    except (ResearchQueueBusy,ResearchQueueError):
        return {'status':'failed','error_code':'RESEARCH_RESULT_NOT_COMMITTED','candidates':[],'metrics':result.get('metrics',{})}
    if result['status']=='completed':
        from hiking_catalog import HikingStore,ingest_profile,ingest_candidates
        catalog=HikingStore(queue);accepted=0
        for profile in profiles[:2] if isinstance(profiles,list) else []:
            try:
                if profile['topic']!=job['topic'] or profile.get('reviewed') is not False:continue
                catalog.put(profile)
                if store:ingest_profile(store,profile)
                accepted+=1
            except Exception:continue
        result['metrics']['hiking_profiles']=accepted
        if store:
            try:result['metrics']['rag_updates']=ingest_candidates(store,job['topic'],result.get('candidates',[]))
            except Exception:result['metrics']['rag_update_failed']=True
        try:queue.note_enrichment(job['job_id'],{k:v for k,v in result['metrics'].items() if k in {'hiking_profiles','rag_updates','rag_update_failed'}})
        except (ResearchQueueBusy,ResearchQueueError):pass
    return result


@lru_cache(maxsize=1)
def _public_admin_prefixes():
    """Host-owned location names only; no model/geocoder/network authority."""
    try:
        path=Path(__file__).resolve().parents[1]/'data/weather-locations.json'
        if path.stat().st_size>6*1024*1024:return ()
        rows=json.loads(path.read_text(encoding='utf-8')).get('places',[])
        names={}
        for row in rows:
            for key in ('admin1','admin2'):
                name=row.get(key,'')
                if not isinstance(name,str) or not re.fullmatch(r'[\u4e00-\u9fff]{2,20}',name):continue
                names[name]=name
                if name.endswith(('省','市')) and len(name)>2:names[name[:-1]]=name
        return tuple(sorted(names.items(),key=lambda item:len(item[0]),reverse=True))
    except (OSError,ValueError,TypeError,AttributeError):return ()


def _bind_admin_prefix(topic, source):
    """Restore a contiguous city qualifier the model omitted; reject ambiguity."""
    prefixes=_public_admin_prefixes()
    base=topic
    for alias,_ in prefixes:
        if topic.startswith(alias) and len(topic)-len(alias)>=2:
            base=topic[len(alias):];break
    found={}
    for match in re.finditer(re.escape(base),_normalized(source)):
        before=_normalized(source)[:match.start()]
        for alias,canonical in prefixes:
            if before.endswith(alias):
                found.setdefault(canonical,alias+base)
                break
    if len(found)>1:return None
    if found:return next(iter(found.values()))
    # A generic two-character road name has no reliable geographic identity.
    if len(topic)==2 and topic.endswith('道'):return None
    return topic


def public_outdoor_topic(topic, source):
    """Conservative name-only boundary; a whole itinerary is never a query."""
    from research_queue import normalize_topic
    if not isinstance(source,str) or not isinstance(topic,str):return None
    try:topic=normalize_topic(topic)
    except ValueError:return None
    if len(topic)>24 or _normalized(topic) not in _normalized(source):return None
    topic=_bind_admin_prefix(topic,source)
    if topic is None or len(topic)>24:return None
    if not re.fullmatch(r'[A-Za-z\u4e00-\u9fff ·-]{2,24}',topic):return None
    # Exact known public name, not a blanket exception for personal pronouns.
    if re.fullmatch(r'(?:他念他翁|库拉岗日|长穿毕|雨崩)(?:穿越|路线|徒步路线)?',topic):return topic
    if re.search(r'我|你|他|她|的|私人|私密|家里|家门|我家|家前|家后|住处|住所|住址|地址|男友|女友|朋友|家人|家属|宿舍|小区|公司|账户|账号|电话|密码|密钥|令牌|周末|明天|后天|今天|下周|计划|行程|集合|酒店|宾馆|预订|预算|查询|搜索|资料|攻略|天气|气温|降雨|降水|预报|怎么样|适合|可以|是否|附近',topic):return None
    if topic in {'山峰','雪山','高山','大山','后山','山谷','山岭','湖泊','大海','森林','公园','草原','峡谷','云海','步道','古道','路线','徒步路线','登山路线','环湖步道','登山步道','国家登山健身步道'}:return None
    if not re.search(r'(?:山|峰|岭|坡|谷|湖|海|道|草原|峡|峡谷|森林|公园|线|径|步道|植物园|保护区|景区|穿越)$',topic):return None
    return topic


def topic_matches(topic, item):
    """Similarity alone cannot establish that the named route is covered."""
    haystack=_normalized(str(item.get('title',''))+' '+str(item.get('text','')))
    if _normalized(topic) in haystack:return True
    match=re.fullmatch(r'(.{2,12}?)(东|西|南|北)坡',topic)
    return bool(match and _normalized(match[1]) in haystack and match[2]+'坡' in haystack)


def foreground_research(queue, *, topic, source, allow_public_search=False):
    """Read fresh candidates or enqueue once. Never call a network/worker/model."""
    from research_queue import ResearchQueueError, _url
    base={'schema_version':'outdoor.research.v1','candidate_evidence':[],
          'current_access':'unknown','authoritative':False}
    topic=public_outdoor_topic(topic,source) if allow_public_search else None
    if not topic:return {**base,'status':'denied','code':'RESEARCH_SCOPE_DENIED'}
    try:
        result=queue.enqueue(topic)  # queue owns TTL, coalescing and negative cache
        candidates=[]
        if result.get('status')=='completed':
            for item in queue.candidates(topic):
                body=item.get('text','');title=item.get('title','')
                if (not isinstance(body,str) or not 1<=len(body)<=1600 or
                    _INJECTION.search(body+' '+title) or not matching_excerpt(topic,body) or
                    hashlib.sha256(body.encode()).hexdigest()!=item.get('content_hash')):continue
                try:url=_url(item['url'])
                except ValueError:continue
                candidates.append({'text':body,'title':title,'source_url':url,
                    'published_at':_published(item.get('published_at')),
                    'fetched_at':item['fetched_at'],'trusted':False,'current_access':'unknown'})
        return {**base,**result,'topic':topic,'candidate_evidence':candidates}
    except ResearchQueueError as exc:
        return {**base,'topic':topic,'status':'unavailable','error_code':'RAG_STORE_UNAVAILABLE',
                'code':exc.code}
    except (OSError,TypeError,KeyError,ValueError):
        return {**base,'topic':topic,'status':'unavailable','error_code':'RAG_STORE_UNAVAILABLE',
                'code':'RESEARCH_STORE_UNAVAILABLE'}


def format_research_observation(value):
    """Quote untrusted candidates, preserving dates/qualifiers and a hard bound."""
    topic=value.get('topic','该地点');status=value.get('status')
    if status=='denied':return '未登记搜索。请在本条消息中明确一个公开户外地点或路线名称。'
    heads={'queued':f'{topic}的补充资料已排队。下次询问时可读取结果。',
           'running':f'{topic}的补充资料正在查询。下次询问时可读取结果。',
           'completed':f'{topic}｜未核验的补充资料',
           'empty':f'本次未找到{topic}的可用补充资料，暂不重复搜索。',
           'failed':f'{topic}的补充搜索暂未完成，稍后可再查询。',
           'timeout':f'{topic}的补充搜索已超时，稍后可再查询。',
           'cancelled':f'{topic}的排队任务已过期，稍后可再查询。',
           'busy':'资料队列正忙，请稍后再试。','full':'资料队列已满，请稍后再试。',
           'rate_limited':'今日补充资料查询额度已用完。','unavailable':'补充资料查询暂不可用。'}
    parts=[heads.get(status,'补充资料查询暂不可用。')]
    if status=='completed':parts.append('以下为历史/待核实原文；采集时间不等于生效时间，不能据此确认当前开放或安全。')
    for item in value.get('candidate_evidence',[])[:3]:
        published=item.get('published_at') or '未标注'
        fetched=datetime.fromtimestamp(item['fetched_at'],timezone.utc).strftime('%Y-%m-%d UTC')
        meta=f"来源日期线索：{published}；采集：{fetched}\n来源：{item['source_url']}"
        entry=f"【候选资料】\n{item['text']}\n{meta}"
        if len('\n\n'.join([*parts,entry]))<=1500:parts.append(entry)
        elif len(parts)==2 and len('\n\n'.join([*parts,meta]))<=1500:
            parts.append('原文较长，请查看来源；未截断原文生成结论。\n'+meta)
    if status=='completed' and len(parts)==2:parts.append('没有可安全展示的相关原文。')
    # Only whole canonical chunks, kept separate from unverified candidates.
    for item in value.get('evidence',[])[:2]:
        source=str(item.get('source_ref',''))
        try:
            from research_queue import _url
            _url(source)
        except ValueError:continue
        entry='【已有资料】\n'+str(item.get('text',''))+'\n来源：'+source
        if len('\n\n'.join([*parts,entry]))<=1500:parts.append(entry)
    return '\n\n'.join(parts)


def build_research_tool(queue, *, source, allow_public_search=False, retriever=None, namespace=None):
    """Strict host-bound LangChain enqueue/read tool; no frontend network."""
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, ConfigDict, Field
    class Args(BaseModel):
        model_config=ConfigDict(extra='forbid',strict=True)
        topic:str=Field(min_length=2,max_length=24,description='从本条原文逐字提取的公开户外地点或路线短名，不传行程、天气问题或个人地址。')
    def submit(topic):
        value=foreground_research(queue,topic=topic,source=source,allow_public_search=allow_public_search)
        if value['status']!='denied' and retriever is not None and namespace:
            try:
                bound_topic=value['topic']
                result=retriever.search(bound_topic,namespace=namespace,domain='outdoor',include_shared=True,limit=2,mode='lexical')
                value['evidence']=[item for item in result.get('evidence',[]) if topic_matches(bound_topic,item)]
            except Exception:pass  # Existing sources are optional; never replace candidate provenance.
        return value
    return StructuredTool.from_function(submit,name='request_outdoor_research',args_schema=Args,
        description='查询本条点名公开户外地点的补充资料；如福州福道适合徒步吗、哈巴西坡有什么路线。优先读取已缓存的带日期来源候选，否则登记一次受限后台搜索并立即返回，不等待网络。候选未核验，不能据此确认实时开放、安全、天气或最佳季节；仅传短地点名。',return_direct=True)


def promote_approved(queue, store, candidate_id, *, now=None):
    """Operator/idle owner only: approved paraphrase -> canonical store + outbox."""
    now=time.time() if now is None else now
    row=queue.approved(candidate_id)
    if not row: raise ValueError('RESEARCH_NOT_APPROVED')
    reviewed_at=row['reviewed_at']
    text=f"资料核查于{datetime.fromtimestamp(reviewed_at,timezone.utc).date().isoformat()}；以下为有出处的资料摘要，不是整条路线当前开放或实时天气结论。\n\n{row['reviewed_text']}"
    # Stable source identity + fixed review expiry makes repeat promotion idempotent.
    doc_id='web-'+hashlib.sha256((_normalized(row['topic'])+'\0'+row['url']).encode()).hexdigest()
    result=store.put_document(doc_id=doc_id,namespace='shared',visibility='shared',domain='outdoor',
        title=row['topic']+'｜外部资料核验摘要',text=text,source_ref=row['url'],valid_from=reviewed_at,valid_until=reviewed_at+7*86400)
    return {'ok':True,'doc_id':result['doc_id'],'revision':result['revision'],'changed':result['changed'],'vector_index_pending':True}
