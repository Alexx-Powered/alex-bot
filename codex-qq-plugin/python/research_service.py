"""One operator-configured research queue job, never a RAG/Milvus owner.

The systemd service supplies the encrypted-key reader in Node. Only the key
travels over this process's stdin; topics remain in the isolated queue. No CLI
argument accepts a topic, URL, provider, database, executable, or credential.
"""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

MIN_AVAILABLE = 600 * 1024 * 1024
MEMORY_MAX = 128 * 1024 * 1024
CONFIG_PATH = '/var/lib/alexbot/.private/rag-config.json'
SERVICE_NAME = 'alexbot-research.service'


class ResearchServiceError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def load_research_config(filename=None):
    """Read only the research section; never initialize the formal RAG store."""
    path = Path(filename or os.environ.get('QQ_RAG_CONFIG', CONFIG_PATH))
    if not path.is_absolute() or path.is_symlink():
        raise ResearchServiceError('RESEARCH_CONFIG_INVALID')
    try:
        if path.stat().st_size > 16384:
            raise ResearchServiceError('RESEARCH_CONFIG_INVALID')
        root = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {'enabled': False}
    except (OSError, ValueError):
        raise ResearchServiceError('RESEARCH_CONFIG_INVALID') from None
    if not isinstance(root, dict):
        raise ResearchServiceError('RESEARCH_CONFIG_INVALID')
    if root.get('enabled') is not True:
        return {'enabled': False}
    config = root.get('research')
    if config is None or (isinstance(config, dict) and config.get('enabled') is False):
        return {'enabled': False}
    if (not isinstance(config, dict) or config.get('enabled') is not True
            or config.get('provider', 'deepseek') != 'deepseek'):
        raise ResearchServiceError('RESEARCH_CONFIG_INVALID')
    value = config.get('queue_path')
    if not isinstance(value, str):
        raise ResearchServiceError('RESEARCH_CONFIG_INVALID')
    queue = Path(value)
    expected = path.parent / 'research' / 'queue.sqlite3'
    if (not queue.is_absolute() or queue != expected
            or queue.is_symlink() or any(p.is_symlink() for p in queue.parents)):
        raise ResearchServiceError('RESEARCH_CONFIG_INVALID')
    result={'enabled': True, 'provider': 'deepseek', 'queue_path': str(queue)}
    # Canonical SQLite only; never open the vector database from this service.
    database=Path(root.get('store_path',''))
    if database.is_absolute() and database.parent==path.parent/'rag' and database.suffix=='.sqlite3' and not database.is_symlink():
        result['store_path']=str(database)
    return result


def memory_admitted(available, own_usage=0):
    """own_usage is accepted only after validating this service's capped cgroup."""
    return (type(available) is int and available >= 0 and type(own_usage) is int
            and 0 <= own_usage <= MEMORY_MAX and available + own_usage >= MIN_AVAILABLE)


def memory_guard(*, compensate=True, read_text=None):
    read_text = read_text or (lambda name: Path(name).read_text(encoding='ascii'))
    try:
        match = re.search(r'^MemAvailable:\s+(\d+)\s+kB\s*$', read_text('/proc/meminfo'), re.M)
        if not match:
            return False
        available = int(match[1]) * 1024
        own = 0
        if compensate:
            group = next((line[3:] for line in read_text('/proc/self/cgroup').splitlines()
                          if line.startswith('0::')), '')
            parts = group.split('/')
            if (group.startswith('/') and parts[-1] == SERVICE_NAME
                    and '..' not in parts and '.' not in parts):
                base = '/sys/fs/cgroup' + group
                limit = int(read_text(base + '/memory.max').strip())
                swap = int(read_text(base + '/memory.swap.max').strip())
                current = int(read_text(base + '/memory.current').strip())
                quota, period = map(int, read_text(base + '/cpu.max').split())
                if 0 < limit <= MEMORY_MAX and swap == 0 and 0 < quota <= period / 2 and 0 <= current <= limit:
                    own = current
        return memory_admitted(available, own)
    except (OSError, ValueError, StopIteration):
        # Missing cgroup statistics never invent headroom. A readable absolute
        # MemAvailable still suffices; ExecCondition performs the same floor.
        return memory_admitted(available) if 'available' in locals() else False


