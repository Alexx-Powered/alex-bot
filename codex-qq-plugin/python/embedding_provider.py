"""Optional, operator-configured embeddings. No model-controlled endpoints or keys."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import re
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class EmbeddingError(RuntimeError):
    pass


@dataclass(frozen=True)
class EmbeddingSpec:
    model_id: str
    revision: str
    dimension: int

    def __post_init__(self):
        if not isinstance(self.model_id,str) or not isinstance(self.revision,str) or not self.model_id or not self.revision or len(self.model_id)>200 or len(self.revision)>200:
            raise ValueError('EMBEDDING_MODEL_INVALID')
        if not isinstance(self.dimension,int) or isinstance(self.dimension,bool) or not 1<=self.dimension<=4096:
            raise ValueError('EMBEDDING_DIMENSION_INVALID')

    @property
    def fingerprint(self):
        return hashlib.sha256(json.dumps([self.model_id,self.revision,self.dimension],ensure_ascii=False).encode()).hexdigest()


def checked_vectors(values, count, dimension):
    rows=list(values)
    if len(rows)!=count:
        raise EmbeddingError('EMBEDDING_RESPONSE_INVALID')
    checked=[]
    for value in rows:
        if len(value)!=dimension:
            raise EmbeddingError('EMBEDDING_DIMENSION_MISMATCH')
        try:
            row=[float(x) for x in value]
        except (TypeError,ValueError,OverflowError):
            raise EmbeddingError('EMBEDDING_RESPONSE_INVALID') from None
        if not all(math.isfinite(x) for x in row):
            raise EmbeddingError('EMBEDDING_RESPONSE_INVALID')
        norm=math.sqrt(sum(x*x for x in row))
        if not math.isfinite(norm) or norm<1e-12:
            raise EmbeddingError('EMBEDDING_RESPONSE_INVALID')
        checked.append([x/norm for x in row])
    return checked


def checked_texts(texts):
    if not isinstance(texts,list) or not 1<=len(texts)<=32:
        raise ValueError('EMBEDDING_BATCH_INVALID')
    if any(not isinstance(t,str) or not t.strip() or len(t)>6000 for t in texts):
        raise ValueError('EMBEDDING_TEXT_INVALID')
    return texts


class FastEmbedProvider:
    """Local optional model, lazy loaded. Pin revision to operator-verified model assets."""
    def __init__(self, model_id, revision, dimension, cache_dir, *, local_files_only=True, threads=1):
        self.cache_dir=str(Path(cache_dir).resolve())
        if not re.fullmatch(r'[a-f0-9]{40}',revision):
            raise ValueError('EMBEDDING_REVISION_MUST_BE_COMMIT')
        candidates=list(Path(self.cache_dir).glob('models--*/snapshots/'+revision))
        if len(candidates)!=1:
            raise EmbeddingError('EMBEDDING_PINNED_SNAPSHOT_MISSING')
        self.model_path=candidates[0]
        digest=hashlib.sha256()
        paths=sorted(p for p in self.model_path.rglob('*') if p.is_file())
        if not paths or not any(p.suffix=='.onnx' for p in paths):
            raise EmbeddingError('EMBEDDING_PINNED_SNAPSHOT_INCOMPLETE')
        for path in paths:
            if not path.resolve().is_relative_to(Path(self.cache_dir)):
                raise EmbeddingError('EMBEDDING_SNAPSHOT_PATH_INVALID')
            digest.update(path.relative_to(self.model_path).as_posix().encode())
            digest.update(b'\0')
            with path.open('rb') as file:
                for block in iter(lambda:file.read(1024*1024),b''):
                    digest.update(block)
        self.artifact_sha256=digest.hexdigest()
        self.spec=EmbeddingSpec(model_id,revision+'@sha256:'+self.artifact_sha256,dimension)
        self.local_files_only=True
        if not isinstance(threads,int) or isinstance(threads,bool) or not 1<=threads<=4:
            raise ValueError('EMBEDDING_THREADS_INVALID')
        self.threads=threads
        self._model=None

    def _load(self):
        if self._model is None:
            try:
                from fastembed import TextEmbedding
                self._model=TextEmbedding(model_name=self.spec.model_id,cache_dir=self.cache_dir,
                    threads=self.threads,local_files_only=True,specific_model_path=str(self.model_path))
            except Exception:
                raise EmbeddingError('EMBEDDING_MODEL_UNAVAILABLE') from None
        return self._model

    def embed_documents(self,texts):
        checked_texts(texts)
        try:
            values=self._load().passage_embed(texts,batch_size=min(16,len(texts)))
            return checked_vectors(values,len(texts),self.spec.dimension)
        except EmbeddingError:
            raise
        except Exception:
            raise EmbeddingError('EMBEDDING_FAILED') from None

    def embed_query(self,text):
        checked_texts([text])
        try:
            return checked_vectors(self._load().query_embed(text),1,self.spec.dimension)[0]
        except EmbeddingError:
            raise
        except Exception:
            raise EmbeddingError('EMBEDDING_FAILED') from None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        raise EmbeddingError('EMBEDDING_REDIRECT_DENIED')


class HttpEmbeddingProvider:
    """OpenAI-compatible embedding endpoint configured only by the operator.

    Constructing this provider is an explicit choice to send query/document text
    to that configured endpoint. It never reuses the chat model's credentials.
    """
    def __init__(self, endpoint, model_id, revision, dimension, *, api_key='',timeout=8):
        parsed=urlsplit(endpoint)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('EMBEDDING_ENDPOINT_INVALID')
        if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in {'localhost','127.0.0.1','::1'}):
            raise ValueError('EMBEDDING_ENDPOINT_INVALID')
        if not parsed.hostname or not 0<timeout<=20:
            raise ValueError('EMBEDDING_ENDPOINT_INVALID')
        self.endpoint=endpoint
        self.spec=EmbeddingSpec(model_id,revision,dimension)
        self.api_key=api_key
        self.timeout=timeout

    def _embed(self,texts):
        checked_texts(texts)
        headers={'Content-Type':'application/json','Accept':'application/json','User-Agent':'AlexBot-RAG/1'}
        if self.api_key:
            headers['Authorization']='Bearer '+self.api_key
        payload=json.dumps({'model':self.spec.model_id,'input':texts,'encoding_format':'float'}).encode()
        try:
            with build_opener(_NoRedirect()).open(Request(self.endpoint,data=payload,headers=headers),timeout=self.timeout) as response:
                raw=response.read(4_000_001)
            if len(raw)>4_000_000:
                raise EmbeddingError('EMBEDDING_RESPONSE_TOO_LARGE')
            body=json.loads(raw)
            rows=body['data']
            if len(rows)!=len(texts) or sorted(r['index'] for r in rows)!=list(range(len(texts))):
                raise EmbeddingError('EMBEDDING_RESPONSE_INVALID')
            return checked_vectors([r['embedding'] for r in sorted(rows,key=lambda r:r['index'])],len(texts),self.spec.dimension)
        except EmbeddingError:
            raise
        except Exception:
            raise EmbeddingError('EMBEDDING_UNAVAILABLE') from None

    def embed_documents(self,texts):
        return self._embed(texts)

    def embed_query(self,text):
        return self._embed([text])[0]
