from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import hashlib
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest

from research_queue import ResearchQueue,ResearchQueueError,ResearchQueueBusy,normalize_topic,MAX_BYTES


class ResearchQueueTests(unittest.TestCase):
    def setUp(self):
        root=Path(__file__).resolve().parents[1]/'test-output/research-queue-tests'
        root.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=root);self.path=Path(self.temp.name)/'research.sqlite3'
        self.now=1793941200.0;self.queue=ResearchQueue(self.path,clock=lambda:self.now)

    def tearDown(self):self.temp.cleanup()

    def candidate(self,text='仅供离线测试的公开资料。',**extra):
        return {'url':'https://example.org/haba','title':'哈巴西坡资料','text':text,'fetched_at':self.now,'content_hash':hashlib.sha256(text.encode()).hexdigest(),**extra}

    def run_job(self,topic='哈巴西坡',status='empty',items=None):
        job=self.queue.enqueue(topic);self.assertEqual(job['status'],'queued')
        claimed=self.queue.claim_next();self.assertEqual(claimed['job_id'],job['job_id'])
        self.queue.finish(job['job_id'],{'status':status,'metrics':{'queries':2},'candidates':items or []})
        return job

    def test_normalization_and_rejection(self):
        self.assertEqual(normalize_topic('  Ｈａｂａ  西坡 '),'Haba 西坡')
        for topic in ['哈','哈巴\n西坡','哈巴\t西坡','哈巴2026','https://example.org','a@b.com','哈巴\u200b西坡','--','哈'*33,None]:
            with self.subTest(topic=topic),self.assertRaises(ResearchQueueError):normalize_topic(topic)

    def test_same_topic_queued_running_and_success_reused(self):
        one=self.queue.enqueue('Haba 西坡');two=self.queue.enqueue('haba 西坡')
        self.assertEqual(one['job_id'],two['job_id']);self.assertTrue(two['reused'])
        job=self.queue.claim_next();self.assertEqual(self.queue.enqueue('Haba 西坡')['status'],'running')
        self.queue.finish(job['job_id'],{'status':'completed','metrics':{},'candidates':[self.candidate()]})
        self.assertEqual(self.queue.enqueue('Haba 西坡')['status'],'completed')
        self.now+=24*3600+1
        self.assertNotEqual(self.queue.enqueue('Haba 西坡')['job_id'],job['job_id'])

    def test_negative_cache_for_empty_failed_timeout(self):
        for topic,state in [('空资料','empty'),('错误资料','failed'),('超时资料','timeout')]:
            self.run_job(topic,state)
            self.now+=5*3600
            self.assertEqual(self.queue.enqueue(topic)['status'],state)
            self.now+=3600+1
            self.assertEqual(self.queue.enqueue(topic)['status'],'queued')
            self.now+=601;self.queue.status(topic)

    def test_queue_five_and_daily_twenty(self):
        for suffix in '甲乙丙丁戊':self.assertEqual(self.queue.enqueue('路线'+suffix)['status'],'queued')
        self.assertEqual(self.queue.enqueue('路线己')['error_code'],'RESEARCH_QUEUE_FULL')
        while self.queue.claim_next():
            with closing(sqlite3.connect(self.path)) as db,db:identity=db.execute("SELECT id FROM jobs WHERE status='running'").fetchone()[0]
            self.queue.finish(identity,{'status':'empty','metrics':{},'candidates':[]})
        for suffix in '己庚辛壬癸子丑寅卯辰巳午未申酉':self.run_job('路线'+suffix)
        self.assertEqual(self.queue.enqueue('路线戌')['error_code'],'RESEARCH_DAILY_LIMIT')

    def test_queue_expiration_and_dead_lease_are_terminal(self):
        queued=self.queue.enqueue('积压资料');self.now+=601
        self.assertIsNone(self.queue.claim_next());self.assertEqual(self.queue.status('积压资料')['status'],'cancelled')
        self.assertEqual(self.queue.enqueue('积压资料')['job_id'],queued['job_id'])
        self.queue.enqueue('僵死任务');running=self.queue.claim_next();self.now+=25
        self.assertEqual(self.queue.status('僵死任务')['status'],'timeout')
        with self.assertRaisesRegex(ResearchQueueError,'RESEARCH_JOB_NOT_RUNNING'):
            self.queue.finish(running['job_id'],{'status':'completed','metrics':{},'candidates':[self.candidate()]})
        self.assertEqual(self.queue.candidates('僵死任务'),[])

    def test_late_finish_commits_timeout_even_without_status_poll(self):
        self.queue.enqueue('迟到资料');job=self.queue.claim_next();self.now+=26
        with self.assertRaises(ResearchQueueError):self.queue.finish(job['job_id'],{'status':'empty','metrics':{},'candidates':[]})
        self.assertEqual(self.queue.status('迟到资料')['status'],'timeout')

    def test_one_running_and_concurrent_topic_idempotency(self):
        self.queue.enqueue('预建数据库')
        with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(lambda _:ResearchQueue(self.path,clock=lambda:self.now).enqueue('哈巴西坡'),range(16)))
        identities={r['job_id'] for r in results if r['status']!='busy'}
        self.assertEqual(len(identities),1)
        def claim(_):
            try:return ResearchQueue(self.path,clock=lambda:self.now).claim_next()
            except ResearchQueueBusy:return None
        with ThreadPoolExecutor(max_workers=8) as pool:claims=list(pool.map(claim,range(16)))
        self.assertEqual(len([c for c in claims if c]),1)

    def test_locked_foreground_returns_busy_without_long_wait(self):
        self.queue.enqueue('预建数据库')
        with closing(sqlite3.connect(self.path)) as db,db:
            db.execute('BEGIN IMMEDIATE');start=time.monotonic()
            self.assertEqual(self.queue.enqueue('哈巴西坡')['status'],'busy')
            self.assertLess(time.monotonic()-start,.3)
            self.assertEqual(self.queue.status('哈巴西坡')['status'],'busy')
            with self.assertRaises(ResearchQueueBusy):self.queue.claim_next()

    def test_candidate_quarantine_approval_and_expiry(self):
        self.run_job(status='completed',items=[self.candidate()])
        rows=self.queue.candidates('哈巴西坡');self.assertEqual(len(rows),1);self.assertFalse(rows[0]['trusted'])
        self.assertIsNone(self.queue.approved(rows[0]['id']))
        self.assertNotIn('text',self.queue.status('哈巴西坡'))
        approved=self.queue.approve(rows[0]['id'],'审核后的有限事实。','已核对原文和具体路线范围。')
        self.assertEqual(approved['state'],'approved');self.assertFalse(self.queue.candidates('哈巴西坡')[0]['trusted'])
        reviewed=self.queue.approved(rows[0]['id']);self.assertEqual(reviewed['topic'],'哈巴西坡');self.assertEqual(reviewed['reviewed_at'],self.now)
        self.now+=10
        self.queue.approve(rows[0]['id'],'审核后的有限事实。','已核对原文和具体路线范围。')
        self.assertEqual(self.queue.approved(rows[0]['id'])['reviewed_at'],reviewed['reviewed_at'])
        self.now+=86401;self.assertEqual(self.queue.candidates('哈巴西坡'),[])
        self.assertIsNone(self.queue.approved(rows[0]['id']))
        with self.assertRaisesRegex(ResearchQueueError,'RESEARCH_CANDIDATE_EXPIRED'):self.queue.approve(rows[0]['id'],'摘要','备注')

    def test_invalid_candidates_never_written_and_finish_not_repeatable(self):
        self.queue.enqueue('哈巴西坡');job=self.queue.claim_next()
        for item in [self.candidate(content_hash='0'*64),self.candidate(url='http://example.org:443/'),self.candidate(url='https://127.0.0.1/x'),self.candidate(text='字'*1601),self.candidate(fetched_at=self.now+1000),self.candidate(fetched_at=self.now-86400)]:
            with self.assertRaises(ResearchQueueError):self.queue.finish(job['job_id'],{'status':'completed','metrics':{},'candidates':[item]})
        self.assertEqual(self.queue.candidates('哈巴西坡'),[])
        self.queue.finish(job['job_id'],{'status':'completed','metrics':{},'candidates':[self.candidate(),self.candidate()]})
        self.assertEqual(len(self.queue.candidates('哈巴西坡')),1)
        with self.assertRaises(ResearchQueueError):self.queue.finish(job['job_id'],{'status':'empty','metrics':{},'candidates':[]})

    def test_candidate_capacity_stops_growth(self):
        self.run_job(status='completed',items=[self.candidate()])
        with closing(sqlite3.connect(self.path)) as db,db:
            row=db.execute('SELECT job_id,topic_key FROM candidates').fetchone()
            for i in range(255):db.execute('INSERT INTO candidates(id,job_id,topic_key,url,title,text,fetched_at,expires_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?)',(f'{i:032x}',row[0],row[1],f'https://example.org/{i}','测试','测试',self.now,self.now+86400,'0'*64))
        self.assertEqual(self.queue.enqueue('新增路线')['error_code'],'RESEARCH_CANDIDATES_FULL')
        with closing(sqlite3.connect(self.path)) as db,db:self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0],256)

    def test_database_capacity_and_existing_other_db_refused(self):
        with self.path.open('wb') as f:f.truncate(MAX_BYTES+1)
        self.assertEqual(self.queue.enqueue('新增路线')['error_code'],'RESEARCH_STORAGE_FULL')
        other=Path(self.temp.name)/'other.sqlite3'
        with closing(sqlite3.connect(other)) as db,db:db.execute('CREATE TABLE documents(id TEXT)')
        with self.assertRaisesRegex(ResearchQueueError,'RESEARCH_WRONG_DATABASE'):ResearchQueue(other).enqueue('哈巴西坡')

    def test_metrics_are_bounded_before_json_encoding(self):
        self.queue.enqueue('哈巴西坡');job=self.queue.claim_next()
        for metrics in [{'x':'x'*129},{'x':float('nan')},{'x':{'y':{'z':1}}},{'errors':['X']*9}]:
            with self.assertRaisesRegex(ResearchQueueError,'RESEARCH_INVALID_METRICS'):self.queue.finish(job['job_id'],{'status':'empty','candidates':[],'metrics':metrics})
        self.queue.finish(job['job_id'],{'status':'empty','candidates':[],'metrics':{'errors':['FETCH_UNAVAILABLE'],'search_ms':12.5}})

    def test_public_http_source_is_preserved_as_candidate_not_rewritten(self):
        self.run_job(status='completed',items=[self.candidate(url='http://m.gmw.cn/2026-11/06/content.htm')])
        self.assertEqual(self.queue.candidates('哈巴西坡')[0]['url'],'http://m.gmw.cn/2026-11/06/content.htm')

    def test_sqlite_page_limit_prevents_database_growth(self):
        self.queue.enqueue('哈巴西坡')
        with self.queue._transaction() as db:
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0],'delete')
            self.assertLessEqual(db.execute('PRAGMA max_page_count').fetchone()[0]*db.execute('PRAGMA page_size').fetchone()[0],MAX_BYTES)
        with self.assertRaisesRegex(ResearchQueueError,'RESEARCH_STORAGE_FULL'):
            with self.queue._transaction() as db:
                db.execute('CREATE TABLE capacity_test(value BLOB)')
                db.execute('INSERT INTO capacity_test VALUES(zeroblob(?))',(MAX_BYTES,))
        self.assertLessEqual(self.path.stat().st_size,MAX_BYTES)

    def test_full_expired_candidate_store_reopens_with_bounded_cleanup(self):
        self.run_job(status='completed',items=[self.candidate()])
        with closing(sqlite3.connect(self.path)) as db,db:
            row=db.execute('SELECT job_id,topic_key FROM candidates').fetchone()
            db.execute('UPDATE candidates SET expires_at=?',(self.now-1,))
            for i in range(255):db.execute('INSERT INTO candidates(id,job_id,topic_key,url,title,text,fetched_at,expires_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?)',
                (f'{i:032x}',row[0],row[1],f'https://example.org/{i}','测试','测试',self.now-86401,self.now-1,'0'*64))
        self.assertEqual(self.queue.enqueue('新增路线')['status'],'queued')
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0],240)
        job=self.queue.claim_next();self.queue.finish(job['job_id'],{'status':'empty','metrics':{},'candidates':[]})
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0],224)

    def test_prune_preserves_fresh_and_seven_day_approval_audit(self):
        self.run_job(status='completed',items=[self.candidate()])
        candidate=self.queue.candidates('哈巴西坡')[0]
        self.assertEqual(self.queue.prune()['candidates_removed'],0)
        self.queue.approve(candidate['id'],'已核对的摘要','核对了来源日期与范围')
        self.now+=86401
        self.assertEqual(self.queue.prune()['candidates_removed'],0)
        with closing(sqlite3.connect(self.path)) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM candidates').fetchone()[0],1)
        self.now+=6*86400
        self.assertEqual(self.queue.prune()['candidates_removed'],1)
        for limit in [0,17,True,1.5]:
            with self.assertRaisesRegex(ResearchQueueError,'RESEARCH_INVALID_PRUNE_LIMIT'):self.queue.prune(limit)

    def test_old_terminal_jobs_pruned_without_touching_today_or_references(self):
        old=self.run_job('历史任务')
        self.run_job('保留审核资料',status='completed',items=[self.candidate()])
        candidate=self.queue.candidates('保留审核资料')[0]
        self.now+=31*86400
        # A recent review preserves the expired source's audit row and parent.
        with closing(sqlite3.connect(self.path)) as db,db:
            db.execute("UPDATE candidates SET state='approved',approved_at=? WHERE id=?",(self.now,candidate['id']))
        current=self.queue.enqueue('今日任务')
        with closing(sqlite3.connect(self.path)) as db:
            ids={row[0] for row in db.execute('SELECT id FROM jobs')}
            self.assertNotIn(old['job_id'],ids)
            self.assertIn(current['job_id'],ids)
            self.assertIn(candidate['job_id'],ids)
        self.assertEqual(self.queue.status('今日任务')['status'],'queued')


if __name__=='__main__':unittest.main()
