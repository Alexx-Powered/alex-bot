"""Explicit operator-selected JSON imports. Never fetch URLs or follow file includes."""
from pathlib import Path
import json
from rag_schema import RagStoreError, DOMAINS, SHARED_NAMESPACE

MAX_IMPORT_BYTES=1024*1024
FIELDS={'doc_id','namespace','domain','title','text','source_ref','visibility','project_key','valid_from','valid_until'}
REQUIRED={'doc_id','namespace','domain','title','text','source_ref','visibility'}


def read_documents(path, *, allowed_roots):
    path=Path(path).absolute()
    roots=[Path(root).resolve() for root in allowed_roots]
    if not roots or path.is_symlink() or not path.is_file() or not any(path.resolve().is_relative_to(root) for root in roots):
        raise RagStoreError('RAG_IMPORT_PATH_NOT_ALLOWED')
    if path.stat().st_size>MAX_IMPORT_BYTES:
        raise RagStoreError('RAG_IMPORT_TOO_LARGE')
    try:
        payload=json.loads(path.read_text(encoding='utf-8-sig'))
    except (ValueError,UnicodeError):
        raise RagStoreError('RAG_IMPORT_INVALID_JSON') from None
    if not isinstance(payload,dict) or set(payload)!={'schema_version','documents'} or payload['schema_version']!='rag.import.v1':
        raise RagStoreError('RAG_IMPORT_SCHEMA')
    documents=payload['documents']
    if not isinstance(documents,list) or not 1<=len(documents)<=256:
        raise RagStoreError('RAG_IMPORT_CAPACITY')
    ids=set()
    for doc in documents:
        if not isinstance(doc,dict) or not REQUIRED<=set(doc) or not set(doc)<=FIELDS:
            raise RagStoreError('RAG_IMPORT_SCHEMA')
        if not isinstance(doc['doc_id'],str) or doc['doc_id'] in ids:
            raise RagStoreError('RAG_IMPORT_DUPLICATE_ID')
        ids.add(doc['doc_id'])
    return documents


def ingest_documents(store, documents, *, allowed_namespaces=(SHARED_NAMESPACE,), allowed_domains=DOMAINS):
    """Scope list is trusted operator configuration, not supplied by a model."""
    if not isinstance(documents,list) or not 1<=len(documents)<=256:
        raise RagStoreError('RAG_IMPORT_CAPACITY')
    # Prevalidate all scopes before any writes. Per-document transactions keep the
    # operation restartable; repeating a partial import does not duplicate chunks.
    for doc in documents:
        if not isinstance(doc,dict) or not REQUIRED<=set(doc) or not set(doc)<=FIELDS:
            raise RagStoreError('RAG_IMPORT_SCHEMA')
        if doc['namespace'] not in allowed_namespaces or doc['domain'] not in allowed_domains:
            raise RagStoreError('RAG_IMPORT_SCOPE_NOT_ALLOWED')
    return [store.put_document(**doc) for doc in documents]


def ingest_file(store,path,*,allowed_roots,allowed_namespaces=(SHARED_NAMESPACE,),allowed_domains=DOMAINS):
    return ingest_documents(store,read_documents(path,allowed_roots=allowed_roots),
        allowed_namespaces=allowed_namespaces,allowed_domains=allowed_domains)
