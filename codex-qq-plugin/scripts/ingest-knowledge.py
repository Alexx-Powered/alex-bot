"""Import explicitly selected local JSON knowledge into an independent RAG store."""
from pathlib import Path
import argparse
import json
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from rag_store import RagStore
from knowledge_ingest import ingest_file


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input',type=Path)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--allow-root',type=Path,action='append',required=True)
    parser.add_argument('--allow-namespace',action='append',default=None)
    args=parser.parse_args()
    results=ingest_file(RagStore(args.database),args.input,allowed_roots=args.allow_root,
        allowed_namespaces=args.allow_namespace or ['shared'])
    print(json.dumps({'status':'ok','documents':len(results),'changed':sum(r['changed'] for r in results),
        'records':[{'doc_id':r['doc_id'],'revision':r['revision']} for r in results]}))


if __name__=='__main__':
    main()
