"""Bounded, content-free progress from a serial video worker and its download threads."""
from contextlib import contextmanager
from threading import Lock
import time
from trace_errors import error_fields

_emit = None
_samples = None
_lock = Lock()


@contextmanager
def reporting(emit):
    global _emit
    previous, _emit = _emit, emit
    try:
        yield
    finally:
        _emit = previous


@contextmanager
def stage(name, fallback_on=()):
    global _samples
    if _emit is None:
        yield
        return
    started = time.perf_counter()
    _emit(dict(stage=name, phase='start',startedAtMs=time.time_ns() // 1_000_000))
    previous, _samples = _samples, {}
    status = 'ok'
    details = {}
    try:
        yield
    except BaseException as error:
        status = 'fallback' if isinstance(error, fallback_on) else 'error'
        details = error_fields(error)
        raise
    finally:
        samples, _samples = _samples, previous
        _emit(dict(stage=name, phase=status, ms=round((time.perf_counter()-started)*1000,3), samples=list(samples.values()), **details))


@contextmanager
def sample(name):
    # Report the actual slowest interval once, plus summed work over all calls.
    # Parallel downloads may overlap, so total_work_ms is not wall-clock time.
    samples = _samples
    if samples is None:
        yield
        return
    wall = time.time_ns() // 1_000_000
    start = time.perf_counter()
    status = 'ok'
    details = {}
    try:
        yield
    except BaseException as error:
        status = 'error'
        details = error_fields(error)
        raise
    finally:
        elapsed = round((time.perf_counter()-start)*1000, 3)
        with _lock:
            row = samples.setdefault(name,dict(name=name,calls=0,workMs=0,ms=-1))
            row['calls'] += 1
            row['workMs'] += elapsed
            if elapsed > row['ms']:
                for key in ('errorCode','causeCode','httpStatus'):
                    row.pop(key, None)
                row.update(startedAtMs=wall,ms=elapsed,status=status,**details)
