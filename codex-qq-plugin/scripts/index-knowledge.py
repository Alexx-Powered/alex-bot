"""Bounded offline index maintenance. Stop the Lite reader before invoking."""
from pathlib import Path
import argparse
import json
import os
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'python'))

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config',type=Path,required=True)
    p.add_argument('--batches',type=int,default=8)
    p.add_argument('--requeue',action='store_true',help='rebuild same-model index from canonical documents')
    p.add_argument('--backup',type=Path,help='create a consistent new SQLite snapshot before indexing')
    args=p.parse_args()
    if not args.config.is_absolute() or not 1<=args.batches<=32:
        p.error('absolute config and 1..32 batches required')
    os.environ['QQ_RAG_CONFIG']=str(args.config)
    from rag_runtime import load_rag_retriever
    retriever=load_rag_retriever()
    if retriever is None or retriever.index is None:
        print(json.dumps({'status':'unavailable','error_code':'RAG_VECTOR_NOT_CONFIGURED'}))
        return 1
    try:
        if args.backup:
            retriever.store.backup_to(args.backup)
        requeued=retriever.store.requeue_all() if args.requeue else 0
        processed=failed=0
        for _ in range(args.batches):
            result=retriever.process_outbox(limit=32)
            processed+=result['processed'];failed+=result['failed']
            if result['failed'] or not result['processed']:
                break
        remaining=retriever.store.outbox_summary()
        print(json.dumps({'status':'failed' if failed else 'pending' if remaining else 'ok',
                          'processed':processed,'failed':failed,'requeued':requeued,'remaining':remaining}))
        return 1 if failed else 0
    finally:
        retriever.index.close()

if __name__=='__main__':
    raise SystemExit(main())
