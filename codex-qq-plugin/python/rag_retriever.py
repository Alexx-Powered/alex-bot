"""Bounded hybrid retrieval, canonical evidence checks and resumable indexing."""
from __future__ import annotations

import time
from rag_store import title_phrase_score
from vector_index import collection_for, scope_filter

SCHEMA='rag.observation.v1'
EVIDENCE_FIELDS=('record_id','chunk_id','doc_id','revision','text','title','source_ref','domain','project_key','valid_from','valid_until','content_hash')


def observation(status,*,evidence=None,error_code=None,missing_fields=None,timings=None,mode='lexical',**extra):
    return dict(schema_version=SCHEMA,status=status,evidence=evidence or [],error_code=error_code,
        missing_fields=missing_fields or [],timings=timings or {},mode=mode,**extra)


class RagRetriever:
    def __init__(self,store,index=None,embedding=None,*,clock=time.time,min_score=0.45):
        if (index is None)!=(embedding is None):
            raise ValueError('RAG_VECTOR_CONFIG_INCOMPLETE')
        if index is not None and index.spec.fingerprint!=embedding.spec.fingerprint:
            raise ValueError('RAG_EMBEDDING_MISMATCH')
        if not -1<=min_score<=1:
            raise ValueError('RAG_SCORE_INVALID')
        self.store,self.index,self.embedding,self.clock,self.min_score=store,index,embedding,clock,min_score

    def validate_evidence(self,evidence,*,namespace,domain,include_shared=False,project_key=None):
        ids=[row['record_id'] for row in evidence if isinstance(row,dict) and 'record_id' in row][:32]
        if not ids:
            return []
        rows=self.store.resolve_chunks(ids,namespace=namespace,domain=domain,include_shared=include_shared,project_key=project_key)
        by_id={row['record_id']:row for row in rows}
        return [{key:by_id[record].get(key) for key in EVIDENCE_FIELDS} for record in ids if record in by_id]

    def search(self,query,*,namespace,domain='campus',include_shared=False,project_key=None,limit=4,mode='hybrid'):
        if not isinstance(query,str) or not query.strip() or len(query)>1000 or isinstance(limit,bool) or not isinstance(limit,int) or not 1<=limit<=12:
            raise ValueError('RAG_QUERY_INVALID')
        if mode not in {'hybrid','lexical','vector'}:
            raise ValueError('RAG_SEARCH_MODE_INVALID')
        # Validate at the shared boundary before accessing either store.
        scope_filter(namespace=namespace,domain=domain,include_shared=include_shared,project_key=project_key,now=self.clock())
        if domain=='project':
            include_shared=False
        start=time.perf_counter(); timings={};error=None; failed_stage=None; ranks={}; title_matches={}
        scope=dict(namespace=namespace,domain=domain,include_shared=include_shared,project_key=project_key)
        lexical=[];vector=[]
        if mode!='vector':
            tick=time.perf_counter()
            try:
                lexical=self.store.lexical_search(query,**scope,limit=12)
            except Exception:
                timings['lexical_ms']=round((time.perf_counter()-tick)*1000,3)
                timings['total_ms']=round((time.perf_counter()-start)*1000,3)
                return observation('unavailable',error_code='RAG_STORE_UNAVAILABLE',missing_fields=['supporting_evidence'],timings=timings,failed_stage='lexical')
            timings['lexical_ms']=round((time.perf_counter()-tick)*1000,3)
        if mode!='lexical':
            if self.index is None:
                error='RAG_VECTOR_NOT_CONFIGURED'
            else:
                stage='embedding'
                try:
                    tick=time.perf_counter()
                    try:
                        values=self.embedding.embed_query(query)
                    finally:
                        timings['embedding_ms']=round((time.perf_counter()-tick)*1000,3)
                    stage='vector'
                    tick=time.perf_counter()
                    try:
                        hits=self.index.search(values,**scope,now=self.clock(),limit=12)
                    finally:
                        timings['vector_ms']=round((time.perf_counter()-tick)*1000,3)
                    stage='source_verify'
                    ids=[hit['record_id'] for hit in hits if hit['score']>=self.min_score]
                    tick=time.perf_counter()
                    try:
                        visible=self.store.resolve_chunks(ids,**scope) if ids else []
                    finally:
                        timings['source_verify_ms']=round((time.perf_counter()-tick)*1000,3)
                    canonical={row['record_id']:row for row in visible}
                    vector=[canonical[key] for key in ids if key in canonical]
                except Exception as exc:
                    failed_stage=stage
                    code=str(exc)
                    error=code if code in {'RAG_INDEX_MANIFEST_MISMATCH','EMBEDDING_DIMENSION_MISMATCH','RAG_EMBEDDING_MISMATCH'} else 'RAG_VECTOR_UNAVAILABLE'
        for candidates in [lexical,vector]:
            for rank,row in enumerate(candidates,1):
                key=row['record_id']
                ranks[key]=ranks.get(key,0)+1/(60+rank)
                # Both lists contain canonical, scoped rows. Carry the exact
                # subject signal through fusion so two generic-channel matches
                # cannot drown a specifically requested place or route.
                title_matches[key]=title_phrase_score(query,row['title'])
        selected=[{'record_id':key} for key in sorted(ranks,key=lambda key:(-title_matches[key],-ranks[key],key))[:limit]]
        # A delete or revision update can occur while embedding/search runs.
        tick=time.perf_counter()
        try:
            evidence=self.validate_evidence(selected,**scope)
        except Exception:
            evidence=[];error='RAG_STORE_UNAVAILABLE';failed_stage='source_verify'
        finally:
            timings['source_verify_ms']=round(timings.get('source_verify_ms',0)+(time.perf_counter()-tick)*1000,3)
        timings['total_ms']=round((time.perf_counter()-start)*1000,3)
        status=('degraded' if evidence else 'unavailable') if error else ('ok' if evidence else 'empty')
        missing=['semantic_index'] if error else []
        if not evidence:
            missing.append('supporting_evidence')
        actual_mode='lexical' if mode=='lexical' or error else mode
        return observation(status,evidence=evidence,error_code=error,missing_fields=missing,timings=timings,mode=actual_mode,failed_stage=failed_stage,
            answer_status='not_assessed')

    def process_outbox(self,*,limit=32):
        """Run explicitly in the index worker, never as a foreground query side effect."""
        if isinstance(limit,bool) or not isinstance(limit,int) or not 1<=limit<=32:
            raise ValueError('RAG_LIMIT_INVALID')
        if self.index is None:
            return {'processed':0,'failed':0,'error_code':'RAG_VECTOR_NOT_CONFIGURED'}
        events=self.store.pending_events(limit=limit)
        processed=failed=0
        for event in events:
            try:
                collection=event['target_collection']
                spec=self.embedding.spec
                manifest=self.store.get_manifest(collection)
                if manifest and (manifest['embedding_model'],manifest['embedding_revision'],manifest['dimension'])!=(spec.model_id,spec.revision,spec.dimension):
                    raise ValueError('RAG_INDEX_MANIFEST_MISMATCH')
                if event['operation']=='delete' or event.get('record') is None:
                    self.index.delete(collection,[event['record_id']])
                else:
                    record=event['record']
                    if collection!=collection_for(record['domain']):
                        raise ValueError('RAG_INDEX_TARGET_INVALID')
                    self.index.upsert([record],self.embedding.embed_documents([record['text']]))
                self.store.save_manifest(collection,embedding_model=spec.model_id,embedding_revision=spec.revision,
                    dimension=spec.dimension,source_watermark=str(event['event_id']))
                self.store.complete_event(event['event_id']);processed+=1
            except Exception:
                self.store.fail_event(event['event_id'],code='RAG_INDEX_WRITE_FAILED');failed+=1
        return {'processed':processed,'failed':failed,'error_code':'RAG_INDEX_WRITE_FAILED' if failed else None}
