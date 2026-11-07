"""Milvus metadata-only vector index; canonical text lives in RagStore."""
from __future__ import annotations

import json
import hashlib
import math
import re
import threading
import time

from embedding_provider import checked_vectors

COLLECTIONS=('knowledge_chunks_v1','project_notes_v1')
DOMAINS={'campus','weather','bot','outdoor','project'}
NAMESPACE=re.compile(r'[A-Za-z0-9_.:-]{1,128}\Z')
RECORD_ID=re.compile(r'[a-f0-9]{64}\Z')


class VectorIndexError(RuntimeError):
    pass


def collection_for(domain):
    if domain not in DOMAINS:
        raise ValueError('RAG_DOMAIN_INVALID')
    return 'project_notes_v1' if domain=='project' else 'knowledge_chunks_v1'


def scope_filter(*,namespace,domain,include_shared=False,project_key=None,now=None):
    if not isinstance(namespace,str) or not NAMESPACE.fullmatch(namespace) or namespace=='shared':
        raise ValueError('RAG_NAMESPACE_INVALID')
    collection_for(domain)
    now=time.time() if now is None else now
    if not isinstance(now,(float,int)) or isinstance(now,bool) or not math.isfinite(now) or now<0:
        raise ValueError('RAG_TIME_INVALID')
    own='(namespace == '+json.dumps(namespace)+' and visibility == "private")'
    if include_shared and domain!='project':
        own='('+own+' or (namespace == "shared" and visibility == "shared"))'
    parts=[own,'domain == '+json.dumps(domain),f'valid_from <= {float(now)}',f'valid_until > {float(now)}']
    if project_key is not None:
        if not isinstance(project_key,str) or not 1<=len(project_key)<=128:
            raise ValueError('RAG_PROJECT_INVALID')
        parts.append('project_key == '+json.dumps(project_key,ensure_ascii=False))
    return ' and '.join(parts)


