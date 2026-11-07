"""Operator-only canonical RAG/climate backup; stdout is private backup input.

No model, credentials helper, network or Milvus import. SQLite backup() includes
committed WAL data; the two independent databases each have a consistent snapshot.
"""
from __future__ import annotations
import argparse
import base64
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

MAX_BYTES=16*1024*1024
MAX_INPUT=24*1024*1024
MANIFEST='.private/rag-backup-manifest.json'
SCHEMA='alexbot.rag-backup.v1'


def fail(code):
    raise ValueError(code)


def safe_path(root, value, *, existing=True):
    root=Path(root).absolute()
    candidate=Path(value)
    if not candidate.is_absolute(): fail('RAG_BACKUP_PATH')
    candidate=candidate.absolute()
    try: relative=candidate.relative_to(root/'.private')
    except ValueError: fail('RAG_BACKUP_PATH')
    if '..' in candidate.parts or not relative.parts: fail('RAG_BACKUP_PATH')
    for item in (candidate,*candidate.parents):
        if item.is_symlink(): fail('RAG_BACKUP_PATH')
    if existing and not candidate.is_file(): fail('RAG_BACKUP_MISSING')
    return candidate


def inspect_database(db, kind):
    if db.execute('PRAGMA quick_check').fetchone()!=('ok',): fail('RAG_BACKUP_INTEGRITY')
    if kind=='research':
        if db.execute('PRAGMA application_id').fetchone()[0]!=0x52455155: fail('RAG_BACKUP_SCHEMA')
    elif db.execute('PRAGMA user_version').fetchone()[0]!=1: fail('RAG_BACKUP_SCHEMA')
    tables={row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    expected=({'jobs','candidates'} if kind=='research' else
              {'rag_documents','rag_chunks','index_outbox','index_manifests'} if kind=='rag' else
              {'climate_places','climate_years','climate_refresh','climate_failures'})
    if not expected<=tables: fail('RAG_BACKUP_SCHEMA')
    if db.execute('PRAGMA foreign_key_check').fetchone(): fail('RAG_BACKUP_INTEGRITY')
    if kind=='research':
        if db.execute("SELECT 1 FROM jobs WHERE status NOT IN ('queued','running','completed','empty','failed','timeout','cancelled') LIMIT 1").fetchone():
            fail('RAG_BACKUP_SCHEMA')
        if db.execute("SELECT 1 FROM candidates WHERE state NOT IN ('candidate','approved') LIMIT 1").fetchone():
            fail('RAG_BACKUP_SCHEMA')
        return {'jobs':db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0],
                'candidates':db.execute('SELECT COUNT(*) FROM candidates').fetchone()[0],
                'approved':db.execute("SELECT COUNT(*) FROM candidates WHERE state='approved'").fetchone()[0]}
    if kind=='rag':
        invalid=db.execute("""SELECT 1 FROM rag_documents WHERE
            visibility NOT IN ('private','shared') OR
            (visibility='shared' AND namespace!='shared') OR
            (domain='project' AND visibility!='private') OR
            domain NOT IN ('campus','weather','bot','outdoor','project') OR
            status NOT IN ('active','superseded','deleted') LIMIT 1""").fetchone()
        mixed=db.execute('SELECT doc_id FROM rag_documents GROUP BY doc_id HAVING COUNT(DISTINCT namespace)>1 LIMIT 1').fetchone()
        if invalid or mixed: fail('RAG_BACKUP_SCOPE')
        return {'documents':db.execute('SELECT COUNT(*) FROM rag_documents').fetchone()[0],
                'shared_documents':db.execute("SELECT COUNT(*) FROM rag_documents WHERE visibility='shared' AND status='active'").fetchone()[0],
                'private_documents':db.execute("SELECT COUNT(*) FROM rag_documents WHERE visibility='private' AND status='active'").fetchone()[0],
                'chunks':db.execute('SELECT COUNT(*) FROM rag_chunks').fetchone()[0]}
    if db.execute('SELECT 1 FROM climate_years y LEFT JOIN climate_places p USING(place_id) WHERE p.place_id IS NULL LIMIT 1').fetchone():
        fail('RAG_BACKUP_INTEGRITY')
    return {'places':db.execute('SELECT COUNT(*) FROM climate_places').fetchone()[0],
            'years':db.execute('SELECT COUNT(*) FROM climate_years').fetchone()[0]}


