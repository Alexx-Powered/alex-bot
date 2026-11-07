"""The periodic consumer is isolated from foreground answers and formal RAG."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest import mock

from research_queue import ResearchQueue
from research_service import (load_research_config, probe, consume, result_summary,
                              memory_guard, memory_admitted, MIN_AVAILABLE, ResearchServiceError)


class ResearchServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'research' / 'queue.sqlite3'
        self.config = {'enabled': True, 'provider': 'deepseek', 'queue_path': str(self.path)}
        self.config_path = self.root / 'rag-config.json'
        self.config_path.write_text(json.dumps({'enabled': True, 'research': self.config}), encoding='utf-8')

    def test_reads_only_research_config_and_fixed_queue_location(self):
        self.config_path.write_text(json.dumps({'enabled':True,'research':self.config,'store_path':'MUST_NOT_OPEN','vector':{'provider':'milvus'}}), encoding='utf-8')
        self.assertEqual(load_research_config(self.config_path), self.config)
        with self.assertRaisesRegex(ResearchServiceError, 'RESEARCH_CONFIG_INVALID'):
            wrong = {**self.config, 'queue_path':str(self.root/'formal.sqlite3')}
            self.config_path.write_text(json.dumps({'enabled':True,'research':wrong}), encoding='utf-8')
            load_research_config(self.config_path)

    def test_missing_or_disabled_config_performs_no_work(self):
        self.assertEqual(load_research_config(self.root/'missing.json'), {'enabled':False})
        self.config_path.write_text(json.dumps({'enabled':False,'research':self.config}), encoding='utf-8')
        self.assertEqual(load_research_config(self.config_path), {'enabled':False})
        self.assertEqual(consume({'enabled':False},{},admitted=True), {'status':'disabled'})
        self.assertFalse(self.path.exists())

    def test_empty_probe_does_not_create_or_claim(self):
        self.assertEqual(probe(self.config), {'status':'idle'})
        self.assertFalse(self.path.parent.exists())
        queue = ResearchQueue(self.path); queue.enqueue('哈巴西坡')
        before = self.path.read_bytes()
        self.assertEqual(probe(self.config), {'status':'ready'})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(queue.status('哈巴西坡')['status'], 'queued')

    def test_busy_and_expired_jobs_do_not_trigger_network(self):
        queue = ResearchQueue(self.path); queue.enqueue('哈巴西坡'); queue.claim_next()
        self.assertEqual(probe(self.config), {'status':'busy'})
        runner=mock.Mock(side_effect=AssertionError('network'))
        self.assertEqual(consume(self.config, {'api_key':'fake-test-key'}, admitted=True, runner=runner), {'status':'busy'})
        runner.assert_not_called()
        self.assertEqual(probe(self.config, now=time.time()+601), {'status':'idle'})

    def test_probe_wrong_database_is_never_created_as_research(self):
        self.path.parent.mkdir()
        db = sqlite3.connect(self.path)
        try:
            db.execute('CREATE TABLE formal_data (x)')
            db.commit()
        finally:
            db.close()
        self.assertEqual(probe(self.config)['error_code'], 'RESEARCH_WRONG_DATABASE')

    def test_low_memory_and_bad_packet_leave_job_queued(self):
        queue=ResearchQueue(self.path);queue.enqueue('哈巴西坡')
        runner=mock.Mock(side_effect=AssertionError('network'))
        self.assertEqual(consume(self.config,{'api_key':'fake-test-key'},admitted=False,runner=runner)['status'],'low_memory')
        for packet in ({'api_key':'short'}, {'api_key':'fake-test-key','topic':'乌孙古道'}, {'api_key':'fake-test-key','url':'https://example.com'}):
            self.assertEqual(consume(self.config,packet,admitted=True,runner=runner)['status'],'failed')
        runner.assert_not_called()
        self.assertEqual(queue.status('哈巴西坡')['status'],'queued')

    def test_admission_does_not_double_count_this_bounded_service(self):
        self.assertFalse(memory_admitted(MIN_AVAILABLE-1))
        self.assertTrue(memory_admitted(590*1024**2,60*1024**2))
        self.assertFalse(memory_admitted(450*1024**2,128*1024**2))
        self.assertFalse(memory_admitted(590*1024**2,129*1024**2))
        base='/sys/fs/cgroup/system.slice/alexbot-research.service'
        files={'/proc/meminfo':'MemAvailable: 604160 kB\n','/proc/self/cgroup':'0::/system.slice/alexbot-research.service\n',
               base+'/memory.max':str(128*1024**2),base+'/memory.swap.max':'0',base+'/memory.current':str(60*1024**2),base+'/cpu.max':'50000 100000'}
        self.assertFalse(memory_guard(compensate=False,read_text=files.__getitem__))
        self.assertTrue(memory_guard(read_text=files.__getitem__))
        files[base+'/memory.max']='max'
        self.assertFalse(memory_guard(read_text=files.__getitem__))
        files['/proc/self/cgroup']='0::/system.slice/alexbot.service'
        self.assertFalse(memory_guard(read_text=files.__getitem__))

    def test_single_job_failure_is_not_retried_on_next_tick(self):
        queue=ResearchQueue(self.path);queue.enqueue('哈巴西坡')
        failed={'status':'failed','error_code':'HTTP_429','candidates':[],'metrics':{'retries':0}}
        with mock.patch('bounded_research.run_child',return_value=failed) as network:
            result=consume(self.config,{'api_key':'fake-test-key'},admitted=True)
            again=consume(self.config,{'api_key':'fake-test-key'},admitted=True)
        self.assertEqual(result['status'],'failed');self.assertEqual(again['status'],'idle')
        self.assertEqual(network.call_count,1)
        self.assertTrue(queue.enqueue('哈巴西坡')['reused'])

    def test_pending_network_never_holds_foreground_queue_lock(self):
        queue=ResearchQueue(self.path);queue.enqueue('哈巴西坡')
        started=threading.Event();release=threading.Event()
        def slow(_packet):
            started.set();release.wait(2)
            return {'status':'empty','candidates':[],'metrics':{'llm_calls':0}}
        with mock.patch('bounded_research.run_child',side_effect=slow),ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(consume,self.config,{'api_key':'fake-test-key'},admitted=True)
            try:
                self.assertTrue(started.wait(1))
                tick=time.monotonic();result=queue.enqueue('库拉岗日')
                self.assertEqual(result['status'],'queued')
                self.assertLess(time.monotonic()-tick,0.2)
                self.assertEqual(probe(self.config)['status'],'busy')
            finally:
                release.set()
            self.assertEqual(future.result()['status'],'empty')

    def test_sanitized_results_never_print_source_text_or_key(self):
        raw={'status':'completed','candidates':[{'text':'PRIVATE KEY'}], 'api_key':'PRIVATE KEY',
             'metrics':{'total_ms':123,'error':'PRIVATE KEY','full_text':'PRIVATE KEY','llm_calls':0}}
        summary=result_summary(raw)
        self.assertEqual(summary['candidate_count'],1)
        self.assertNotIn('PRIVATE',json.dumps(summary))


if __name__=='__main__':
    unittest.main()