class MilvusIndex:
    """One owner per Lite URI; optional dependencies never load on disabled paths."""
    def __init__(self,uri,spec,*,token='',timeout=8,client=None):
        self.uri=str(uri)
        self.spec=spec
        self.token=token
        self.timeout=timeout
        self._client=client
        self._ready=set()
        self._lock=threading.RLock()

    def _connect(self):
        if self._client is None:
            try:
                from pymilvus import MilvusClient
                self._client=MilvusClient(uri=self.uri,token=self.token,timeout=self.timeout)
            except Exception:
                raise VectorIndexError('RAG_INDEX_UNAVAILABLE') from None
        return self._client

    def _ensure(self,name):
        if name not in COLLECTIONS:
            raise ValueError('RAG_COLLECTION_DENIED')
        client=self._connect()
        if name in self._ready:
            return client
        description=json.dumps({'schema_version':1,'embedding_fingerprint':self.spec.fingerprint},sort_keys=True)
        created=not client.has_collection(collection_name=name,timeout=self.timeout)
        if created:
            from pymilvus import DataType
            schema=client.create_schema(auto_id=False,enable_dynamic_field=False,description=description)
            for field,length in [('record_id',64),('doc_id',128),('namespace',128),('visibility',16),('domain',32),('project_key',512),('embedding_model',64)]:
                schema.add_field(field_name=field,datatype=DataType.VARCHAR,max_length=length,is_primary=field=='record_id')
            schema.add_field(field_name='revision',datatype=DataType.INT64)
            schema.add_field(field_name='valid_from',datatype=DataType.DOUBLE)
            schema.add_field(field_name='valid_until',datatype=DataType.DOUBLE)
            schema.add_field(field_name='vector',datatype=DataType.FLOAT_VECTOR,dim=self.spec.dimension)
            params=client.prepare_index_params()
            params.add_index(field_name='vector',index_type='FLAT',metric_type='COSINE')
            client.create_collection(collection_name=name,schema=schema,index_params=params,description=description,consistency_level='Strong',timeout=self.timeout)
        metadata=client.describe_collection(collection_name=name,timeout=self.timeout)
        fields={row['name']:row for row in metadata.get('fields',[])}
        try:
            dimension=int(fields['vector']['params']['dim'])
        except (KeyError,TypeError,ValueError):
            raise VectorIndexError('RAG_INDEX_MANIFEST_MISMATCH') from None
        expected_fields={'record_id','doc_id','namespace','visibility','domain','project_key','embedding_model','revision','valid_from','valid_until','vector'}
        if set(fields)!=expected_fields or dimension!=self.spec.dimension:
            raise VectorIndexError('RAG_INDEX_MANIFEST_MISMATCH')
        client.load_collection(collection_name=name,timeout=self.timeout)
        # Lite 3.2.2 does not persist collection descriptions. Keep an actual
        # reserved entity as the durable manifest; ordinary domain/scope filters
        # always exclude it. Never adopt an existing unmarked collection.
        marker_id=hashlib.sha256(('alexbot-rag-manifest-v1:'+name).encode()).hexdigest()
        if created:
            client.upsert(collection_name=name,data=[dict(record_id=marker_id,doc_id='__manifest__',
                namespace='__index_manifest__',visibility='private',domain='__manifest__',project_key='',
                embedding_model=self.spec.fingerprint,revision=1,valid_from=0.,valid_until=0.,
                vector=[1.]+[0.]*(self.spec.dimension-1))],timeout=self.timeout)
        markers=client.get(collection_name=name,ids=[marker_id],output_fields=['embedding_model','revision'],timeout=self.timeout)
        if len(markers)!=1 or markers[0].get('embedding_model')!=self.spec.fingerprint or markers[0].get('revision')!=1:
            raise VectorIndexError('RAG_INDEX_MANIFEST_MISMATCH')
        self._ready.add(name)
        return client

    def upsert(self,records,vectors):
        if not isinstance(records,list) or not 1<=len(records)<=32:
            raise ValueError('RAG_INDEX_BATCH_INVALID')
        vectors=checked_vectors(vectors,len(records),self.spec.dimension)
        grouped={}
        for row,vector in zip(records,vectors):
            if not RECORD_ID.fullmatch(row['record_id']):
                raise ValueError('RAG_RECORD_INVALID')
            name=collection_for(row['domain'])
            data={key:row[key] for key in ('record_id','doc_id','namespace','visibility','domain','revision','valid_from')}
            data.update(valid_until=row.get('valid_until') or 9e12,project_key=row.get('project_key') or '',embedding_model=self.spec.fingerprint,vector=vector)
            grouped.setdefault(name,[]).append(data)
        with self._lock:
            for name,data in grouped.items():
                self._ensure(name).upsert(collection_name=name,data=data,timeout=self.timeout)

    def delete(self,collection,record_ids):
        if collection not in COLLECTIONS or not isinstance(record_ids,list) or not 1<=len(record_ids)<=32 or any(not RECORD_ID.fullmatch(x) for x in record_ids):
            raise ValueError('RAG_DELETE_INVALID')
        with self._lock:
            client=self._connect()
            if client.has_collection(collection_name=collection,timeout=self.timeout):
                self._ensure(collection).delete(collection_name=collection,ids=record_ids,timeout=self.timeout)

    def search(self,vector,*,namespace,domain,include_shared=False,project_key=None,now=None,limit=12):
        if isinstance(limit,bool) or not isinstance(limit,int) or not 1<=limit<=32:
            raise ValueError('RAG_LIMIT_INVALID')
        expr=scope_filter(namespace=namespace,domain=domain,include_shared=include_shared,project_key=project_key,now=now)
        expr+=' and embedding_model == '+json.dumps(self.spec.fingerprint)
        vector=checked_vectors([vector],1,self.spec.dimension)[0]
        name=collection_for(domain)
        with self._lock:
            result=self._ensure(name).search(collection_name=name,data=[vector],filter=expr,limit=limit,
                output_fields=['record_id'],search_params={'metric_type':'COSINE'},consistency_level='Strong',timeout=self.timeout)
        return [{'record_id':hit.get('entity',{}).get('record_id',hit.get('id')),'score':float(hit.get('distance',0))} for hit in (result[0] if result else [])]

    def close(self):
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client=None
            self._ready.clear()
