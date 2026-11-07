import base64
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from rag_store import RagStore
from climate_history import ClimateHistory,ClimateLocation

spec=importlib.util.spec_from_file_location('operator_rag_backup',Path(__file__).resolve().parents[1]/'ops/rag_backup.py')
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)/'source';self.private=self.root/'.private'
        self.private.mkdir(parents=True)
        self.store_path=self.private/'rag/source.sqlite3'
        self.climate_path=self.private/'rag/climate.sqlite3'
        self.config_path=self.private/'rag-config.json'
        self.store=RagStore(self.store_path)
        self.shared=self.store.put_document(namespace='shared',domain='outdoor',visibility='shared',title='公开路线',text='公开路线的湖泊背景',source_ref='https://example.org/route')
        self.private_doc=self.store.put_document(namespace='owner-a',domain='project',title='独立项目',text='甲的私有项目记录',source_ref='request:fixture',project_key='test')
        climate=ClimateHistory(self.climate_path)
        with climate._db(write=True) as db: climate._place(db,ClimateLocation('sample',30,100))
        self.config={'enabled':True,'store_path':str(self.store_path),'vector':{'uri':str(self.private/'rag/vectors.db')},
                     'embedding':{'provider':'fastembed','cache_dir':'/opt/read-only-model'},
                     'outdoor':{'climate_path':str(self.climate_path),'locations':[]}}
        self.save_config()

    def save_config(self): self.config_path.write_text(json.dumps(self.config),encoding='utf-8')
    def snapshot(self): return backup.snapshot(self.root,self.config_path)['files']

    def test_roundtrip_preserves_scope_and_rewrites_paths_without_vector(self):
        files=self.snapshot();result=backup.verify(files)
        self.assertTrue(result['scope_verified']);self.assertEqual(result['databases']['rag']['shared_documents'],1)
        self.assertEqual(result['databases']['rag']['private_documents'],1)
        self.assertFalse(any('vectors' in name or 'model' in name for name in files))
        destination=Path(self.temp.name)/'restore'
        restored=backup.restore(files,destination)
        config=json.loads(Path(restored['config_path']).read_text(encoding='utf-8'))
        self.assertNotIn('vector',config);self.assertNotIn('cache_dir',config['embedding'])
        self.assertEqual(config['store_path'],str(destination/'.private/rag/source.sqlite3'))
        store=RagStore(config['store_path'])
        self.assertEqual(len(store.resolve_chunks(self.shared['chunk_ids'],namespace='owner-b',include_shared=True)),1)
        self.assertEqual(store.resolve_chunks(self.private_doc['chunk_ids'],namespace='owner-b',include_shared=True),[])
        self.assertEqual(len(store.resolve_chunks(self.private_doc['chunk_ids'],namespace='owner-a')),1)
        self.assertTrue(Path(config['outdoor']['climate_path']).is_file())
        with self.assertRaisesRegex(ValueError,'RAG_RESTORE_NOT_EMPTY'): backup.restore(files,destination)

    def test_snapshot_includes_committed_wal_not_uncommitted_transaction(self):
        with closing(sqlite3.connect(self.store_path)) as writer:
            writer.execute('PRAGMA journal_mode=WAL')
            writer.execute("UPDATE rag_documents SET title='已提交标题' WHERE visibility='shared'");writer.commit()
            writer.execute("UPDATE rag_documents SET title='未提交标题' WHERE visibility='shared'")
            files=self.snapshot();backup.verify(files)
            raw=base64.b64decode(files['.private/rag/source.sqlite3'])
            with closing(sqlite3.connect(':memory:')) as db:
                db.deserialize(raw)
                self.assertEqual(db.execute("SELECT title FROM rag_documents WHERE visibility='shared'").fetchone()[0],'已提交标题')
            writer.rollback()

    def test_default_fallback_and_absent_optional_config(self):
        with patch.dict('os.environ',{},clear=True):
            self.assertTrue(backup.snapshot(self.root)['included'])
            self.assertEqual(backup.snapshot(Path(self.temp.name)/'unconfigured'),{'files':{},'included':False})
        self.config['store_path']=str(self.private/'missing.sqlite3');self.save_config()
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_MISSING'): self.snapshot()

    def test_research_queue_roundtrip_and_missing_database_fails_closed(self):
        from research_queue import ResearchQueue
        queue_path=self.private/'research/queue.sqlite3'
        queue=ResearchQueue(queue_path)
        queued=queue.enqueue('哈巴西坡')
        self.config['research']={'enabled':True,'queue_path':str(queue_path)};self.save_config()
        files=self.snapshot();checked=backup.verify(files)
        self.assertEqual(checked['databases']['research'],{'jobs':1,'candidates':0,'approved':0})
        destination=Path(self.temp.name)/'restored-research'
        restored=backup.restore(files,destination)
        config=json.loads(Path(restored['config_path']).read_text(encoding='utf-8'))
        self.assertFalse(config['research']['enabled'])
        self.assertEqual(ResearchQueue(config['research']['queue_path']).status('哈巴西坡')['job_id'],queued['job_id'])
        self.config['research']['queue_path']=str(self.private/'research/missing.sqlite3');self.save_config()
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_MISSING'):self.snapshot()

    def test_rejects_external_paths_and_symbolic_links(self):
        self.config['store_path']=str(Path(self.temp.name)/'outside.sqlite3');self.save_config()
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_PATH'): self.snapshot()
        self.config['store_path']=str(self.private/'rag/../rag/source.sqlite3');self.save_config()
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_PATH'): self.snapshot()
        self.config['store_path']=str(self.store_path);self.save_config()
        alias=self.private/'linked.json'
        try: alias.symlink_to(self.config_path)
        except OSError: return
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_PATH'): backup.snapshot(self.root,alias)

    def test_digest_and_scope_validation_are_independent(self):
        files=self.snapshot();name='.private/rag/source.sqlite3'
        raw=bytearray(base64.b64decode(files[name]));raw[-1]^=1
        files[name]=base64.b64encode(raw).decode()
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_INTEGRITY'): backup.verify(files)
        with closing(sqlite3.connect(self.store_path)) as db:
            db.execute("UPDATE rag_documents SET namespace='private-person' WHERE visibility='shared'");db.commit()
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_SCOPE'): self.snapshot()

    def test_manifest_config_path_binding_and_capacity(self):
        files=self.snapshot();manifest=json.loads(base64.b64decode(files[backup.MANIFEST]))
        name=manifest['entries']['config']['name']
        config=json.loads(base64.b64decode(files[name]));config['store_path']=str(self.private/'different.sqlite3')
        raw=json.dumps(config).encode();files[name]=backup.encode(raw)
        manifest['entries']['config'].update(bytes=len(raw),sha256=backup.digest(raw))
        files[backup.MANIFEST]=backup.encode(json.dumps(manifest).encode())
        with self.assertRaisesRegex(ValueError,'RAG_BACKUP_PATH'): backup.verify(files)
        with patch.object(backup,'MAX_BYTES',1024):
            with self.assertRaisesRegex(ValueError,'RAG_BACKUP_CAPACITY'): self.snapshot()

    def test_linux_packet_paths_verify_and_restore_on_developer_host(self):
        files=self.snapshot();manifest=json.loads(base64.b64decode(files[backup.MANIFEST]))
        manifest['root']='/var/lib/alexbot'
        name=manifest['entries']['config']['name']
        config=json.loads(base64.b64decode(files[name]))
        config['store_path']='/var/lib/alexbot/'+manifest['entries']['rag']['name']
        config['outdoor']['climate_path']='/var/lib/alexbot/'+manifest['entries']['climate']['name']
        raw=json.dumps(config).encode();files[name]=backup.encode(raw)
        manifest['entries']['config'].update(bytes=len(raw),sha256=backup.digest(raw))
        files[backup.MANIFEST]=backup.encode(json.dumps(manifest).encode())
        self.assertTrue(backup.verify(files)['config_paths_verified'])
        destination=Path(self.temp.name)/'linux-packet-restored'
        result=backup.restore(files,destination)
        recovered=json.loads(Path(result['config_path']).read_text(encoding='utf-8'))
        self.assertTrue(Path(recovered['store_path']).is_file())
        self.assertEqual(Path(recovered['store_path']).parent,destination/'.private/rag')


if __name__=='__main__': unittest.main()
