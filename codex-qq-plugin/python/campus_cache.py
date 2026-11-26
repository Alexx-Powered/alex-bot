"""Shared, bounded snapshots for the scheduled and conversational classroom workers."""
import json
import os
import time
from contextlib import contextmanager
from datetime import date, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile

from campus_classrooms import CampusError, NAME, PAGE, SCHEMA


def _validated(data):
    # Only store the original public classroom projection, never a packet or credentials.
    fields = {'schema_version','ok','code','campus','date','fetched_at','source','semantics','buildings','rooms'}
    if (not isinstance(data, dict) or data.keys() != fields or data['schema_version'] != SCHEMA
            or data['ok'] is not True or data['code'] != 'OK' or data['source'] != PAGE
            or data['campus'] != '学院路校区' or data['semantics'] != '接口标空闲则为空闲，其余课节为有课；保留接口给出的节次。'
            or date.fromisoformat(data['date']).isoformat() != data['date']
            or datetime.fromisoformat(data['fetched_at'].replace('Z','+00:00')).tzinfo is None):
        raise ValueError('CAMPUS_SCHEMA_CHANGED')
    buildings, rooms = data['buildings'], data['rooms']
    if (not isinstance(buildings,list) or len(buildings)>30 or not all(isinstance(b,str) and NAME.fullmatch(b) for b in buildings)
            or not isinstance(rooms,list) or len(rooms)>600):
        raise ValueError('CAMPUS_SCHEMA_CHANGED')
    identities = set()
    for room in rooms:
        if not isinstance(room,dict) or room.keys() != {'building','room','free_periods','busy_periods'}:
            raise ValueError('CAMPUS_SCHEMA_CHANGED')
        identity = room['building'], room['room']
        if identity in identities or identity[0] not in buildings or not NAME.fullmatch(identity[1]):
            raise ValueError('CAMPUS_SCHEMA_CHANGED')
        identities.add(identity)
        periods = room['free_periods'] + room['busy_periods']
        if not all(type(p) is int for p in periods) or sorted(periods) != list(range(1,15)):
            raise ValueError('CAMPUS_SCHEMA_CHANGED')
    return data


@contextmanager
def query_slot(private, timeout=25):
    """One browser owner, also across a console query and a chat worker."""
    directory = Path(private) / 'campus-output'
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    with (directory/'query.lock').open('a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            if handle.tell()==0:
                handle.write(b'0'); handle.flush()
            handle.seek(0)
            lock = lambda: msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            unlock = lambda: msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            lock = lambda: fcntl.flock(handle,fcntl.LOCK_EX | fcntl.LOCK_NB)
            unlock = lambda: fcntl.flock(handle,fcntl.LOCK_UN)
        until = time.monotonic()+timeout
        while True:
            try:
                lock()
                break
            except (PermissionError,BlockingIOError):
                if time.monotonic()>=until:
                    raise CampusError('CAMPUS_BUSY') from None
                time.sleep(.1)
        try:
            yield
        finally:
            unlock()


def _json(path,limit):
    with path.open('rb') as handle:
        raw = handle.read(limit+1)
    if len(raw)>limit:
        raise ValueError('CAMPUS_CACHE_TOO_LARGE')
    return json.loads(raw)


def snapshots(private):
    directory = Path(private)/'campus-output'
    try:
        saved = _json(directory/'memory.json',2_000_000)
        rows = saved['snapshots']
        if saved['version'] != 1 or not isinstance(rows,list) or len(rows)>8:
            raise ValueError('CAMPUS_SCHEMA_CHANGED')
        return {row['date']:_validated(row) for row in rows}
    except (ValueError,KeyError,TypeError,OSError,AttributeError):
        try:
            last = _validated(_json(directory/'latest.json',262144))
            return {last['date']:last}
        except (ValueError,KeyError,TypeError,OSError,AttributeError):
            return {}


def _atomic_json(path, data):
    tmp = NamedTemporaryFile('w',encoding='utf-8',dir=path.parent,delete=False)
    try:
        with tmp:
            json.dump(data,tmp,ensure_ascii=False,separators=(',',':'),allow_nan=False)
        os.replace(tmp.name,path)
    finally:
        Path(tmp.name).unlink(missing_ok=True)


def remember(private,data):
    """Called while the collector owns query_slot."""
    _validated(data)
    rows = snapshots(private)
    rows.pop(data['date'],None)
    rows[data['date']] = data
    output = Path(private)/'campus-output'
    _atomic_json(output/'memory.json',{'version':1,'snapshots':list(rows.values())[-8:]})
    _atomic_json(output/'latest.json',data)
