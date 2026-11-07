"""Explicit local live smoke; creates fresh isolated stores, never production.

python scripts/test-bounded-research.py
Public adapter discovery and operator-supplied URL verification are separate.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid

root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'python'))
from bounded_research import build_research_tool,run_next,run_child,promote_approved
from research_queue import ResearchQueue
from rag_store import RagStore
from rag_retriever import RagRetriever
from agent_worker import build_runner

folder=root/'test-output/bounded-search'/('live-'+uuid.uuid4().hex[:8]);folder.mkdir(parents=True)
queue=ResearchQueue(folder/'auto.sqlite3');topic='哈巴西坡'
tool=build_research_tool(queue,source='搜索哈巴西坡徒步资料',allow_public_search=True)
start=time.perf_counter();first=tool.invoke({'topic':topic});enqueue_ms=(time.perf_counter()-start)*1000
runner=build_runner();normal=[]
with ThreadPoolExecutor(max_workers=1) as pool:
    future=pool.submit(run_next,queue)
    for n in range(3):
        start=time.perf_counter()
        answer=runner.run({'type':'execute','id':f'normal-{n}','name':'convert_units','args':{'amount':'1','from_unit':'马里','to_unit':'km'}})
        normal.append({'ms':round((time.perf_counter()-start)*1000,3),'correct':'3.08' in answer['text'],'background_pending':not future.done()})
        time.sleep(.03)
    automatic=future.result(timeout=25)
duplicate=tool.invoke({'topic':topic})
assert duplicate['job_id']==first['job_id'] and all(r['correct'] for r in normal)
sources=json.loads((root/'test-output/bounded-search/haba-research.json').read_text(encoding='utf-8'))['sources']
seeded=run_child({'topic':topic,'provider':'operator_sources','sources':[{'url':r['url'],'title':r['title']} for r in sources]})
verified=ResearchQueue(folder/'verified-links.sqlite3');verified.enqueue(topic);job=verified.claim_next();verified.finish(job['job_id'],seeded)
store=RagStore(folder/'approved.sqlite3');retriever=RagRetriever(store)
before=retriever.search(topic,namespace='smoke',domain='outdoor',include_shared=True,mode='lexical')
admitted=[]
for row in verified.candidates(topic):
    reference=next((s for s in sources if s['url']==row['url'] and s['body_read'] and s.get('paraphrase')),None)
    if not reference:continue
    summary=reference['paraphrase']+' 本条仅作为带日期、适用范围的媒体转述；西坡具体支线未明确，不推断全部西坡当前开放或关闭。'
    verified.approve(row['id'],summary,'维护者对照本轮已读正文核查来源、公告日期与支线范围；未取得官方原件。')
    admitted.append(promote_approved(verified,store,row['id']))
after=retriever.search(topic,namespace='smoke',domain='outdoor',include_shared=True,mode='lexical')
record={'schema_version':'bounded-research.smoke.v1','checked_at':datetime.now(timezone.utc).isoformat(),
        'production_changed':False,'topic':topic,'enqueue_ms':round(enqueue_ms,3),'normal_tool_while_background':normal,
        'automatic_discovery':automatic,'duplicate':duplicate,'operator_url_verification':seeded,
        'approved_documents':admitted,'canonical_before_count':len(before['evidence']),
        'canonical_after':after,'result_directory':str(folder)}
(folder/'result.json').write_text(json.dumps(record,ensure_ascii=False,indent=2),encoding='utf-8')
(root/'test-output/bounded-search/latest-result-path.txt').write_text(str(folder/'result.json'),encoding='utf-8')
print(json.dumps({k:record[k] for k in ['enqueue_ms','normal_tool_while_background','approved_documents','canonical_before_count','result_directory']},ensure_ascii=False))
print(json.dumps({'automatic':automatic,'seeded':seeded,'canonical_after_count':len(after['evidence'])},ensure_ascii=False))
