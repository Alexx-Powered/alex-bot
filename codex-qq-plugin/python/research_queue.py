"""Bounded research spool; public candidates only, never a RAG/Milvus writer.

The foreground only enqueues a normalized public topic. An independent bounded
worker claims one lease; expired work is terminal, not automatically retried.
This module deliberately has no network, model, embedding or message imports.
"""
from contextlib import contextmanager
from datetime import datetime
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import re
import sqlite3
import time
import unicodedata
from urllib.parse import urlsplit
from uuid import uuid4

MAX_BYTES = 4 * 1024 * 1024
MAX_CANDIDATES = 256
APPLICATION_ID = 0x52455155
BUSY_MS = 30
SUCCESS_TTL = 24 * 3600
NEGATIVE_TTL = 6 * 3600
QUEUE_TTL = 600
LEASE_SECONDS = 25
APPROVAL_RETENTION = 7 * 86400
JOB_RETENTION = 30 * 86400


class ResearchQueueError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class ResearchQueueBusy(ResearchQueueError):
    status = 'busy'
    def __init__(self):
        super().__init__('RESEARCH_QUEUE_BUSY')


def normalize_topic(topic):
    if not isinstance(topic, str) or any(unicodedata.category(c).startswith('C') for c in topic):
        raise ResearchQueueError('RESEARCH_INVALID_TOPIC')
    topic = ' '.join(unicodedata.normalize('NFKC', topic).strip().split(' '))
    topic = re.sub(' +', ' ', topic)
    if not re.fullmatch(r'[A-Za-z\u4e00-\u9fff ·-]{2,32}', topic) or not re.search(r'[A-Za-z\u4e00-\u9fff]', topic):
        raise ResearchQueueError('RESEARCH_INVALID_TOPIC')
    return topic


def _key(topic):
    return hashlib.sha256(topic.casefold().encode('utf-8')).hexdigest()


def _text(value, maximum, code, multiline=False):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ResearchQueueError(code)
    allowed = '\n\r\t' if multiline else ''
    if any(unicodedata.category(c).startswith('C') and c not in allowed for c in value):
        raise ResearchQueueError(code)
    return value


def _timestamp(value):
    try:
        if isinstance(value, bool):raise ValueError()
        if isinstance(value, (int, float)):
            result = float(value)
        elif isinstance(value, str) and len(value) <= 40:
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:raise ValueError()
            result = parsed.timestamp()
        else:raise ValueError()
        if not math.isfinite(result) or result < 0:raise ValueError()
        return result
    except (ValueError, OverflowError):
        raise ResearchQueueError('RESEARCH_INVALID_TIMESTAMP') from None


def _url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 for c in value):
        raise ResearchQueueError('RESEARCH_INVALID_URL')
    try:
        parts = urlsplit(value)
        host = parts.hostname or ''
        if parts.scheme not in ('http','https') or not host or parts.username or parts.password or parts.fragment or '#' in value or parts.port not in (None,80 if parts.scheme=='http' else 443):raise ValueError()
        if host.endswith(('.local','.localhost','.internal')) or host == 'localhost':raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            if '.' not in host or not re.fullmatch(r'[a-zA-Z0-9.-]+',host) or '..' in host:raise ValueError()
        else:
            if not address.is_global:raise ValueError()
    except ValueError:
        raise ResearchQueueError('RESEARCH_INVALID_URL') from None
    return value


def _bounded_metric(value, depth=0):
    if depth>2:return False
    if value is None or isinstance(value,bool):return True
    if isinstance(value,(int,float)):return math.isfinite(value) and abs(value)<=1e12
    if isinstance(value,str):return len(value)<=128 and not any(unicodedata.category(c).startswith('C') for c in value)
    if isinstance(value,list):return len(value)<=8 and all(_bounded_metric(x,depth+1) for x in value)
    if isinstance(value,dict):return len(value)<=32 and all(isinstance(k,str) and re.fullmatch('[A-Za-z0-9_]{1,48}',k) and _bounded_metric(v,depth+1) for k,v in value.items())
    return False


