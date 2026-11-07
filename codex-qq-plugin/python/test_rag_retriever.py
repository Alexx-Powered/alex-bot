"""Deterministic isolation/lifecycle tests; real semantic evaluation is separate."""
from pathlib import Path
import tempfile
import unittest

from embedding_provider import EmbeddingSpec,EmbeddingError,FastEmbedProvider,checked_vectors
from rag_store import RagStore
from rag_retriever import RagRetriever
from rag_tools import build_rag_tools,explicit_note_request
from vector_index import scope_filter


class StubEmbedding:
    spec=EmbeddingSpec('fixture-unit-vectors','test-only',2)
    def embed_query(self,text):
        return [1.,0.]
    def embed_documents(self,texts):
        return [[1.,0.] for _ in texts]


class StubIndex:
    def __init__(self):
        self.spec=StubEmbedding.spec
        self.rows={}
        self.offline=False
        self.last_scope=None
    def upsert(self,records,vectors):
        if self.offline:raise RuntimeError('private upstream detail')
        self.rows.update({r['record_id']:r for r in records})
    def delete(self,collection,ids):
        if self.offline:raise RuntimeError('private upstream detail')
        for record in ids:self.rows.pop(record,None)
    def search(self,vector,**scope):
        if self.offline:raise RuntimeError('private upstream detail')
        self.last_scope=scope
        # Deliberately hostile: return all namespaces and stale records.
        return [{'record_id':key,'score':0.9} for key in self.rows]


class RagRetrievalTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/'test-output/rag-tests'
        parent.mkdir(parents=True,exist_ok=True)
        self.tmp=tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.tmp.cleanup)
        self.now=1000.
        self.store=RagStore(Path(self.tmp.name)/'rag.sqlite3',clock=lambda:self.now)
        self.index=StubIndex()
        self.rag=RagRetriever(self.store,self.index,StubEmbedding(),clock=lambda:self.now)

    def put(self,namespace='alice',domain='campus',text='三号楼 301 教室有课程占用。',**extra):
        return self.store.put_document(namespace=namespace,domain=domain,title='测试文档',text=text,
            source_ref='fixture:verified-source',**extra)

    def test_cross_scope_and_domain_filtered_against_canonical_store(self):
        own=self.put()
        self.put(namespace='bob')
        self.put(domain='weather')
        shared=self.put(namespace='shared',visibility='shared')
        self.assertEqual(self.rag.process_outbox()['failed'],0)
        result=self.rag.search('教室',namespace='alice',domain='campus',mode='vector')
        self.assertEqual([r['doc_id'] for r in result['evidence']],[own['doc_id']])
        result=self.rag.search('教室',namespace='alice',domain='campus',include_shared=True,mode='vector')
        self.assertEqual({r['doc_id'] for r in result['evidence']},{own['doc_id'],shared['doc_id']})
        self.assertEqual(self.index.last_scope['namespace'],'alice')

    def test_replaced_and_deleted_records_cannot_reappear_from_old_index(self):
        old=self.put(text='旧目标：三号楼。')
        self.rag.process_outbox()
        self.put(text='新目标：主楼。',doc_id=old['doc_id'])
        self.assertEqual(self.rag.search('旧目标',namespace='alice',mode='vector')['evidence'],[])
        latest=self.rag.search('新目标',namespace='alice',mode='lexical')['evidence']
        self.assertEqual(latest[0]['revision'],2)
        self.store.delete_document(old['doc_id'],namespace='alice')
        self.assertEqual(self.rag.validate_evidence(latest,namespace='alice',domain='campus'),[])
        self.assertEqual(self.rag.search('目标',namespace='alice')['evidence'],[])

    def test_expired_and_future_documents_filtered(self):
        self.put(valid_until=1100)
        self.put(text='未来资料',valid_from=1200)
        self.rag.process_outbox()
        self.now=1150
        self.assertEqual(self.rag.search('教室',namespace='alice',mode='vector')['evidence'],[])

    def test_bot_domain_is_shared_knowledge_not_private_project(self):
        bot=self.put(namespace='shared',visibility='shared',domain='bot',text='项目文档：支持云量预报。')
        self.put(namespace='bob',domain='project',project_key='bot',text='个人项目：支持云量预报。')
        tools=build_rag_tools(self.rag,namespace='alice',source='查询机器人资料',source_ref='msg:knowledge',allow_shared=True)
        result=tools['search_domain_knowledge'].invoke({'query':'云量预报','domain':'bot'})
        self.assertEqual([r['doc_id'] for r in result['evidence']],[bot['doc_id']])

    def test_outdoor_knowledge_keeps_scope_and_expiry(self):
        shared=self.put(namespace='shared',visibility='shared',domain='outdoor',
            text='党岭 2025 年历史封闭记录，当前开放情况未知。',valid_until=1100)
        self.put(namespace='bob',domain='project',project_key='党岭',text='党岭 私人行程。')
        self.rag.process_outbox()
        self.assertEqual(self.rag.search('党岭',namespace='alice',domain='outdoor',mode='vector')['evidence'],[])
        tools=build_rag_tools(self.rag,namespace='alice',source='党岭资料',source_ref='msg:outdoor',allow_shared=True)
        result=tools['search_domain_knowledge'].invoke({'query':'党岭','domain':'outdoor'})
        self.assertEqual([r['doc_id'] for r in result['evidence']],[shared['doc_id']])
        self.assertEqual(result['answer_status'],'not_assessed')
        self.now=1100
        self.assertEqual(tools['search_domain_knowledge'].invoke({'query':'党岭','domain':'outdoor'})['evidence'],[])

    def test_index_failure_falls_back_without_disclosing_exception(self):
        self.put()
        self.index.offline=True
        result=self.rag.search('三号楼',namespace='alice')
        self.assertEqual(result['status'],'degraded')
        self.assertTrue(result['evidence'])
        self.assertEqual(result['mode'],'lexical')
        self.assertEqual(result['failed_stage'],'vector')
        self.assertIn('vector_ms',result['timings'])
        self.assertIn('source_verify_ms',result['timings'])
        self.assertNotIn('private upstream',str(result))
        self.assertEqual(self.rag.search('完全无关',namespace='alice')['status'],'unavailable')

    def test_retryable_outbox_survives_failure(self):
        self.put();self.index.offline=True
        self.assertEqual(self.rag.process_outbox()['failed'],1)
        self.assertEqual(len(self.store.pending_events()),1)
        self.index.offline=False
        self.assertEqual(self.rag.process_outbox()['processed'],1)
        self.assertEqual(self.store.pending_events(),[])

    def test_changed_embedding_manifest_is_not_overwritten(self):
        self.put();self.rag.process_outbox()
        before=self.store.get_manifest('knowledge_chunks_v1')
        self.put(text='新资料')
        changed=StubEmbedding();changed.spec=EmbeddingSpec('different-model','new',2)
        index=StubIndex();index.spec=changed.spec
        alternate=RagRetriever(self.store,index,changed,clock=lambda:self.now)
        self.assertEqual(alternate.process_outbox()['failed'],len(self.store.pending_events()))
        self.assertEqual(self.store.get_manifest('knowledge_chunks_v1'),before)

    def test_bound_tools_reject_extra_identity_and_implicit_writes(self):
        tools=build_rag_tools(self.rag,namespace='alice',source='我在做天气助手',source_ref='msg:1',allow_write=True)
        with self.assertRaises(Exception):
            tools['recall_project_notes'].invoke({'query':'项目','namespace':'bob'})
        result=tools['save_project_note'].invoke({'project_key':'天气助手','text':'我在做天气助手'})
        self.assertEqual(result['status'],'denied')
        self.assertEqual(self.store.active_chunks(namespace='alice'),[])

    def test_save_update_and_delete_only_named_current_user_project(self):
        def tools(source,namespace='alice'):
            return build_rag_tools(self.rag,namespace=namespace,source=source,source_ref='msg:bound',allow_write=True)
        saved=tools('保存项目 天气助手：采用 ECMWF 数据。')['save_project_note'].invoke({'project_key':'天气助手','text':'采用 ECMWF 数据。'})
        self.assertEqual(saved['status'],'ok')
        other=tools('保存项目 天气助手：使用另一份资料。','bob')['save_project_note'].invoke({'project_key':'天气助手','text':'使用另一份资料。'})
        updated=tools('更新项目 天气助手：增加云量预报。')['save_project_note'].invoke({'project_key':'天气助手','text':'增加云量预报。'})
        self.assertEqual(updated['revision'],2)
        deleted=tools('删除项目 天气助手')['delete_project_note'].invoke({'project_key':'天气助手'})
        self.assertEqual(deleted['changed'],1)
        self.assertIsNotNone(self.store.get_document(other['doc_id'],namespace='bob'))
        self.assertEqual(self.store.find_project_documents('天气助手',namespace='alice'),[])

    def test_write_requires_exact_grounding_and_unambiguous_intent(self):
        self.assertTrue(explicit_note_request('请保存项目 A：使用观测资料。','A','使用观测资料。'))
        for source,text in [('不要保存项目 A：甲','甲'),('他说：保存项目 A：甲','甲'),('保存项目 A：甲','乙'),('如果下雨，保存项目 A：甲','甲'),('保存项目 A：api_key=secret','api_key=secret')]:
            self.assertFalse(explicit_note_request(source,'A',text))
        self.assertFalse(explicit_note_request('不要删除项目 A','A',delete=True))

    def test_filter_cannot_inject_identity_or_expand_project_scope(self):
        with self.assertRaises(ValueError):scope_filter(namespace='alice" or true',domain='campus')
        expr=scope_filter(namespace='alice',domain='project',include_shared=True,project_key='x" or true',now=1000)
        self.assertNotIn('namespace == "shared"',expr)
        self.assertIn('project_key == "x\\" or true"',expr)

    def test_invalid_vectors_rejected(self):
        for values in [[[0.,0.]],[[float('nan'),1.]],[[1.]],[]]:
            with self.assertRaises(EmbeddingError):checked_vectors(values,1,2)

    def test_local_model_byte_changes_change_index_fingerprint(self):
        cache=Path(self.tmp.name)/'models'
        revision='a'*40
        snapshot=cache/'models--fixture'/ 'snapshots'/revision
        snapshot.mkdir(parents=True)
        (snapshot/'model.onnx').write_bytes(b'model-v1')
        first=FastEmbedProvider('fixture',revision,2,cache)
        (snapshot/'model.onnx').write_bytes(b'model-v2')
        second=FastEmbedProvider('fixture',revision,2,cache)
        self.assertNotEqual(first.spec.fingerprint,second.spec.fingerprint)
        with self.assertRaises(ValueError):FastEmbedProvider('fixture','main',2,cache)


if __name__=='__main__':unittest.main()
