"""SQLite source of truth, scoped evidence and transactional vector-index outbox.

No network or model calls. Vector identifiers are never accepted as evidence until
resolved against an active, visible source revision here.
"""
from __future__ import annotations

from contextlib import closing, contextmanager
import hashlib
import heapq
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import time
import unicodedata
import uuid

import rag_schema as schema
from rag_schema import RagStoreError


def split_text(text):
    """Group whole paragraphs; never split a rule midway to meet a target size."""
    text = schema.clean(text, schema.MAX_DOCUMENT_CHARS)
    paragraphs = [p.strip() for p in re.split(r'\n\s*\n', text.replace('\r\n', '\n')) if p.strip()]
    if any(len(paragraph)>schema.MAX_CHUNK_CHARS for paragraph in paragraphs):
        raise RagStoreError('RAG_CHUNK_TOO_LARGE')
    chunks, current = [], ''
    for paragraph in paragraphs:
        if current and len(current) + len(paragraph) + 2 > 600:
            chunks.append(current)
            current = ''
        current = current + '\n\n' + paragraph if current else paragraph
    if current:
        chunks.append(current)
    if len(chunks) > schema.MAX_CHUNKS:
        raise RagStoreError('RAG_TOO_MANY_CHUNKS')
    return chunks


def lexical_terms(query):
    """Latin/digit entities remain whole; Chinese uses literal overlapping bigrams."""
    query = unicodedata.normalize('NFKC', schema.clean(query, 1000)).casefold()
    terms = re.findall(r'[a-z0-9]+(?:[._-][a-z0-9]+)*', query)
    for run in re.findall(r'[\u3400-\u9fff]+', query):
        terms.extend([run] if len(run) == 1 else [run[i:i + 2] for i in range(len(run) - 1)])
    return list(dict.fromkeys(terms))[:128]


def title_phrase_score(query, title):
    """Rank an explicitly named structured-title subject ahead of generic terms.

    Only the complete subject before ``|``/``｜`` is a signal; no place-name
    dictionary or guessed aliases. A longer matched subject is more specific.
    Latin/digit boundaries prevent e.g. York from matching Yorkshire. The score
    changes ordering, never visibility, evidence validity or answer sufficiency.
    """
    def normalized(value):
        value = re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value).casefold()).strip()
        # A route connecting two Chinese names is commonly typed without its
        # dash. Preserve Latin hyphens (and number ranges) as part of the name.
        return re.sub(r'(?<=[\u3400-\u9fff])\s*[-–—]\s*(?=[\u3400-\u9fff])', '', value)
    title = normalized(title)
    if '|' not in title:
        return 0
    subject = title.split('|', 1)[0].strip()
    if not 2 <= len(subject) <= 80:
        return 0
    left = r'(?<![a-z0-9])' if re.match(r'[a-z0-9]', subject[0]) else ''
    right = r'(?![a-z0-9])' if re.match(r'[a-z0-9]', subject[-1]) else ''
    return len(subject) if re.search(left+re.escape(subject)+right, normalized(query)) else 0


CHUNK_SELECT = '''SELECT c.chunk_id AS record_id,c.chunk_id,c.doc_id,c.revision,c.ordinal,c.text,
 c.content_hash,d.namespace,d.visibility,d.domain,d.project_key,d.title,d.source_ref,
 d.valid_from,d.valid_until,d.updated_at
 FROM rag_chunks c JOIN rag_documents d ON c.doc_id=d.doc_id AND c.revision=d.revision'''