def probe(config, *, now=None):
    """Read-only, <=30ms SQLite lock wait, no claim or credential read."""
    if not config.get('enabled'):
        return {'status': 'disabled'}
    from research_queue import APPLICATION_ID, MAX_BYTES, QUEUE_TTL
    path = Path(config['queue_path'])
    if not path.exists():
        return {'status': 'idle'}
    if path.stat().st_size > MAX_BYTES:
        return {'status': 'failed', 'error_code': 'RESEARCH_STORAGE_FULL'}
    db = None
    try:
        db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=0.03)
        db.execute('PRAGMA query_only=ON')
        db.execute('PRAGMA trusted_schema=OFF')
        if db.execute('PRAGMA application_id').fetchone()[0] != APPLICATION_ID:
            return {'status': 'failed', 'error_code': 'RESEARCH_WRONG_DATABASE'}
        now = time.time() if now is None else now
        if db.execute("SELECT 1 FROM jobs WHERE status='running' AND lease_until>? LIMIT 1", (now,)).fetchone():
            return {'status': 'busy'}
        ready = db.execute("SELECT 1 FROM jobs WHERE status='queued' AND created_at>? LIMIT 1", (now-QUEUE_TTL,)).fetchone()
        if not ready and db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_checks'").fetchone():
            ready=db.execute("""SELECT 1 FROM research_checks WHERE expires>? AND
                      (state IN ('queued','ready') OR (state IN ('publishing','checking') AND lease<=?)) LIMIT 1""",
                      (now,now)).fetchone()
        return {'status': 'ready' if ready else 'idle'}
    except sqlite3.Error as exc:
        if getattr(exc, 'sqlite_errorcode', 0) & 255 in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            return {'status': 'busy'}
        return {'status': 'failed', 'error_code': 'RESEARCH_STORE_UNAVAILABLE'}
    finally:
        if db:
            db.close()


def result_summary(result):
    allowed = {'disabled', 'idle', 'busy', 'ready', 'completed', 'empty', 'timeout', 'failed', 'low_memory'}
    status = result.get('status')
    if status not in allowed:
        return {'status': 'failed', 'error_code': 'RESEARCH_INVALID_OUTPUT'}
    summary = {'status': status}
    if result.get('stage') in ('check','publish'):
        summary['stage']=result['stage']
        if result.get('verdict') in ('supported','insufficient','conflicting','pending'):
            summary['verdict']=result['verdict']
    code = result.get('error_code')
    if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,63}', code):
        summary['error_code'] = code
    items = result.get('candidates', [])
    if isinstance(items, list):
        summary['candidate_count'] = min(3, len(items))
    metrics = result.get('metrics', {})
    if isinstance(metrics, dict):
        numbers = {key: value for key, value in metrics.items()
                   if key in {'search_calls', 'fetch_calls', 'retries', 'llm_calls', 'search_ms', 'fetch_ms',
                              'validate_ms', 'total_ms', 'raw_hits', 'discovered_hits', 'eligible_pages','hiking_profiles','rag_updates',
                              'latency_ms','prompt_tokens','completion_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens'}
                   and type(value) in (int, float) and 0 <= value <= 600000}
        if numbers:
            summary['metrics'] = numbers
    return summary


def consume(config, packet, *, admitted=None, runner=None):
    if not config.get('enabled'):
        return {'status': 'disabled'}
    if not (memory_guard() if admitted is None else admitted):
        return {'status': 'low_memory', 'error_code': 'RESEARCH_LOW_MEMORY'}
    if (not isinstance(packet, dict) or set(packet) != {'api_key'}
            or not isinstance(packet['api_key'], str) or not re.fullmatch(r'\S{8,512}', packet['api_key'])):
        return {'status': 'failed', 'error_code': 'RESEARCH_CREDENTIAL_UNAVAILABLE'}
    state = probe(config)
    if state['status'] != 'ready':
        return state
    from research_queue import ResearchQueue
    from bounded_research import run_next
    extra={}
    if not runner and config.get('store_path'):
        from rag_store import RagStore
        extra['store']=RagStore(config['store_path'])
    queue=ResearchQueue(config['queue_path'])
    result = (runner or run_next)(queue, provider='deepseek', api_key=packet['api_key'],**extra)
    if result['status']=='idle' and runner is None:
        task=queue.claim_check()
        if task:
            from research_checks import perform_check
            result=perform_check(queue,task,extra.get('store'),packet['api_key'])
    return result_summary(result)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ['--check-memory']:
        return 0 if memory_guard(compensate=False) else 1
    if argv not in (['--probe'], ['--consume']):
        result = {'status': 'failed', 'error_code': 'RESEARCH_ARGUMENTS_INVALID'}
    else:
        try:
            config = load_research_config()
            if argv == ['--probe']:
                result = probe(config) if memory_guard() else {'status': 'low_memory', 'error_code': 'RESEARCH_LOW_MEMORY'}
            else:
                raw = sys.stdin.buffer.read(4097)
                if len(raw) > 4096:
                    raise ResearchServiceError('RESEARCH_INPUT_TOO_LARGE')
                result = consume(config, json.loads(raw))
        except ResearchServiceError as exc:
            result = {'status': 'failed', 'error_code': exc.code}
        except Exception:
            result = {'status': 'failed', 'error_code': 'RESEARCH_SERVICE_FAILED'}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False) + '\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