def snapshot_database(source, kind):
    if source.stat().st_size>MAX_BYTES: fail('RAG_BACKUP_CAPACITY')
    deadline=time.monotonic()+15
    def progress(*_):
        if time.monotonic()>deadline: fail('RAG_BACKUP_TIMEOUT')
    with closing(sqlite3.connect(source.as_uri()+'?mode=ro',uri=True,timeout=2)) as origin, closing(sqlite3.connect(':memory:')) as target:
        if origin.execute('PRAGMA page_count').fetchone()[0]*origin.execute('PRAGMA page_size').fetchone()[0]>MAX_BYTES:
            fail('RAG_BACKUP_CAPACITY')
        origin.backup(target,pages=128,progress=progress,sleep=.01)
        summary=inspect_database(target,kind)
        raw=target.serialize()
        # backup() has already folded committed WAL pages into this independent
        # image. SQLite deserialize requires rollback-mode header bytes:
        # https://www.sqlite.org/c3ref/deserialize.html (bytes 18 and 19).
        if raw[:16]!=b'SQLite format 3\x00': fail('RAG_BACKUP_FORMAT')
        raw=raw[:18]+b'\x01\x01'+raw[20:]
    if len(raw)>MAX_BYTES: fail('RAG_BACKUP_CAPACITY')
    return raw,summary


def encode(raw): return base64.b64encode(raw).decode('ascii')
def digest(raw): return hashlib.sha256(raw).hexdigest()


def snapshot(root, config_path=None):
    root=Path(root).absolute()
    explicit=config_path or os.environ.get('QQ_RAG_CONFIG')
    config_path=Path(explicit) if explicit else root/'.private/rag-config.json'
    if not explicit and not config_path.exists(): return {'files':{},'included':False}
    config_path=safe_path(root,config_path)
    raw=config_path.read_bytes()
    if len(raw)>16384: fail('RAG_BACKUP_CONFIG')
    config=json.loads(raw)
    if not isinstance(config,dict): fail('RAG_BACKUP_CONFIG')
    paths={'config':config_path}
    if config.get('store_path'): paths['rag']=safe_path(root,config['store_path'])
    elif config.get('enabled') is True: fail('RAG_BACKUP_CONFIG')
    outdoor=config.get('outdoor')
    if outdoor is not None:
        if not isinstance(outdoor,dict) or not outdoor.get('climate_path'): fail('RAG_BACKUP_CONFIG')
        paths['climate']=safe_path(root,outdoor['climate_path'])
    research=config.get('research')
    if research is not None:
        if not isinstance(research,dict) or not research.get('queue_path'): fail('RAG_BACKUP_CONFIG')
        paths['research']=safe_path(root,research['queue_path'])
    if len(set(paths.values()))!=len(paths) or any(p==root/MANIFEST for p in paths.values()): fail('RAG_BACKUP_PATH')
    files={paths['config'].relative_to(root).as_posix():encode(raw)}
    entries={'config':{'name':paths['config'].relative_to(root).as_posix(),'sha256':digest(raw),'bytes':len(raw)}}
    size=len(raw)
    for kind,source in paths.items():
        if kind=='config': continue
        content,summary=snapshot_database(source,kind)
        size+=len(content)
        if size>MAX_BYTES: fail('RAG_BACKUP_CAPACITY')
        name=source.relative_to(root).as_posix()
        files[name]=encode(content)
        entries[kind]={'name':name,'sha256':digest(content),'bytes':len(content),'summary':summary}
    if raw!=config_path.read_bytes(): fail('RAG_BACKUP_CONFIG_CHANGED')
    manifest={'schema_version':SCHEMA,'root':str(root),'entries':entries,
              'vector_policy':'excluded_rebuild_from_canonical','independent_sqlite_snapshots':True}
    files[MANIFEST]=encode(json.dumps(manifest,ensure_ascii=False).encode())
    return {'included':True,'files':files}