class RagStore:
    def __init__(self, path, clock=time.time, *, max_database_bytes=schema.MAX_DATABASE_BYTES,
                 max_documents=schema.MAX_DOCUMENTS, max_outbox=schema.MAX_OUTBOX):
        self.path = Path(path).absolute()
        self.clock = clock
        self.max_database_bytes = schema.bound_limit(max_database_bytes, schema.MAX_DATABASE_BYTES)
        self.max_documents = schema.bound_limit(max_documents, schema.MAX_DOCUMENTS)
        self.max_outbox = schema.bound_limit(max_outbox, schema.MAX_OUTBOX)

    @contextmanager
    def _connect(self, *, write=False):
        directory = self.path.parent
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink() or not directory.is_dir() or self.path.is_symlink():
            raise RagStoreError('RAG_UNSAFE_PATH')
        if self.path.exists():
            info = self.path.stat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > self.max_database_bytes:
                raise RagStoreError('RAG_STORE_CAPACITY')
        else:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.close(fd)
            except FileExistsError:
                pass
        if os.name != 'nt':
            directory.chmod(0o700)
            self.path.chmod(0o600)
        connection = sqlite3.connect(self.path, timeout=1)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute('PRAGMA busy_timeout=1000')
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('PRAGMA secure_delete=ON')
            connection.execute('PRAGMA journal_mode=DELETE')
            size = connection.execute('PRAGMA page_size').fetchone()[0]
            connection.execute('PRAGMA max_page_count=' + str(self.max_database_bytes // size))
            version = connection.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise RagStoreError('RAG_SCHEMA_VERSION')
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS rag_documents(
                  doc_id TEXT NOT NULL,revision INTEGER NOT NULL,namespace TEXT NOT NULL,
                  visibility TEXT NOT NULL,domain TEXT NOT NULL,project_key TEXT,title TEXT NOT NULL,
                  source_ref TEXT NOT NULL,status TEXT NOT NULL,valid_from REAL NOT NULL,
                  valid_until REAL,content_hash TEXT NOT NULL,updated_at REAL NOT NULL,
                  PRIMARY KEY(doc_id,revision));
                CREATE INDEX IF NOT EXISTS rag_scope ON rag_documents(namespace,domain,status);
                CREATE TABLE IF NOT EXISTS rag_chunks(
                  chunk_id TEXT PRIMARY KEY,doc_id TEXT NOT NULL,revision INTEGER NOT NULL,
                  ordinal INTEGER NOT NULL,text TEXT NOT NULL,content_hash TEXT NOT NULL,
                  FOREIGN KEY(doc_id,revision) REFERENCES rag_documents(doc_id,revision));
                CREATE INDEX IF NOT EXISTS rag_chunk_version ON rag_chunks(doc_id,revision);
                CREATE TABLE IF NOT EXISTS index_outbox(
                  event_id TEXT PRIMARY KEY,target_collection TEXT NOT NULL,record_id TEXT NOT NULL,
                  doc_id TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,
                  status TEXT NOT NULL,attempts INTEGER NOT NULL,error_code TEXT,created_at REAL NOT NULL,
                  UNIQUE(target_collection,record_id));
                CREATE TABLE IF NOT EXISTS index_manifests(
                  collection TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,embedding_model TEXT NOT NULL,
                  embedding_revision TEXT NOT NULL,dimension INTEGER NOT NULL,source_watermark TEXT NOT NULL);
                PRAGMA user_version=1;
            ''')
            if write:
                connection.execute('BEGIN IMMEDIATE')
            yield connection
            if write:
                connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _queue(self, connection, collection, record_id, doc_id, revision, operation, now):
        connection.execute('''INSERT INTO index_outbox VALUES(?,?,?,?,?,?,'pending',0,NULL,?)
            ON CONFLICT(target_collection,record_id) DO UPDATE SET
            event_id=excluded.event_id,operation=excluded.operation,status='pending',attempts=0,
            error_code=NULL,created_at=excluded.created_at''',
            (uuid.uuid4().hex, collection, record_id, doc_id, revision, operation, now))

    def _capacity(self, connection):
        count = connection.execute('SELECT COUNT(*) FROM index_outbox').fetchone()[0]
        if count > self.max_outbox:
            raise RagStoreError('RAG_OUTBOX_CAPACITY')
        count = connection.execute('SELECT COUNT(DISTINCT doc_id) FROM rag_documents').fetchone()[0]
        if count > self.max_documents:
            raise RagStoreError('RAG_DOCUMENT_CAPACITY')

    def put_document(self, *, namespace, domain, title, text, source_ref, doc_id=None,
                     visibility='private', project_key=None, valid_from=0, valid_until=None):
        namespace = schema.namespace(namespace)
        collection = schema.collection_for(domain)
        if visibility not in ('private', 'shared') or (visibility == 'shared') != (namespace == schema.SHARED_NAMESPACE):
            raise RagStoreError('RAG_INVALID_VISIBILITY')
        if domain == 'project' and visibility != 'private':
            raise RagStoreError('RAG_PRIVATE_PROJECT_REQUIRED')
        title, source_ref = schema.clean(title, 200), schema.clean(source_ref, 1000)
        text = schema.clean(text, schema.MAX_DOCUMENT_CHARS)
        project_key = schema.clean(project_key, 128) if project_key is not None else None
        if domain != 'project' and project_key is not None:
            raise RagStoreError('RAG_INVALID_PROJECT')
        valid_from = schema.timestamp(valid_from)
        valid_until = schema.timestamp(valid_until) if valid_until is not None else None
        if valid_until is not None and valid_until <= valid_from:
            raise RagStoreError('RAG_INVALID_TIME')
        doc_id = schema.identifier(doc_id) if doc_id else hashlib.sha256((namespace+'\0'+domain+'\0'+source_ref).encode()).hexdigest()
        content_hash = hashlib.sha256(json.dumps([text,title,source_ref,visibility,domain,project_key,valid_from,valid_until],ensure_ascii=False).encode()).hexdigest()
        now = schema.timestamp(self.clock())
        chunks = split_text(text)
        with self._connect(write=True) as c:
            previous = c.execute('SELECT * FROM rag_documents WHERE doc_id=? ORDER BY revision DESC LIMIT 1',(doc_id,)).fetchone()
            if previous and previous['namespace'] != namespace:
                raise RagStoreError('RAG_SCOPE_MISMATCH')
            if previous and previous['status'] == 'active' and previous['content_hash'] == content_hash:
                ids = [r[0] for r in c.execute('SELECT chunk_id FROM rag_chunks WHERE doc_id=? AND revision=? ORDER BY ordinal',(doc_id,previous['revision']))]
                return {'doc_id':doc_id,'revision':previous['revision'],'chunk_ids':ids,'changed':False}
            revision = previous['revision'] + 1 if previous else 1
            for old in c.execute('''SELECT c.chunk_id,c.revision,d.domain FROM rag_chunks c JOIN rag_documents d
                 ON c.doc_id=d.doc_id AND c.revision=d.revision WHERE c.doc_id=? AND d.status='active' ''',(doc_id,)).fetchall():
                self._queue(c,schema.collection_for(old['domain']),old['chunk_id'],doc_id,old['revision'],'delete',now)
            c.execute("UPDATE rag_documents SET status='superseded' WHERE doc_id=? AND status='active'",(doc_id,))
            c.execute('INSERT INTO rag_documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (doc_id,revision,namespace,visibility,domain,project_key,title,source_ref,'active',valid_from,valid_until,content_hash,now))
            ids=[]
            for ordinal, chunk in enumerate(chunks):
                chunk_id=hashlib.sha256(f'{doc_id}:{revision}:{ordinal}'.encode()).hexdigest()
                digest=hashlib.sha256(chunk.encode()).hexdigest()
                c.execute('INSERT INTO rag_chunks VALUES(?,?,?,?,?,?)',(chunk_id,doc_id,revision,ordinal,chunk,digest))
                self._queue(c,collection,chunk_id,doc_id,revision,'upsert',now)
                ids.append(chunk_id)
            self._capacity(c)
        return {'doc_id':doc_id,'revision':revision,'chunk_ids':ids,'changed':True}

    def delete_document(self, doc_id, *, namespace):
        doc_id, namespace = schema.identifier(doc_id), schema.namespace(namespace)
        now = schema.timestamp(self.clock())
        with self._connect(write=True) as c:
            rows = c.execute('SELECT * FROM rag_documents WHERE doc_id=? AND namespace=?',(doc_id,namespace)).fetchall()
            if not rows or all(row['status']=='deleted' for row in rows):
                return False
            self._delete_versions(c,rows,now)
        return True

    def clear_project_notes(self, *, namespace):
        """Atomic user-memory clear, including expired and superseded notes."""
        namespace=schema.namespace(namespace)
        now=schema.timestamp(self.clock())
        with self._connect(write=True) as c:
            rows=c.execute("""SELECT * FROM rag_documents WHERE namespace=?
                AND visibility='private' AND domain='project' AND status!='deleted'""",(namespace,)).fetchall()
            self._delete_versions(c,rows,now)
            return len({row['doc_id'] for row in rows})

    def _delete_versions(self,c,rows,now):
        # Erase source text immediately. IDs remain durable cleanup tombstones
        # until vector deletion is acknowledged; a full index queue cannot
        # roll back a user's canonical deletion.
        for row in rows:
            key=(row['doc_id'],row['revision'])
            c.execute("UPDATE rag_documents SET status='deleted',updated_at=? WHERE doc_id=? AND revision=?",(now,*key))
            c.execute("UPDATE rag_chunks SET text='' WHERE doc_id=? AND revision=?",key)
            for chunk in c.execute('SELECT chunk_id FROM rag_chunks WHERE doc_id=? AND revision=?',key).fetchall():
                existing=c.execute('SELECT 1 FROM index_outbox WHERE record_id=?',(chunk[0],)).fetchone()
                if existing:
                    self._queue(c,schema.collection_for(row['domain']),chunk[0],row['doc_id'],row['revision'],'delete',now)
        self._fill_deferred_deletes(c,now)

    def _fill_deferred_deletes(self,c,now):
        available=self.max_outbox-c.execute('SELECT COUNT(*) FROM index_outbox').fetchone()[0]
        if available<=0:return
        rows=c.execute('''SELECT c.chunk_id,c.doc_id,c.revision,d.domain FROM rag_chunks c
            JOIN rag_documents d ON c.doc_id=d.doc_id AND c.revision=d.revision
            WHERE d.status='deleted' AND NOT EXISTS
            (SELECT 1 FROM index_outbox e WHERE e.record_id=c.chunk_id)
            ORDER BY d.updated_at,c.chunk_id LIMIT ?''',(available,)).fetchall()
        for row in rows:
            self._queue(c,schema.collection_for(row['domain']),row['chunk_id'],row['doc_id'],row['revision'],'delete',now)

    def _scope(self, namespace, domain, include_shared, project_key):
        namespace = schema.namespace(namespace)
        if namespace == schema.SHARED_NAMESPACE:
            raise RagStoreError('RAG_READER_SCOPE_REQUIRED')
        if not isinstance(include_shared, bool):
            raise RagStoreError('RAG_INVALID_SCOPE')
        now = schema.timestamp(self.clock())
        where = "d.status='active' AND d.valid_from<=? AND (d.valid_until IS NULL OR d.valid_until>?)"
        params = [now,now]
        where += " AND ((d.namespace=? AND d.visibility='private')"
        params.append(namespace)
        if include_shared:
            where += " OR (d.namespace='shared' AND d.visibility='shared')"
        where += ')'
        if domain is not None:
            schema.collection_for(domain)
            where += ' AND d.domain=?'
            params.append(domain)
        if project_key is not None:
            project_key=schema.clean(project_key,128)
            where += ' AND d.project_key=? AND d.domain=\'project\''
            params.append(project_key)
        return where,params

    def resolve_chunks(self, record_ids, *, namespace, domain=None, include_shared=False, project_key=None):
        if not isinstance(record_ids,(list,tuple)) or len(record_ids)>1000:
            raise RagStoreError('RAG_INVALID_RECORDS')
        ids=list(dict.fromkeys(schema.identifier(i) for i in record_ids))
        where,params=self._scope(namespace,domain,include_shared,project_key)
        if not ids:return []
        with self._connect() as c:
            rows=c.execute(CHUNK_SELECT+' WHERE '+where+' AND c.chunk_id IN ('+','.join('?' for _ in ids)+')',params+ids).fetchall()
        found={r['record_id']:dict(r) for r in rows}
        return [found[i] for i in ids if i in found]

    def active_chunks(self, *, namespace, domain=None, include_shared=False, project_key=None, limit=20000):
        limit=schema.bound_limit(limit,20000)
        where,params=self._scope(namespace,domain,include_shared,project_key)
        with self._connect() as c:
            return [dict(r) for r in c.execute(CHUNK_SELECT+' WHERE '+where+' ORDER BY d.updated_at DESC,c.doc_id,c.ordinal LIMIT ?',params+[limit])]

    def lexical_search(self, query, *, namespace, domain=None, include_shared=False, project_key=None, limit=12):
        limit=schema.bound_limit(limit,100)
        terms=lexical_terms(query)
        if not terms:
            self._scope(namespace,domain,include_shared,project_key)
            return []
        # Stream scoped rows and retain only top-k; a large knowledge store must
        # not be copied wholesale into the Bot worker for a lexical fallback.
        where,params=self._scope(namespace,domain,include_shared,project_key)
        query=unicodedata.normalize('NFKC',query).casefold().strip()
        entities=[term for term in terms if re.search(r'\d',term)]
        with self._connect() as c:
            def scored():
                for row in c.execute(CHUNK_SELECT+' WHERE '+where,params):
                    content=unicodedata.normalize('NFKC',row['title']+'\n'+row['text']).casefold()
                    def matches(term):
                        if re.fullmatch(r'[a-z0-9]+(?:[._-][a-z0-9]+)*',term):
                            return re.search(r'(?<![a-z0-9])'+re.escape(term)+r'(?![a-z0-9])',content) is not None
                        return term in content
                    # A classroom number must not accidentally match a longer number.
                    if entities and not all(matches(term) for term in entities):
                        continue
                    score=sum(1 for term in terms if matches(term))/len(terms)
                    if matches(query):score+=1
                    subject_score=title_phrase_score(query,row['title'])
                    if score>0 or subject_score>0:
                        yield dict(row,lexical_score=score,title_phrase_score=subject_score)
            return heapq.nsmallest(limit,scored(),key=lambda r:(-r['title_phrase_score'],-r['lexical_score'],-r['updated_at'],r['record_id']))

    def get_document(self, doc_id, *, namespace):
        doc_id,namespace=schema.identifier(doc_id),schema.namespace(namespace)
        with self._connect() as c:
            row=c.execute('SELECT * FROM rag_documents WHERE doc_id=? AND namespace=? ORDER BY revision DESC LIMIT 1',(doc_id,namespace)).fetchone()
            return dict(row) if row else None

    def find_project_documents(self, project_key, *, namespace):
        project_key,namespace=schema.clean(project_key,128),schema.namespace(namespace)
        with self._connect() as c:
            return [dict(r) for r in c.execute("SELECT * FROM rag_documents WHERE namespace=? AND project_key=? AND domain='project' AND status='active'",(namespace,project_key))]

    def pending_events(self, limit=32):
        limit=schema.bound_limit(limit,256)
        with self._connect(write=True) as c:
            self._fill_deferred_deletes(c,schema.timestamp(self.clock()))
            events=[dict(r) for r in c.execute("SELECT * FROM index_outbox WHERE status='pending' ORDER BY created_at,event_id LIMIT ?",(limit,))]
            for event in events:
                row=c.execute(CHUNK_SELECT+" WHERE c.chunk_id=? AND d.status='active'",(event['record_id'],)).fetchone()
                event['record']=dict(row) if row and event['operation']=='upsert' else None
            return events

    def complete_event(self, event_id):
        event_id=schema.identifier(event_id)
        with self._connect(write=True) as c:
            event=c.execute('SELECT * FROM index_outbox WHERE event_id=?',(event_id,)).fetchone()
            if not event:return False
            c.execute('DELETE FROM index_outbox WHERE event_id=?',(event_id,))
            if event['operation']=='delete':
                c.execute('''DELETE FROM rag_chunks WHERE chunk_id=? AND EXISTS
                    (SELECT 1 FROM rag_documents d WHERE d.doc_id=rag_chunks.doc_id
                    AND d.revision=rag_chunks.revision AND d.status='deleted')''',(event['record_id'],))
            return True

    def fail_event(self, event_id, code='INDEX_ERROR'):
        event_id,code=schema.identifier(event_id),schema.identifier(code)
        with self._connect(write=True) as c:
            return c.execute("""UPDATE index_outbox SET attempts=attempts+1,error_code=?,
                status=CASE WHEN attempts+1>=? THEN 'failed' ELSE 'pending' END
                WHERE event_id=? AND status='pending'""",(code,schema.MAX_INDEX_ATTEMPTS,event_id)).rowcount>0

    def outbox_summary(self):
        with self._connect() as c:
            result={r['status']:r['n'] for r in c.execute('SELECT status,COUNT(*) n FROM index_outbox GROUP BY status')}
            deferred=c.execute('''SELECT COUNT(*) FROM rag_chunks c JOIN rag_documents d
                ON c.doc_id=d.doc_id AND c.revision=d.revision WHERE d.status='deleted'
                AND NOT EXISTS(SELECT 1 FROM index_outbox e WHERE e.record_id=c.chunk_id)''').fetchone()[0]
            if deferred:result['deferred_deletes']=deferred
            return result

    def requeue_all(self):
        """Trusted rebuild: queue every retained chunk, deleting obsolete versions."""
        now=schema.timestamp(self.clock())
        with self._connect(write=True) as c:
            # Tombstones survive source-text deletion. Include failed deletes in
            # an explicit operator rebuild/retry instead of losing their work.
            for event in c.execute('SELECT * FROM index_outbox').fetchall():
                self._queue(c,event['target_collection'],event['record_id'],event['doc_id'],
                    event['revision'],event['operation'],now)
            rows=c.execute(CHUNK_SELECT.replace('d.updated_at','d.updated_at,d.status')).fetchall()
            for row in rows:
                operation='upsert' if row['status']=='active' else 'delete'
                self._queue(c,schema.collection_for(row['domain']),row['record_id'],row['doc_id'],row['revision'],operation,now)
            self._capacity(c)
            return c.execute('SELECT COUNT(*) FROM index_outbox').fetchone()[0]

    def get_manifest(self, collection):
        if collection not in schema.COLLECTIONS:raise RagStoreError('RAG_INVALID_COLLECTION')
        with self._connect() as c:
            row=c.execute('SELECT * FROM index_manifests WHERE collection=?',(collection,)).fetchone()
            return dict(row) if row else None

    def save_manifest(self, collection, *, embedding_model, embedding_revision, dimension, schema_version=1, source_watermark=''):
        if collection not in schema.COLLECTIONS:raise RagStoreError('RAG_INVALID_COLLECTION')
        embedding_model=schema.clean(embedding_model,200)
        embedding_revision=schema.clean(embedding_revision,200)
        dimension=schema.bound_limit(dimension,65536)
        schema_version=schema.bound_limit(schema_version,1000)
        source_watermark=schema.clean(source_watermark,200,empty=True)
        with self._connect(write=True) as c:
            c.execute('INSERT OR REPLACE INTO index_manifests VALUES(?,?,?,?,?,?)',
                (collection,schema_version,embedding_model,embedding_revision,dimension,source_watermark))

    def backup_to(self, destination):
        """Consistent SQLite snapshot; explicit operator path, never a model argument."""
        destination=Path(destination).absolute()
        if destination.exists() or destination.is_symlink() or destination==self.path:
            raise RagStoreError('RAG_BACKUP_DESTINATION_EXISTS')
        destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        if destination.parent.is_symlink():raise RagStoreError('RAG_UNSAFE_PATH')
        fd=os.open(destination,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
        with self._connect() as source, closing(sqlite3.connect(destination)) as target:
            source.backup(target)
