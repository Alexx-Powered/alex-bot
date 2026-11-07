"""Canonical RAG constants and bounded validation; identities come from trusted code."""
import math
import re
import unicodedata

DOMAINS = ('campus', 'weather', 'bot', 'outdoor', 'project')
COLLECTIONS = ('knowledge_chunks_v1', 'project_notes_v1')
SHARED_NAMESPACE = 'shared'
MAX_DOCUMENT_CHARS = 32000
MAX_CHUNK_CHARS = 6000
MAX_CHUNKS = 128
MAX_DOCUMENTS = 5000
MAX_OUTBOX = 20000
MAX_DATABASE_BYTES = 64 * 1024 * 1024
MAX_INDEX_ATTEMPTS = 3


class RagStoreError(ValueError):
    """Stable, non-sensitive error code."""


def clean(value, maximum=128, *, empty=False):
    if not isinstance(value, str) or len(value) > maximum:
        raise RagStoreError('RAG_INVALID_INPUT')
    value = value.strip()
    if (not empty and not value) or any(unicodedata.category(c) in {'Cf', 'Cs'} or
            (unicodedata.category(c) == 'Cc' and c not in '\n\r\t') for c in value):
        raise RagStoreError('RAG_INVALID_INPUT')
    return value


def namespace(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', value) is None:
        raise RagStoreError('RAG_INVALID_SCOPE')
    return value


def identifier(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}', value) is None:
        raise RagStoreError('RAG_INVALID_ID')
    return value


def timestamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value < 9e12:
        raise RagStoreError('RAG_INVALID_TIME')
    return float(value)


def collection_for(domain):
    if domain not in DOMAINS:
        raise RagStoreError('RAG_INVALID_DOMAIN')
    return 'project_notes_v1' if domain == 'project' else 'knowledge_chunks_v1'


def bound_limit(value, maximum=100):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise RagStoreError('RAG_INVALID_LIMIT')
    return value
