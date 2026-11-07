"""Optional operator-configured RAG integration; no model-controlled identity/config."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import time
from urllib.parse import urlsplit

from langchain_core.tools import StructuredTool
from group_features import allows_feature

RAG_NAMES = frozenset({'search_domain_knowledge', 'recall_project_notes', 'save_project_note', 'delete_project_note','prepare_outdoor_trip','request_outdoor_research','hiking_trip_card'})
RAG_ERRORS = frozenset({'RAG_VECTOR_NOT_CONFIGURED','RAG_VECTOR_UNAVAILABLE','RAG_STORE_UNAVAILABLE',
    'RAG_INDEX_MANIFEST_MISMATCH','RAG_EMBEDDING_MISMATCH','EMBEDDING_DIMENSION_MISMATCH',
    'RAG_EXPLICIT_SAVE_REQUIRED','RAG_EXPLICIT_DELETE_REQUIRED','RAG_DISABLED','HIKING_FORECAST_TIMEOUT','HIKING_FORECAST_UNAVAILABLE'})


def clear_project_notes_for_memory_control(namespace, store=None):
    """Legacy clear/off must not leave project notes to reappear on reopen."""
    if store is not None:
        return store.clear_project_notes(namespace=namespace)
    filename=os.environ.get('QQ_RAG_CONFIG','')
    if not filename:
        return 0
    path=Path(filename)
    if not path.is_absolute() or path.stat().st_size>16384:
        raise ValueError('RAG_CONFIG_INVALID')
    config=json.loads(path.read_text(encoding='utf-8'))
    if not config.get('store_path') and config.get('enabled') is not True:
        return 0
    database=Path(config['store_path'])
    if not database.is_absolute():
        raise ValueError('RAG_CONFIG_INVALID')
    if not database.exists():
        return 0
    from rag_store import RagStore
    return RagStore(database).clear_project_notes(namespace=namespace)


def project_write_route(source):
    """Only explicit whole-request grammar bypasses the model, never quotations."""
    from rag_tools import explicit_note_request
    match=re.fullmatch(r'(?:请)?(?:保存|记住|记录|更新)\s*(?:项目摘要|项目)\s*[：:]?\s*([^：:\n]{1,80})\s*[：:]\s*(.+)',source.strip(),re.S)
    if match:
        project,text=match.group(1).strip(),match.group(2).strip()
        if explicit_note_request(source,project,text):
            return 'save_project_note',{'project_key':project,'text':text}
    match=re.fullmatch(r'(?:请)?(?:删除|忘记|忘掉)\s*(?:项目摘要|项目)\s*[：:]?\s*(.{1,80}?)(?:\s*的(?:摘要|记录|笔记))?[。！!]?',source.strip())
    if match:
        project=match.group(1).strip()
        if explicit_note_request(source,project,delete=True):
            return 'delete_project_note',{'project_key':project}
    return None


def result_metadata(observation):
    code=observation.get('error_code')
    return {'status':observation.get('status','unavailable'),
            **({'errorCode':code} if code in RAG_ERRORS else {}),
            'ragTimings':{key:val for key,val in observation.get('timings',{}).items()
                if key in {'lexical_ms','embedding_ms','vector_ms','source_verify_ms','total_ms','hiking_route_ms','hiking_locate_ms','hiking_fetch_ms'}
                and type(val) in {int,float} and 0<=val<=600000},
            **({'ragFailedStage':observation['failed_stage']} if observation.get('failed_stage') in {'lexical','embedding','vector','source_verify','hiking_fetch'} else {}),
            **({'hikingCard':observation['hikingCard']} if observation.get('hikingCard',{}).get('schema')=='hiking.card.v1' else {})}


def load_rag_retriever():
    """Absent/invalid config leaves the existing worker fully functional."""
    filename = os.environ.get('QQ_RAG_CONFIG', '')
    if not filename:
        return None
    try:
        config_path = Path(filename)
        if not config_path.is_absolute() or config_path.stat().st_size > 16384:
            return None
        config = json.loads(config_path.read_text(encoding='utf-8'))
        if config.get('enabled') is not True:
            return None
        path = Path(config['store_path'])
        if not path.is_absolute():
            return None
        from rag_store import RagStore
        from rag_retriever import RagRetriever
        store = RagStore(path)
        embedding_config = config.get('embedding')
        vector_config = config.get('vector')
        if not embedding_config or not vector_config:
            return RagRetriever(store)
        try:
            from embedding_provider import FastEmbedProvider, HttpEmbeddingProvider
            from vector_index import MilvusIndex
            uri = vector_config['uri']
            if not isinstance(uri, str):
                return None
            if not (Path(uri).is_absolute() and uri.endswith('.db')):
                parsed = urlsplit(uri)
                if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password:
                    return None
            options = {key: embedding_config[key] for key in ('model_id', 'revision', 'dimension')}
            if embedding_config.get('provider') == 'fastembed':
                cache = Path(embedding_config['cache_dir'])
                if not cache.is_absolute():
                    return None
                embedding = FastEmbedProvider(**options, cache_dir=str(cache), local_files_only=True, threads=1)
            elif embedding_config.get('provider') == 'http':
                embedding = HttpEmbeddingProvider(**options, endpoint=embedding_config['endpoint'],
                                                  api_key=embedding_config.get('api_key', ''), timeout=8)
            else:
                return None
            index = MilvusIndex(vector_config['uri'], embedding.spec,
                                token=vector_config.get('token', ''), timeout=8)
            return RagRetriever(store, index=index, embedding=embedding)
        except Exception:
            # A missing optional dependency or offline index still permits
            # bounded canonical keyword search; its result is labelled degraded.
            return RagRetriever(store)
    except Exception:
        # Never put config paths, provider credentials or exception bodies in QQ.
        return None


def load_outdoor_config():
    """Optional trusted catalogue; invalid outdoor settings don't disable RAG."""
    try:
        path=Path(os.environ.get('QQ_RAG_CONFIG',''))
        if not path.is_absolute() or path.stat().st_size>16384: return None
        config=json.loads(path.read_text(encoding='utf-8'))
        options=config.get('outdoor')
        if config.get('enabled') is not True or not isinstance(options,dict): return None
        database=Path(options['climate_path'])
        if not database.is_absolute(): return None
        rows=options['locations']
        if not isinstance(rows,list) or not 1<=len(rows)<=32: return None
        from climate_history import ClimateHistory,ClimateLocation
        locations={row['id']:ClimateLocation(row['id'],row['latitude'],row['longitude']) for row in rows}
        names={row['id']:row['name'] for row in rows}
        if len(locations)!=len(rows) or any(not isinstance(name,str) or not 1<=len(name)<=80 for name in names.values()): return None
        return {'locations':locations,'location_names':names,'climate_service':ClimateHistory(database)}
    except Exception:
        return None


