import json
import tempfile
import time
import unittest
from pathlib import Path

from research_checks import perform_check, prepare_checks
from research_queue import LEASE_SECONDS, ResearchQueue, ResearchQueueError
from research_service import probe
from research_verifier import build_verifier, passage
from rag_store import RagStore


class ResearchVerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.clock=time.time()
        self.queue=ResearchQueue(Path(self.tmp.name)/'queue.sqlite3',clock=lambda:self.clock)
        self.store=RagStore(Path(self.tmp.name)/'rag.sqlite3')
        self.config={'enabled':True,'queue_path':str(self.queue.path)}
        self.source=passage('https://example.org/a','测试山原路返回有明确路书。支线开放日期需要另行核对。','2026-11-01')
        self.c={**self.source,'title':'测试山路线资料','fetched_at':self.clock}
        self.graph=lambda response:build_verifier('offline-key',call=lambda *_:{
            'usage':{'prompt_tokens':20,'completion_tokens':8},'choices':[{'finish_reason':'stop',
            'message':{'content':json.dumps({'decisions':[response]})}}]})

    def start(self):
        self.queue.enqueue('测试山')
        job=self.queue.claim_next()
        checks=prepare_checks('测试山',[self.c],[])
        self.queue.finish(job['job_id'],{'status':'completed','candidates':[self.c],'metrics':{}},checks=checks)
        self.assertEqual(probe(self.config,now=self.clock)['status'],'ready')
        return self.queue.claim_check()

    def test_citation_must_be_exact_and_conflict_needs_distinct_sources(self):
        task={'claims':['测试山目前开放。'],'sources':[self.source]}
        for status,quote,want in [('supported','这段连续原文实际不存在','pending'),('conflicting',self.c['text'],'pending'),
                                  ('insufficient',self.c['text'],'insufficient')]:
            result=self.graph({'status':status,'citations':[{'source':1,'quote':quote}]}).invoke(task)
            self.assertEqual(result['status'],want)
            self.assertEqual(result['metrics']['prompt_tokens'],20)

    def test_changed_evidence_and_provider_failure_never_approve(self):
        calls=[]
        def timeout(*args):
            calls.append(1)
            raise TimeoutError()
        graph=build_verifier('offline-key',call=timeout)
        task={'claims':['测试山目前开放。'],'sources':[{**self.source,'text':'已经修改的材料'}]}
        self.assertEqual(graph.invoke(task)['status'],'pending')
        self.assertEqual(calls,[])
        task['sources']=[self.source]
        self.assertEqual(graph.invoke(task)['status'],'pending')
        self.assertEqual(calls,[1])

    def test_unrelated_quote_cannot_pass_into_shared_results(self):
        task=self.start()
        graph=self.graph({'status':'supported','citations':[{'source':1,'quote':'支线开放日期需要另行核对'}]})
        perform_check(self.queue,task,self.store,'fixture',verifier=graph)
        self.assertIsNone(self.queue.claim_check())
        self.assertEqual(self.queue.candidates('测试山')[0]['check_state'],'insufficient')
        self.assertFalse(self.store.active_chunks(namespace='test',domain='outdoor',include_shared=True))

    def test_lost_billable_lease_is_not_resubmitted(self):
        task=self.start()
        self.clock+=LEASE_SECONDS+1
        self.assertIsNone(self.queue.claim_check())
        with self.assertRaises(ResearchQueueError):
            self.queue.advance_check(task,'ready',{'status':'supported'})
        self.assertEqual(self.queue.candidates('测试山')[0]['check_state'],'pending')

    def test_repeated_dead_publications_stop_without_rebilling(self):
        task=self.start()
        graph=self.graph({'status':'supported','citations':[{'source':1,'quote':self.c['text']}]})
        perform_check(self.queue,task,self.store,'fixture',verifier=graph)
        for i in range(1,4):
            task=self.queue.claim_check()
            self.assertEqual(task['state'],'publishing')
            self.assertEqual(task['receipt']['publish_attempts'],i)
            self.clock+=LEASE_SECONDS+1
        self.assertIsNone(self.queue.claim_check())
        self.assertEqual(self.queue.candidates('测试山')[0]['check_state'],'pending')

    def test_interrupted_publication_reuses_receipt_and_stable_id(self):
        from datetime import datetime, timezone
        self.c['fetched_at']=datetime.fromtimestamp(self.clock,timezone.utc).isoformat()
        task=self.start()
        graph=self.graph({'status':'supported','citations':[{'source':1,'quote':self.c['text']}]})
        perform_check(self.queue,task,self.store,'fixture',verifier=graph)
        publishing=self.queue.claim_check()
        self.assertEqual(publishing['state'],'publishing')
        self.clock+=LEASE_SECONDS+1
        recovered=self.queue.claim_check()
        self.assertEqual(recovered['receipt']['evidence'],publishing['receipt']['evidence'])
        self.assertEqual(recovered['receipt']['publish_attempts'],2)
        with self.assertRaises(ResearchQueueError):
            perform_check(self.queue,publishing,self.store,'fixture')
        self.assertFalse(self.store.active_chunks(namespace='test',domain='outdoor',include_shared=True))
        perform_check(self.queue,recovered,self.store,'fixture')
        self.assertIsNone(self.queue.claim_check())
        chunks=self.store.active_chunks(namespace='test',domain='outdoor',include_shared=True)
        self.assertEqual(len({r['doc_id'] for r in chunks}),1)
        self.assertTrue(chunks[0]['doc_id'].startswith('research-checked-'))
