"""Operator backup helper: consistent SQLite snapshot, emitted only to encrypted backup builder."""
import base64
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

source=Path('/var/lib/alexbot/.private/chat-memory/chat-memory.sqlite3')
if not source.is_file():
    sys.stdout.write('');raise SystemExit(0)
if source.is_symlink() or source.stat().st_size>4*1024*1024:raise SystemExit(1)
descriptor,name=tempfile.mkstemp(prefix='alexbot-memory-',suffix='.sqlite3')
os.close(descriptor)
try:
    with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as origin,sqlite3.connect(name) as target:
        origin.backup(target)
    sys.stdout.write(base64.b64encode(Path(name).read_bytes()).decode('ascii'))
finally:
    Path(name).unlink(missing_ok=True)