def load_research_queue():
    """Operator-only spool, absent by default; no providers or credentials here."""
    try:
        path=Path(os.environ.get('QQ_RAG_CONFIG',''))
        if not path.is_absolute() or path.stat().st_size>16384:return None
        config=json.loads(path.read_text(encoding='utf-8'))
        options=config.get('research')
        if config.get('enabled') is not True or not isinstance(options,dict) or options.get('enabled') is not True:return None
        database=Path(options['queue_path'])
        if (not database.is_absolute() or '.private' not in database.parts or
            database.suffix not in {'.db','.sqlite','.sqlite3'}):return None
        # A spool must never be the canonical store, climate cache or Lite file.
        protected=[config.get('store_path'),config.get('outdoor',{}).get('climate_path'),config.get('vector',{}).get('uri')]
        if any(value and database.resolve()==Path(value).resolve() for value in protected):return None
        from research_queue import ResearchQueue
        return ResearchQueue(database)
    except Exception:
        return None


def compound_outdoor_request(text):
    """Only explicit trip-plus-planning questions bypass weather shortcuts."""
    return bool(re.search(r'徒步|登山|露营|穿越|出行|旅行',text) and
                re.search(r'季节|装备|带什么|准备什么|适合|合适|路线|过夜|天气|温度|云量|降雨|睡袋|营地|住宿',text))


