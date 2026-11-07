import json
from pathlib import Path
import tempfile
import unittest

from rag_store import RagStore, RagStoreError, split_text
from knowledge_ingest import ingest_file


class RagStoreTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/'test-output/rag-store-tests'
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent)
        self.root=Path(self.temp.name)
        self.now=1000
        self.store=RagStore(self.root/'rag.sqlite3',clock=lambda:self.now)

    def tearDown(self):
        self.temp.cleanup()

    def put(self,doc_id='classroom',**overrides):
        args=dict(doc_id=doc_id,namespace='shared',visibility='shared',domain='campus',
            title='测试校园资料',text='测试教室 302 仅供离线验证，不代表真实设施。',source_ref='fixture://campus/302')
        args.update(overrides)
        return self.store.put_document(**args)

    def test_idempotent_import_and_restart(self):
        first=self.put(); same=self.put()
        self.assertEqual(first['chunk_ids'],same['chunk_ids'])
        self.assertFalse(same['changed'])
        restarted=RagStore(self.store.path,clock=lambda:self.now)
        self.assertEqual(len(restarted.lexical_search('302',namespace='alice',include_shared=True)),1)
        self.assertEqual(len(restarted.pending_events()),1)

    def test_scopes_applied_before_results(self):
        shared=self.put()
        private=self.put('alice-note',namespace='alice',visibility='private',domain='project',project_key='demo')
        foreign=self.put('bob-note',namespace='bob',visibility='private',domain='project',project_key='demo')
        ids=shared['chunk_ids']+private['chunk_ids']+foreign['chunk_ids']
        self.assertEqual([r['doc_id'] for r in self.store.resolve_chunks(ids,namespace='alice')],['alice-note'])
        self.assertEqual({r['doc_id'] for r in self.store.resolve_chunks(ids,namespace='alice',include_shared=True)}, {'classroom','alice-note'})
        self.assertEqual(self.store.find_project_documents('demo',namespace='alice')[0]['doc_id'],'alice-note')
        self.assertIsNone(self.store.get_document('bob-note',namespace='alice'))
        self.assertFalse(self.store.delete_document('bob-note',namespace='alice'))
        with self.assertRaises(RagStoreError):
            self.put('bob-note',namespace='alice',visibility='private')

    def test_revision_and_delete_hide_stale_vectors_immediately(self):
        original=self.put()
        new=self.put(text='新版测试教室 303，旧资料已被替代。')
        self.assertEqual(new['revision'],2)
        self.assertEqual(self.store.resolve_chunks(original['chunk_ids'],namespace='alice',include_shared=True),[])
        self.assertTrue(self.store.resolve_chunks(new['chunk_ids'],namespace='alice',include_shared=True))
        self.assertTrue(self.store.delete_document('classroom',namespace='shared'))
        self.assertFalse(self.store.delete_document('classroom',namespace='shared'))
        self.assertEqual(self.store.resolve_chunks(new['chunk_ids'],namespace='alice',include_shared=True),[])
        self.assertTrue(all(e['operation']=='delete' for e in self.store.pending_events()))

    def test_future_and_expired_data_are_not_evidence(self):
        self.put('future',valid_from=1100)
        self.put('expired',valid_until=999)
        self.put('live',valid_until=1100)
        self.assertEqual([r['doc_id'] for r in self.store.active_chunks(namespace='alice',include_shared=True)],['live'])
        self.now=1100
        self.assertEqual([r['doc_id'] for r in self.store.active_chunks(namespace='alice',include_shared=True)],['future'])

    def test_late_index_ack_does_not_remove_new_delete(self):
        self.put()
        old=self.store.pending_events()[0]
        self.store.delete_document('classroom',namespace='shared')
        self.assertFalse(self.store.complete_event(old['event_id']))
        self.assertEqual(self.store.pending_events()[0]['operation'],'delete')

    def test_bounded_retry_and_requeue(self):
        self.put()
        old=self.store.pending_events()[0]
        for _ in range(3):self.store.fail_event(old['event_id'])
        self.assertEqual(self.store.pending_events(),[])
        self.assertEqual(self.store.outbox_summary(),{'failed':1})
        self.store.requeue_all()
        new=self.store.pending_events()[0]
        self.assertNotEqual(new['event_id'],old['event_id'])
        self.assertEqual(new['attempts'],0)
        self.store.delete_document('classroom',namespace='shared')
        tombstone=self.store.pending_events()[0]
        for _ in range(3):self.store.fail_event(tombstone['event_id'])
        self.assertEqual(self.store.pending_events(),[])
        self.store.requeue_all()
        retried=self.store.pending_events()[0]
        self.assertEqual(retried['operation'],'delete')
        self.assertIsNone(retried['record'])

    def test_outbox_capacity_rolls_back_source_transaction(self):
        self.store=RagStore(self.root/'small.sqlite3',clock=lambda:self.now,max_outbox=1)
        self.put()
        with self.assertRaisesRegex(RagStoreError,'RAG_OUTBOX_CAPACITY'):
            self.put(text='替换版本')
        self.assertEqual(self.store.get_document('classroom',namespace='shared')['revision'],1)
        self.assertEqual(self.store.pending_events()[0]['operation'],'upsert')

    def test_delete_remains_effective_when_outbox_full(self):
        self.store=RagStore(self.root/'delete-full.sqlite3',clock=lambda:self.now,max_outbox=1)
        original=self.put('first')
        self.store.complete_event(self.store.pending_events()[0]['event_id'])
        self.put('second')
        self.assertTrue(self.store.delete_document('first',namespace='shared'))
        self.assertEqual(self.store.resolve_chunks(original['chunk_ids'],namespace='alice',include_shared=True),[])
        self.assertEqual(self.store.outbox_summary(),{'pending':1,'deferred_deletes':1})
        # Deferred cleanup survives restart and is refilled after the other event.
        restarted=RagStore(self.store.path,clock=lambda:self.now,max_outbox=1)
        event=restarted.pending_events()[0]
        self.assertEqual(event['doc_id'],'second')
        restarted.complete_event(event['event_id'])
        cleanup=restarted.pending_events()[0]
        self.assertEqual((cleanup['doc_id'],cleanup['operation']),('first','delete'))
        restarted.complete_event(cleanup['event_id'])
        self.assertEqual(restarted.pending_events(),[])
        self.assertEqual(restarted.outbox_summary(),{})

    def test_clear_notes_is_scoped_atomic_and_includes_expired(self):
        shared=self.put('shared-data')
        bob=self.put('bob-project',namespace='bob',visibility='private',domain='project',project_key='demo')
        alice=self.put('alice-project',namespace='alice',visibility='private',domain='project',project_key='demo')
        expired=self.put('alice-expired',namespace='alice',visibility='private',domain='project',valid_until=900)
        self.assertEqual(self.store.clear_project_notes(namespace='alice'),2)
        self.assertEqual(self.store.clear_project_notes(namespace='alice'),0)
        self.assertEqual(self.store.resolve_chunks(alice['chunk_ids']+expired['chunk_ids'],namespace='alice'),[])
        self.assertEqual(self.store.get_document('alice-expired',namespace='alice')['status'],'deleted')
        self.assertEqual(len(self.store.resolve_chunks(bob['chunk_ids'],namespace='bob')),1)
        self.assertEqual(len(self.store.resolve_chunks(shared['chunk_ids'],namespace='alice',include_shared=True)),1)

    def test_chinese_bigrams_and_exact_classroom_number(self):
        self.put('room302')
        self.put('room1302',text='测试教室 1302 不是 302 的子串替代品。')
        self.put('only1302',text='测试教室 1302，应该排除。')
        found=self.store.lexical_search('302教室',namespace='alice',include_shared=True)
        self.assertNotIn('only1302',[r['doc_id'] for r in found])
        self.assertIn('room302',[r['doc_id'] for r in found])
        self.assertEqual(self.store.lexical_search('xylophone',namespace='alice',include_shared=True),[])

    def test_scope_injection_and_shared_projects_rejected(self):
        self.put()
        with self.assertRaises(RagStoreError):
            self.store.active_chunks(namespace="alice' OR 1=1 --")
        with self.assertRaises(RagStoreError):self.put(domain='project')
        with self.assertRaises(RagStoreError):self.put(namespace='alice',visibility='shared')
        with self.assertRaises(RagStoreError):self.store.resolve_chunks([],namespace='shared')
        bot=self.put('bot-rules',domain='bot',text='公开功能说明仅用于知识查询。')
        self.assertEqual(len(self.store.resolve_chunks(bot['chunk_ids'],namespace='alice',domain='bot',include_shared=True)),1)
        self.assertEqual(self.store.resolve_chunks(bot['chunk_ids'],namespace='alice',domain='project',include_shared=True),[])

    def test_backup_restores_source_and_pending_index_work(self):
        self.put()
        self.store.save_manifest('knowledge_chunks_v1',embedding_model='test-model',embedding_revision='v1',dimension=4)
        backup=self.root/'backup.sqlite3';self.store.backup_to(backup)
        restored=RagStore(backup,clock=lambda:self.now)
        self.assertEqual(restored.get_manifest('knowledge_chunks_v1')['dimension'],4)
        self.assertEqual(len(restored.pending_events()),1)
        self.assertEqual(len(restored.active_chunks(namespace='alice',include_shared=True)),1)
        with self.assertRaises(RagStoreError):self.store.backup_to(backup)

    def test_import_requires_selected_root_and_scope(self):
        fixture=self.root/'input.json'
        doc=dict(doc_id='fixture',namespace='shared',visibility='shared',domain='campus',title='测试资料',text='教学区入口。',source_ref='fixture://test')
        fixture.write_text(json.dumps({'schema_version':'rag.import.v1','documents':[doc]},ensure_ascii=False),encoding='utf-8')
        with self.assertRaises(RagStoreError):ingest_file(self.store,fixture,allowed_roots=[self.root/'other'])
        result=ingest_file(self.store,fixture,allowed_roots=[self.root])
        self.assertTrue(result[0]['changed'])
        self.assertFalse(ingest_file(self.store,fixture,allowed_roots=[self.root])[0]['changed'])
        doc.update(namespace='bob',visibility='private')
        fixture.write_text(json.dumps({'schema_version':'rag.import.v1','documents':[doc]}),encoding='utf-8')
        with self.assertRaises(RagStoreError):ingest_file(self.store,fixture,allowed_roots=[self.root])

    def test_chunking_preserves_complete_long_rule(self):
        rule='如果下雨则关闭，除非管理员明确允许。'*80
        chunks=split_text('标题\n\n'+rule+'\n\n末尾说明')
        self.assertIn(rule,chunks)
        with self.assertRaisesRegex(RagStoreError,'RAG_CHUNK_TOO_LARGE'):
            self.put(text='长'*6001)
        self.assertIsNone(self.store.get_document('classroom',namespace='shared'))


if __name__=='__main__':
    unittest.main()
