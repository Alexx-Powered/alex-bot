"""Connect candidate checkpoints to independent evidence review and idempotent publication."""
import json
from research_verifier import build_verifier, passage


def prepare_checks(topic, candidates, profiles):
    from hiking_catalog import validate_profile
    checks = []
    captured = [passage(c['url'],c['text'],c.get('published_at')) for c in candidates]
    for number,(c,source) in enumerate(zip(candidates,captured),1):
        if source['content_hash'] != c['content_hash']:
            continue
        task = {'claims': [f'来源{number}直接描述{topic}的徒步路线、行程或特定路段限制。'
                 f'请从来源{number}引用同时明确地点和事实的原句，保持时间、范围和否定词；与其他来源同范围同时间的相反说法应列为冲突。'],
                'sources': captured}
        checks.append(('url:' + c['url'], {'kind': 'excerpt', 'topic': topic, 'task': task, 'candidate': c}))
    admitted_urls = {c['url'] for c in candidates}
    for index, raw in enumerate(profiles[:2]):
        try:
            p = validate_profile(raw)
            if p['topic'] != topic or p['reviewed'] or any(s['url'] not in admitted_urls for s in p['sources']):
                continue
            claims, sources = [], []
            for day in p['days']:
                src = p['sources'][day['source']]
                if day.pop('stay_photo',None) and day['sleep']:
                    from hiking_stays import stay_modes
                    sleep=day['sleep']
                    modes=stay_modes(sleep['name'],day['evidence']+'\n'+day.get('stay_evidence',''))
                    sleep['kind']=modes[0] if modes else 'camp'
                    sleep.pop('options',None)
                    if modes:sleep['options']=modes
                for text in (day['evidence'], day.get('stay_evidence')):
                    if text:
                        part = passage(src['url'], text, src['date'])
                        if part not in sources:
                            sources.append(part)
                sleep = day['sleep']
                claim = f"{topic}（{p['variant']}），本方案第{len(claims)+1}个步行日依次经过" + '、'.join(day['route'])
                if sleep:
                    modes = sleep.get('options') or [sleep['kind']]
                    claim += '，住宿地点' + sleep['name'] + '，住宿方式' + '及'.join(
                        {'camp':'未明确', 'tent':'露营', 'inn':'住店'}[m] for m in modes)
                claims.append(claim)
            if sources:
                for item in captured:
                    if item not in sources:sources.append(item)
                task={'kind':'profile', 'topic':topic, 'profile':p, 'task':{'claims':claims, 'sources':sources}}
                if len(json.dumps(task,ensure_ascii=False,separators=(',',':')).encode())<=65000:
                    checks.append((f'profile:{index}',task))
        except (KeyError, TypeError, ValueError):
            continue
    return checks


def perform_check(queue, task, store, api_key, verifier=None):
    from hiking_catalog import HikingStore, ingest_candidates, ingest_profile
    payload = task['payload']
    if task['state'] == 'checking':
        graph = verifier if verifier is not None else build_verifier(api_key)
        receipt = graph.invoke(payload['task'])
        if receipt['status']=='supported' and payload['kind']=='excerpt':
            from bounded_research import _normalized, _topic_terms
            candidate=payload['candidate']
            quotes=''.join(r['quote'] for r in receipt['evidence']
                           if r['url']==candidate['url'] and r['content_hash']==candidate['content_hash'])
            if not all(_normalized(t) in _normalized(quotes) for t in _topic_terms(payload['topic'])):
                receipt={**receipt,'status':'insufficient','evidence':[]}
        elif receipt['status']=='supported' and payload['kind']=='profile':
            profile=payload['profile']
            for i,day in enumerate(profile['days']):
                url=profile['sources'][day['source']]['url']
                quotes=''.join(r['quote'] for r in receipt['evidence'] if r['claim']==i and r['url']==url
                               and (r['quote'] in day['evidence'] or r['quote'] in day.get('stay_evidence','')))
                names=day['route']+([day['sleep']['name']] if day['sleep'] else [])
                if not all(name in quotes for name in names):
                    receipt={**receipt,'status':'insufficient','evidence':[]}
                    break
        next_state = 'ready' if receipt['status'] == 'supported' else receipt['status']
        queue.advance_check(task, next_state, receipt)
        return {'status':'failed' if receipt['status']=='pending' else 'completed',
                'stage':'check','verdict':receipt['status'],
                **({'error_code':receipt['metrics'].get('error','RESEARCH_CHECK_PENDING')} if receipt['status']=='pending' else {}),
                'metrics':receipt['metrics']}

    # Only a saved supported receipt can enter the publishing stage.
    receipt = task['receipt']
    with queue.publication(task) as db:
        if payload['kind'] == 'profile':
            profile = payload['profile']
            HikingStore(queue).put(profile, machine_checked=True,connection=db,expires_at=task['expires'])
            if store:
                ingest_profile(store, profile, now=profile['checked_at'], machine_checked=True,expires_at=task['expires'])
        else:
            candidate = payload['candidate']
            quotes = [r['quote'] for r in receipt['evidence']
                      if r['url'] == candidate['url'] and r['content_hash'] == candidate['content_hash']]
            if not quotes:
                raise ValueError('RESEARCH_UNSUPPORTED_PUBLICATION')
            if store:
                from research_queue import _timestamp
                fetched = _timestamp(candidate['fetched_at'])
                written=ingest_candidates(store, payload['topic'], [{**candidate,'text':'\n'.join(dict.fromkeys(quotes))}],
                                          now=fetched, machine_checked=True)
                if written!=1:raise ValueError('RESEARCH_UNSUPPORTED_PUBLICATION')
    return {'status':'completed','stage':'publish','verdict':'supported','metrics':{'hiking_profiles':int(payload['kind']=='profile'),
                                             'rag_updates':int(store is not None)}}