def eligible_context(packet):
    context = packet.get('context')
    return (isinstance(context, dict)
            and (context.get('scope') == 'c2c' or
                 (context.get('scope') == 'group' and context.get('access') == 'white'))
            and isinstance(packet.get('sessionKey'), str)
            and re.fullmatch(r'[a-f0-9]{64}', packet['sessionKey']) is not None)


def feature_for(name, args):
    if name in {'prepare_outdoor_trip','request_outdoor_research','hiking_trip_card'}: return 'weather'
    if name == 'search_domain_knowledge':
        return {'campus': 'campus', 'weather': 'weather', 'outdoor': 'weather', 'bot': 'memory'}.get(args.get('domain', 'campus'))
    return 'memory' if name in RAG_NAMES else None


def format_observation(value):
    """Deterministic quoted evidence, no extra model call or factual invention."""
    status = value.get('status')
    if status == 'ok' and value.get('operation') in {'save', 'delete'}:
        if value['operation'] == 'save':
            return '已保存本轮明确指定的项目记录。' if value.get('changed') else '这条项目记录已保存，内容没有变化。'
        return '已删除指定项目记录。' if value.get('changed') else '没有找到该项目的有效记录。'
    if status in {'denied', 'invalid', 'rejected'}:
        return '未修改记录。请明确说明要保存或删除的项目，以及本次要保存的原文。'
    evidence = value.get('evidence')
    if not isinstance(evidence, list) or not evidence:
        return '知识检索暂不可用，请稍后再试。' if status == 'unavailable' else '当前资料中没有找到足够依据。'
    parts = ['检索到相关原文，请核对是否覆盖问题：']
    for item in evidence[:4]:
        if not isinstance(item, dict):
            continue
        text = str(item.get('text', '')).strip()
        if not text:
            continue
        title = str(item.get('title') or '资料片段')
        revision = str(item.get('revision', ''))[:20]
        source = str(item.get('source_ref', ''))
        parsed = urlsplit(source)
        reference = source if parsed.scheme in {'http', 'https'} and parsed.hostname and not parsed.username and not parsed.password and len(source)<200 else '记录 ' + str(item.get('doc_id', ''))[:12]
        entry = f'【{title}' + (f' · 版本 {revision}' if revision else '') + '】\n' + text + '\n来源：' + reference
        # Never cut a rule/exception or source mid-chunk. Fit fewer whole pieces.
        if len('\n\n'.join([*parts,entry])) <= 1300:
            parts.append(entry)
    if len(parts) == 1:
        return '当前资料中没有找到足够依据。'
    if status == 'degraded':
        parts.append('当前为关键词检索结果。')
    return '\n\n'.join(parts)


