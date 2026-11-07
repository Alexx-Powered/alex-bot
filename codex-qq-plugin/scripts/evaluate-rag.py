"""Reproducible local Milvus + real Chinese embeddings; never connects to QQ."""
from pathlib import Path
import argparse
import hashlib
import importlib.metadata
import json
import statistics
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))
from rag_store import RagStore
from rag_retriever import RagRetriever
from embedding_provider import FastEmbedProvider
from vector_index import MilvusIndex

def peak_rss_mib():
    if sys.platform=='win32':
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_=[('cb',wintypes.DWORD),('faults',wintypes.DWORD)]+[(x,ctypes.c_size_t) for x in ['peak','working','peak_paged','paged','peak_nonpaged','nonpaged','pagefile','peak_pagefile']]
        counters=Counters();counters.cb=ctypes.sizeof(counters)
        kernel=ctypes.WinDLL('kernel32');kernel.GetCurrentProcess.restype=wintypes.HANDLE
        psapi=ctypes.WinDLL('psapi');psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(),ctypes.byref(counters),counters.cb):
            return round(counters.peak/1024**2,2)
        return None
    import resource
    peak=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(peak/(1024**2 if sys.platform=='darwin' else 1024),2)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--cases',type=Path,default=ROOT/'evals/rag/cases.json')
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--model-cache',type=Path,required=True)
    p.add_argument('--revision',required=True)
    args=p.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        p.error('output must be empty; each run owns a fresh isolated database')
    args.output.mkdir(parents=True,exist_ok=True)
    cases=json.loads(args.cases.read_text(encoding='utf-8'))
    store=RagStore(args.output/'rag-store.sqlite3')
    for document in cases['documents']:
        store.put_document(**document)
    embedding=FastEmbedProvider('BAAI/bge-small-zh-v1.5',args.revision,512,args.model_cache,threads=2)
    index=MilvusIndex(str((args.output/'vectors.db').resolve()),embedding.spec)
    retriever=RagRetriever(store,index,embedding)
    started=time.perf_counter()
    indexed=retriever.process_outbox()
    if indexed['failed'] or indexed['processed']!=len(cases['documents']):
        raise RuntimeError('real indexing failed: '+str(indexed))
    indexing_ms=round((time.perf_counter()-started)*1000,2)
    rows=[]
    for case in cases['queries']:
        scope=dict(namespace=case.get('namespace','eval:alice:private'),domain=case['domain'],
                   include_shared=case['domain']!='project',project_key=case.get('project_key'),limit=5)
        for mode in ['lexical','vector','hybrid']:
            result=retriever.search(case['query'],**scope,mode=mode)
            actual=list(dict.fromkeys(x['doc_id'] for x in result['evidence']))
            expected=set(case['expected'])
            rows.append(dict(id=case['id'],mode=mode,status=result['status'],expected=case['expected'],actual=actual,
                             recall_at_5=len(expected.intersection(actual))/len(expected) if expected else None,
                             abstained=not actual if not expected else None,
                             isolation_ok=not set(case.get('forbidden',[])).intersection(actual),
                             timings=result['timings'],error=result['error_code']))
    # Restart the real backend, then delete canonical text while its vector remains.
    index.close()
    restarted=RagRetriever(store,MilvusIndex(str((args.output/'vectors.db').resolve()),embedding.spec),embedding)
    scope=dict(namespace='eval:alice:private',domain='project',project_key='bot',mode='vector')
    before=restarted.search('上次决定先开发什么',**scope)
    assert [x['doc_id'] for x in before['evidence']]==['alice-project']
    store.delete_document('alice-project',namespace='eval:alice:private')
    stale=restarted.search('上次决定先开发什么',**scope)
    assert not stale['evidence'],'deleted text leaked through stale vector'
    deleted=restarted.process_outbox()
    assert not deleted['failed']
    restarted.index.close()
    summary={}
    for mode in ['lexical','vector','hybrid']:
        selected=[r for r in rows if r['mode']==mode]
        latencies=sorted(r['timings']['total_ms'] for r in selected)
        answerable=[r for r in selected if r['expected']]
        negatives=[r for r in selected if not r['expected']]
        summary[mode]={'queries':len(selected),'recall_at_5':statistics.mean(r['recall_at_5'] for r in answerable),
                       'abstentions':sum(r['abstained'] for r in negatives),'no_answer_cases':len(negatives),
                       'scope_leaks':sum(not r['isolation_ok'] for r in selected),
                       'p50_ms':statistics.median(latencies),'p95_ms':latencies[min(len(latencies)-1,int(.95*len(latencies)))],
                       'errors':sum(bool(r['error']) for r in selected)}
    receipt={'schema_version':'rag.eval.result.v1','purpose':cases['purpose'],'case_sha256':hashlib.sha256(args.cases.read_bytes()).hexdigest(),
             'model':embedding.spec.__dict__,'packages':{x:importlib.metadata.version(x) for x in ['pymilvus','milvus-lite','fastembed','onnxruntime','langchain']},
             'indexing_ms':indexing_ms,'peak_rss_mib':peak_rss_mib(),'documents':len(cases['documents']),'restart_passed':True,'delete_with_stale_vector_passed':True,
             'summary':summary,'results':rows}
    (args.output/'results.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'indexing_ms':indexing_ms,'peak_rss_mib':receipt['peak_rss_mib'],'summary':summary,'restart_passed':True,'delete_with_stale_vector_passed':True}))
    return 1 if any(s['errors'] or s['scope_leaks'] for s in summary.values()) else 0

if __name__=='__main__':
    raise SystemExit(main())