def validate(files):
    if not isinstance(files,dict): fail('RAG_BACKUP_FORMAT')
    if MANIFEST not in files: return None
    manifest=json.loads(base64.b64decode(files[MANIFEST],validate=True))
    if manifest.get('schema_version')!=SCHEMA or manifest.get('vector_policy')!='excluded_rebuild_from_canonical':
        fail('RAG_BACKUP_FORMAT')
    entries=manifest.get('entries')
    if not isinstance(entries,dict) or 'config' not in entries or set(entries)-{'config','rag','climate','research'}: fail('RAG_BACKUP_FORMAT')
    source_root=manifest.get('root')
    # Pure lexical check also supports Linux packet verification on Windows.
    from pathlib import PurePosixPath, PureWindowsPath
    root=PureWindowsPath(source_root) if source_root and '\\' in source_root else PurePosixPath(source_root or '')
    if not root.is_absolute(): fail('RAG_BACKUP_PATH')
    content={};size=0;names=set()
    for kind,entry in entries.items():
        name=entry['name'];parts=PurePosixPath(name).parts
        if not isinstance(name,str) or '\\' in name or len(parts)<2 or parts[0]!='.private' or '..' in parts or name in names or name==MANIFEST:
            fail('RAG_BACKUP_PATH')
        names.add(name)
        raw=base64.b64decode(files[name],validate=True);size+=len(raw)
        if size>MAX_BYTES or len(raw)!=entry['bytes'] or digest(raw)!=entry['sha256']: fail('RAG_BACKUP_INTEGRITY')
        content[kind]=raw
        if kind!='config':
            with closing(sqlite3.connect(':memory:')) as db:
                db.deserialize(raw)
                if inspect_database(db,kind)!=entry['summary']: fail('RAG_BACKUP_INTEGRITY')
    if len(content['config'])>16384: fail('RAG_BACKUP_CONFIG')
    config=json.loads(content['config'])
    if not isinstance(config,dict): fail('RAG_BACKUP_CONFIG')
    for kind,value in [('rag',config.get('store_path')),('climate',(config.get('outdoor') or {}).get('climate_path')),
                       ('research',(config.get('research') or {}).get('queue_path'))]:
        if kind in entries:
            if not isinstance(value,str) or root.joinpath(*PurePosixPath(entries[kind]['name']).parts)!=type(root)(value): fail('RAG_BACKUP_PATH')
        elif value: fail('RAG_BACKUP_MISSING')
    if config.get('enabled') is True and 'rag' not in entries: fail('RAG_BACKUP_MISSING')
    return manifest,content,config


def verify(files):
    checked=validate(files)
    if checked is None: return {'included':False}
    manifest,_,_=checked
    return {'included':True,'sqlite_integrity_verified':True,'scope_verified':True,
            'config_paths_verified':True,'vector_rebuild_required':True,
            'databases':{kind:entry['summary'] for kind,entry in manifest['entries'].items() if kind!='config'}}


def restore(files, root):
    checked=validate(files)
    if checked is None: fail('RAG_BACKUP_MISSING')
    manifest,content,config=checked
    root=Path(root)
    if not root.is_absolute() or '..' in root.parts or any(p.is_symlink() for p in (root,*root.parents)):
        fail('RAG_BACKUP_PATH')
    if root.exists() and (not root.is_dir() or any(root.iterdir())): fail('RAG_RESTORE_NOT_EMPTY')
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    outputs={}
    for kind,entry in manifest['entries'].items():
        destination=safe_path(root,root/entry['name'],existing=False)
        if kind=='config': continue
        outputs[destination]=content[kind]
        if kind=='rag': config['store_path']=str(destination)
        elif kind=='climate': config['outdoor']['climate_path']=str(destination)
        else:
            config['research']['queue_path']=str(destination)
            config['research']['enabled']=False
    # Original vector URI may reference a live old index or a different host.
    # Restore works in canonical lexical mode until the operator rebuilds it.
    config.pop('vector',None)
    if isinstance(config.get('embedding'),dict): config['embedding'].pop('cache_dir',None)
    config_path=root/manifest['entries']['config']['name']
    outputs[config_path]=json.dumps(config,ensure_ascii=False,indent=2).encode()
    for destination,raw in outputs.items():
        destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with open(destination,'xb') as stream: stream.write(raw)
        if os.name!='nt': destination.chmod(0o600)
    return {'restored':True,'files':len(outputs),'config_path':str(config_path),
            'vector_rebuild_required':True,'sending_enabled_by_restore':False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['snapshot','verify','restore'])
    parser.add_argument('--root',default='/var/lib/alexbot')
    parser.add_argument('--config')
    args=parser.parse_args()
    if args.mode=='snapshot': value=snapshot(args.root,args.config)
    else:
        raw=sys.stdin.buffer.read(MAX_INPUT+1)
        if len(raw)>MAX_INPUT: fail('RAG_BACKUP_CAPACITY')
        files=json.loads(raw)
        value=verify(files) if args.mode=='verify' else restore(files,args.root)
    sys.stdout.write(json.dumps(value,ensure_ascii=False))


if __name__=='__main__':
    try: main()
    except Exception:
        sys.stderr.write('RAG_BACKUP_OPERATION_FAILED\n');sys.exit(1)
