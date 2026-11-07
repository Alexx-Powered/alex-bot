"""Operator-only seed import into configured canonical SQLite; no Milvus owner."""
import json,os,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from hiking_catalog import seed_profiles,ingest_profile
from rag_store import RagStore
def main():
    config=Path(os.environ.get('QQ_RAG_CONFIG','/var/lib/alexbot/.private/rag-config.json'))
    if not config.is_absolute() or config.is_symlink() or config.stat().st_size>16384:raise ValueError('RAG_CONFIG_INVALID')
    value=json.loads(config.read_text(encoding='utf-8'))
    path=Path(value['store_path'])
    if not value.get('enabled') or not path.is_absolute() or path.is_symlink():raise ValueError('RAG_CONFIG_INVALID')
    store=RagStore(path);profiles=seed_profiles()
    for p in profiles:ingest_profile(store,p,now=p['checked_at'])
    print(json.dumps({'ok':True,'profiles':len(profiles),'routes':len({p['topic'] for p in profiles}),'index':'outbox'}))
if __name__=='__main__':main()