class ResearchQueue:
    def __init__(self, path, clock=time.time):
        self.path = Path(path).absolute()
        self.clock = clock
        if self.path.is_symlink() or any(p.is_symlink() for p in self.path.parents):
            raise ResearchQueueError('RESEARCH_UNSAFE_PATH')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Lazy initialization means a busy DB never delays foreground startup.

    @contextmanager
    def _transaction(self):
        connection = None
        try:
            if self.path.exists() and self.path.stat().st_size > MAX_BYTES:
                raise ResearchQueueError('RESEARCH_STORAGE_FULL')
            connection = sqlite3.connect(str(self.path),timeout=BUSY_MS/1000,isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA busy_timeout=30')
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('PRAGMA trusted_schema=OFF')
            page_size = connection.execute('PRAGMA page_size').fetchone()[0]
            connection.execute('PRAGMA max_page_count='+str(MAX_BYTES//page_size))
            connection.execute('BEGIN IMMEDIATE')
            app_id = connection.execute('PRAGMA application_id').fetchone()[0]
            if app_id != APPLICATION_ID:
                tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                if app_id != 0 or tables:raise ResearchQueueError('RESEARCH_WRONG_DATABASE')
                connection.execute('PRAGMA application_id='+str(APPLICATION_ID))
                connection.execute('CREATE TABLE jobs (id TEXT PRIMARY KEY,topic TEXT NOT NULL,topic_key TEXT NOT NULL,status TEXT NOT NULL,created_at REAL NOT NULL,started_at REAL,lease_until REAL,finished_at REAL,expires_at REAL,error_code TEXT,metrics TEXT NOT NULL DEFAULT \'{}\')')
                connection.execute('CREATE INDEX jobs_topic ON jobs(topic_key,created_at DESC)')
                connection.execute('CREATE UNIQUE INDEX jobs_active_topic ON jobs(topic_key) WHERE status IN (\'queued\',\'running\')')
                connection.execute('CREATE UNIQUE INDEX jobs_single_running ON jobs((1)) WHERE status=\'running\'')
                connection.execute('CREATE TABLE candidates (id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),topic_key TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,published_at TEXT,fetched_at REAL NOT NULL,expires_at REAL NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT \'candidate\',reviewed_text TEXT,review_note TEXT,reviewed_hash TEXT,approved_at REAL,UNIQUE(job_id,url,content_hash))')
                connection.execute('CREATE INDEX candidates_topic ON candidates(topic_key,expires_at)')
            yield connection
            connection.commit()
        except sqlite3.Error as exc:
            if connection and connection.in_transaction:connection.rollback()
            code = getattr(exc,'sqlite_errorcode',0) & 255
            if code in (sqlite3.SQLITE_BUSY,sqlite3.SQLITE_LOCKED):raise ResearchQueueBusy() from None
            if code == sqlite3.SQLITE_FULL:raise ResearchQueueError('RESEARCH_STORAGE_FULL') from None
            raise ResearchQueueError('RESEARCH_STORE_UNAVAILABLE') from None
        except BaseException:
            if connection and connection.in_transaction:connection.rollback()
            raise
        finally:
            if connection:connection.close()

    @staticmethod
    def _expire(db, now):
        db.execute("UPDATE jobs SET status='cancelled',finished_at=?,expires_at=?,error_code='RESEARCH_QUEUE_EXPIRED' WHERE status='queued' AND created_at<=?",(now,now+NEGATIVE_TTL,now-QUEUE_TTL))
        db.execute("UPDATE jobs SET status='timeout',finished_at=?,expires_at=?,error_code='RESEARCH_LEASE_EXPIRED' WHERE status='running' AND lease_until<=?",(now,now+NEGATIVE_TTL,now))

    @staticmethod
    def _prune(db, now, limit=16):
        # At most 256 candidates exist, so this bounded scan stays small. Raw
        # expired pages can go first; reviewed summaries retain an audit window.
        removed=db.execute("DELETE FROM candidates WHERE id IN (SELECT id FROM candidates WHERE expires_at<=? AND (state!='approved' OR approved_at<=?) ORDER BY expires_at,id LIMIT ?)",
            (now,now-APPROVAL_RETENTION,limit)).rowcount
        jobs=db.execute("DELETE FROM jobs WHERE id IN (SELECT j.id FROM jobs j WHERE j.status NOT IN ('queued','running') AND j.created_at<? AND j.finished_at<? AND NOT EXISTS(SELECT 1 FROM candidates c WHERE c.job_id=j.id) ORDER BY j.finished_at,j.id LIMIT ?)",
            (now-JOB_RETENTION,now-JOB_RETENTION,limit)).rowcount
        return {'candidates_removed':removed,'jobs_removed':jobs}

    @staticmethod
    def _summary(db,row,now):
        value={k:row[k] for k in ('id','topic','status','created_at','started_at','lease_until','finished_at','expires_at','error_code')}
        value['job_id']=value.pop('id')
        value['fresh']=row['status'] in ('queued','running') or (row['expires_at'] is not None and row['expires_at']>now)
        value['candidate_count']=db.execute('SELECT count(*) FROM candidates WHERE job_id=? AND expires_at>?',(row['id'],now)).fetchone()[0]
        value['approved_count']=db.execute("SELECT count(*) FROM candidates WHERE job_id=? AND expires_at>? AND state='approved'",(row['id'],now)).fetchone()[0]
        return value

    def enqueue(self,topic):
        topic=normalize_topic(topic);now=self.clock();key=_key(topic)
        try:
            with self._transaction() as db:
                self._expire(db,now)
                self._prune(db,now)
                row=db.execute('SELECT * FROM jobs WHERE topic_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1',(key,)).fetchone()
                if row and (row['status'] in ('queued','running') or row['expires_at']>now):
                    return {**self._summary(db,row,now),'reused':True}
                if db.execute('SELECT count(*) FROM candidates').fetchone()[0]>=MAX_CANDIDATES:
                    return {'status':'full','error_code':'RESEARCH_CANDIDATES_FULL'}
                if db.execute("SELECT count(*) FROM jobs WHERE status='queued'").fetchone()[0]>=5:
                    return {'status':'full','error_code':'RESEARCH_QUEUE_FULL'}
                start=(int((now+8*3600)//86400)*86400)-8*3600
                if db.execute('SELECT count(*) FROM jobs WHERE created_at>=? AND created_at<?',(start,start+86400)).fetchone()[0]>=20:
                    return {'status':'rate_limited','error_code':'RESEARCH_DAILY_LIMIT'}
                identity=uuid4().hex
                db.execute("INSERT INTO jobs(id,topic,topic_key,status,created_at) VALUES(?,?,?,'queued',?)",(identity,topic,key,now))
                return {**self._summary(db,db.execute('SELECT * FROM jobs WHERE id=?',(identity,)).fetchone(),now),'reused':False}
        except ResearchQueueBusy:
            return {'status':'busy','error_code':'RESEARCH_QUEUE_BUSY'}
        except ResearchQueueError as exc:
            if exc.code=='RESEARCH_STORAGE_FULL':return {'status':'full','error_code':exc.code}
            raise

    def claim_next(self):
        now=self.clock()
        with self._transaction() as db:
            self._expire(db,now)
            if db.execute("SELECT 1 FROM jobs WHERE status='running'").fetchone():return None
            row=db.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").fetchone()
            if not row:return None
            db.execute("UPDATE jobs SET status='running',started_at=?,lease_until=? WHERE id=?",(now,now+LEASE_SECONDS,row['id']))
            return self._summary(db,db.execute('SELECT * FROM jobs WHERE id=?',(row['id'],)).fetchone(),now)

    def finish(self,job_id,result):
        if not isinstance(job_id,str) or not re.fullmatch('[0-9a-f]{32}',job_id):raise ResearchQueueError('RESEARCH_INVALID_JOB')
        now=self.clock()
        if not isinstance(result,dict) or set(result)-{'status','error_code','metrics','candidates'}:raise ResearchQueueError('RESEARCH_INVALID_RESULT')
        state=result.get('status');items=result.get('candidates',[]);metrics=result.get('metrics',{})
        if state not in ('completed','empty','timeout','failed') or not isinstance(items,list) or len(items)>3 or not isinstance(metrics,dict) or len(metrics)>32:raise ResearchQueueError('RESEARCH_INVALID_RESULT')
        if state=='completed' and not items:raise ResearchQueueError('RESEARCH_INVALID_RESULT')
        if state!='completed' and items:raise ResearchQueueError('RESEARCH_INVALID_RESULT')
        if not _bounded_metric(metrics):raise ResearchQueueError('RESEARCH_INVALID_METRICS')
        try:
            encoded=json.dumps(metrics,ensure_ascii=False,allow_nan=False)
            if len(encoded.encode('utf-8'))>2048:raise ValueError()
        except (ValueError,TypeError,RecursionError):raise ResearchQueueError('RESEARCH_INVALID_METRICS') from None
        code=result.get('error_code')
        if code is not None and (not isinstance(code,str) or not re.fullmatch('[A-Z][A-Z0-9_]{1,63}',code)):raise ResearchQueueError('RESEARCH_INVALID_ERROR_CODE')
        candidates=[];seen=set()
        for item in items:
            if not isinstance(item,dict) or set(item)-{'url','title','text','published_at','fetched_at','content_hash'}:raise ResearchQueueError('RESEARCH_INVALID_CANDIDATE')
            url=_url(item.get('url'));title=_text(item.get('title'),200,'RESEARCH_INVALID_TITLE')
            body=_text(item.get('text'),1600,'RESEARCH_INVALID_TEXT',True)
            digest=hashlib.sha256(body.encode('utf-8')).hexdigest()
            if item.get('content_hash')!=digest:raise ResearchQueueError('RESEARCH_HASH_MISMATCH')
            fetched=_timestamp(item.get('fetched_at'))
            if fetched>now+300:raise ResearchQueueError('RESEARCH_FUTURE_FETCH')
            if fetched<=now-SUCCESS_TTL:raise ResearchQueueError('RESEARCH_STALE_FETCH')
            published=item.get('published_at')
            if published is not None:
                if not isinstance(published,str) or len(published)>40:raise ResearchQueueError('RESEARCH_INVALID_PUBLISHED_AT')
                try:datetime.fromisoformat(published.replace('Z','+00:00'))
                except ValueError:raise ResearchQueueError('RESEARCH_INVALID_PUBLISHED_AT') from None
            if (url,digest) not in seen:
                seen.add((url,digest));candidates.append((uuid4().hex,url,title,body,published,fetched,fetched+SUCCESS_TTL,digest))
        expired=False
        with self._transaction() as db:
            now=self.clock()
            self._expire(db,now)
            self._prune(db,now)
            row=db.execute('SELECT * FROM jobs WHERE id=?',(job_id,)).fetchone()
            if not row or row['status']!='running':
                expired=True
            else:
                if db.execute('SELECT count(*) FROM candidates').fetchone()[0]+len(candidates)>MAX_CANDIDATES:
                    db.execute("UPDATE jobs SET status='failed',finished_at=?,expires_at=?,error_code='RESEARCH_CANDIDATES_FULL' WHERE id=?",(now,now+NEGATIVE_TTL,job_id))
                    return
                for identity,url,title,body,published,fetched,expires,digest in candidates:
                    db.execute('INSERT INTO candidates(id,job_id,topic_key,url,title,text,published_at,fetched_at,expires_at,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?)',(identity,job_id,row['topic_key'],url,title,body,published,fetched,expires,digest))
                db.execute('UPDATE jobs SET status=?,finished_at=?,expires_at=?,error_code=?,metrics=? WHERE id=?',(state,now,now+(SUCCESS_TTL if state=='completed' else NEGATIVE_TTL),code,encoded,job_id))
        if expired:raise ResearchQueueError('RESEARCH_JOB_NOT_RUNNING')

    def note_enrichment(self,job_id,counts):
        """Persist the small post-commit catalogue/RAG outcome, not raw pages."""
        if not isinstance(job_id,str) or not re.fullmatch('[0-9a-f]{32}',job_id):raise ResearchQueueError('RESEARCH_INVALID_JOB')
        if not isinstance(counts,dict) or set(counts)-{'hiking_profiles','rag_updates','rag_update_failed'}:raise ResearchQueueError('RESEARCH_INVALID_METRICS')
        if any((type(v) is not bool if k=='rag_update_failed' else type(v) is not int or not 0<=v<=3) for k,v in counts.items()):raise ResearchQueueError('RESEARCH_INVALID_METRICS')
        with self._transaction() as db:
            row=db.execute("SELECT metrics FROM jobs WHERE id=? AND status='completed'",(job_id,)).fetchone()
            if not row:return
            metrics={**json.loads(row[0]),**counts};encoded=json.dumps(metrics,ensure_ascii=False)
            if len(metrics)>32 or len(encoded.encode('utf8'))>2048:raise ResearchQueueError('RESEARCH_INVALID_METRICS')
            db.execute('UPDATE jobs SET metrics=? WHERE id=?',(encoded,job_id))

    def status(self,topic):
        topic=normalize_topic(topic);now=self.clock()
        try:
            with self._transaction() as db:
                self._expire(db,now)
                row=db.execute('SELECT * FROM jobs WHERE topic_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1',(_key(topic),)).fetchone()
                return self._summary(db,row,now) if row else {'status':'missing','topic':topic,'candidate_count':0,'approved_count':0,'fresh':False}
        except ResearchQueueBusy:return {'status':'busy','error_code':'RESEARCH_QUEUE_BUSY'}

    def candidates(self,topic):
        key=_key(normalize_topic(topic));now=self.clock()
        with self._transaction() as db:
            rows=db.execute('SELECT * FROM candidates WHERE topic_key=? AND expires_at>? ORDER BY fetched_at DESC,id LIMIT 3',(key,now)).fetchall()
            # The raw fetched text stays untrusted even after a separate reviewed
            # summary is approved. Promotion must use approved().reviewed_text.
            return [{**dict(row),'fresh':True,'trusted':False} for row in rows]

    def approve(self,candidate_id,reviewed_text,review_note):
        if not isinstance(candidate_id,str) or not re.fullmatch('[0-9a-f]{32}',candidate_id):raise ResearchQueueError('RESEARCH_INVALID_CANDIDATE')
        reviewed_text=_text(reviewed_text,1400,'RESEARCH_INVALID_REVIEW',True)
        review_note=_text(review_note,300,'RESEARCH_INVALID_REVIEW',True);now=self.clock()
        with self._transaction() as db:
            row=db.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone()
            if not row:raise ResearchQueueError('RESEARCH_CANDIDATE_MISSING')
            if row['expires_at']<=now:raise ResearchQueueError('RESEARCH_CANDIDATE_EXPIRED')
            if row['state']=='approved' and row['reviewed_text']==reviewed_text and row['review_note']==review_note:return dict(row)
            db.execute("UPDATE candidates SET state='approved',reviewed_text=?,review_note=?,reviewed_hash=?,approved_at=? WHERE id=?",(reviewed_text,review_note,hashlib.sha256(reviewed_text.encode('utf-8')).hexdigest(),now,candidate_id))
            return dict(db.execute('SELECT * FROM candidates WHERE id=?',(candidate_id,)).fetchone())

    def approved(self,candidate_id):
        """Operator-only reviewed snapshot; expiry never silently refreshes."""
        if not isinstance(candidate_id,str) or not re.fullmatch('[0-9a-f]{32}',candidate_id):raise ResearchQueueError('RESEARCH_INVALID_CANDIDATE')
        now=self.clock()
        with self._transaction() as db:
            row=db.execute("SELECT c.*,j.topic FROM candidates c JOIN jobs j ON c.job_id=j.id WHERE c.id=? AND c.state='approved' AND c.expires_at>?",(candidate_id,now)).fetchone()
            if not row:return None
            return {**dict(row),'reviewed_at':row['approved_at']}

    def prune(self,limit=16):
        """Operator maintenance; bounded deletes, never vacuum or live-store IO."""
        if isinstance(limit,bool) or not isinstance(limit,int) or not 1<=limit<=16:
            raise ResearchQueueError('RESEARCH_INVALID_PRUNE_LIMIT')
        try:
            with self._transaction() as db:
                return {'status':'ok',**self._prune(db,self.clock(),limit)}
        except ResearchQueueBusy:return {'status':'busy','error_code':'RESEARCH_QUEUE_BUSY'}