def build_agent_rag_tools(retriever, packet, claim, selected, outdoor_config=None,research_queue=None):
    if retriever is None or not eligible_context(packet):
        return []
    from rag_tools import build_rag_tools
    context = packet['context']
    disabled = isinstance(context.get('social'), dict) and context['social'].get('disabled') is True
    allow_memory = allows_feature(context, 'memory') and not disabled
    base = build_rag_tools(retriever, namespace=packet['sessionKey'], source=packet['text'],
                           source_ref='request:' + packet['id'], allow_shared=True, allow_write=allow_memory,
                           research_queue=research_queue,allow_research=allows_feature(context,'weather'))
    if allows_feature(context,'weather'):
        from hiking_trip import build_hiking_tool
        base['hiking_trip_card']=build_hiking_tool(source=packet['text'],queue=research_queue,outdoor_config=outdoor_config)
    if research_queue is not None and allows_feature(context,'weather'):
        from bounded_research import build_research_tool
        base['request_outdoor_research']=build_research_tool(research_queue,source=packet['text'],
            allow_public_search=True,retriever=retriever,namespace=packet['sessionKey'])
        base['search_domain_knowledge'].description+=' 户外问题请传当前原文的短地点名 outdoor_topic；无对应正式资料时读取未核验候选或登记后台搜索。'
    if outdoor_config and allows_feature(context,'weather'):
        from outdoor_planning import build_outdoor_planning_tool
        base['prepare_outdoor_trip']=build_outdoor_planning_tool(**outdoor_config,retriever=retriever,
            namespace=packet['sessionKey'],allow_shared=True,allow_weather=True,retrieval_mode='lexical')
        catalogue='；'.join(f'{key}={outdoor_config["location_names"][key]}' for key in outdoor_config['locations'])
        base['prepare_outdoor_trip'].description += ' 已批准地点ID：'+catalogue+'。日期只按用户明确行程解析，不猜路线和经验。'
    result = []
    for name, underlying in base.items():
        if name not in RAG_NAMES:
            continue
        if name == 'search_domain_knowledge':
            if not any(allows_feature(context, domain) for domain in ('campus', 'weather')) and not allow_memory:
                continue
        elif name in {'prepare_outdoor_trip','request_outdoor_research','hiking_trip_card'}:
            if not allows_feature(context,'weather'): continue
        elif not allow_memory:
            continue

        def invoke(_name=name, _underlying=underlying, **args):
            if not claim():
                return '本轮已执行一次工具。'
            feature = feature_for(_name, args)
            if not feature or not allows_feature(context, feature) or (feature == 'memory' and not allow_memory):
                selected.update(kind='clarify', reason='restricted_access', memory_text='')
                return '当前会话未开放这项功能。'
            started=time.time()*1000
            observation = _underlying.invoke(args)
            if not isinstance(observation, dict):
                observation = {'status': 'unavailable', 'evidence': []}
            if observation.get('evidence'):
                domain = args.get('domain', 'campus') if _name == 'search_domain_knowledge' else 'outdoor' if _name=='request_outdoor_research' else 'project'
                observation['evidence'] = retriever.validate_evidence(observation['evidence'],
                    namespace=packet['sessionKey'],domain=domain,include_shared=_name in {'search_domain_knowledge','request_outdoor_research'},
                    project_key=args.get('project_key'))
            if observation.get('schema_version')=='outdoor.research.v1':
                from bounded_research import format_research_observation
                answer=format_research_observation(observation)
                observation['timings']={**observation.get('timings',{}),'total_ms':round(time.time()*1000-started,3)}
            elif _name=='hiking_trip_card':
                answer=observation.get('message','徒步天气卡片已生成。')
                observation['timings']={**observation.get('timings',{}),'total_ms':round(time.time()*1000-started,3)}
            elif _name=='prepare_outdoor_trip':
                from outdoor_planning import format_trip_report
                answer=format_trip_report(observation,location_names=outdoor_config['location_names'])
                observation['timings']={'total_ms':round(time.time()*1000-started,3)}
            else:
                answer = format_observation(observation)
            selected.update(kind='rag', text=answer, required_feature=feature,
                            observation=observation, rag_started_at=started,memory_text='[已查询知识或项目记录]')
            if _name=='prepare_outdoor_trip' and observation.get('requirements'):
                req=observation['requirements']
                selected['outdoor_trip']=True
                selected['memory_text']=(f"未完成的户外行程：地点ID={req['destination_id']}；日期={req['start_date']}~{req['end_date']}；"
                    f"路线={req.get('route_variant') or '未知'}；过夜={req.get('overnight') if req.get('overnight') is not None else '未知'}；"
                    f"经验={req.get('experience','unknown')}；最高海拔={req.get('max_altitude_m') if req.get('max_altitude_m') is not None else '未知'}。"
                    '只保存本轮约束，天气与开放状态下轮重新核对。')
            return answer

        result.append(StructuredTool.from_function(invoke, name=name, description=underlying.description,
                                                  args_schema=underlying.args_schema, return_direct=True))
    return result
