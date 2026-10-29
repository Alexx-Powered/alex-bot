"""Render a deterministic QQ summary from this query's verified observations."""
import argparse
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone, timedelta
from PIL import Image, ImageDraw, ImageFont
import plan

VERSION = 'study-briefing-v1'
TZ = timezone(timedelta(hours=8))

def render(input_path, out_dir, *, reviewed=False, demo=False):
    input_path, out_dir = Path(input_path), Path(out_dir)
    if input_path.stat().st_size > 256_000:
        raise ValueError('INPUT_TOO_LARGE')
    data = json.loads(input_path.read_text(encoding='utf-8-sig'))
    if not isinstance(data.get('rows'), list) or not 1 <= len(data['rows']) <= 300:
        raise ValueError('INVALID_ROW_COUNT')
    result = plan.analyze(data)
    from briefing_layout import render_board
    out_dir.mkdir(parents=True, exist_ok=True)
    image_path=out_dir/'study-briefing.png'
    render_board(result, reviewed, demo).save(image_path, optimize=True)
    image_bytes=image_path.read_bytes()
    if len(image_bytes)>1_500_000:
        raise ValueError('IMAGE_TOO_LARGE')
    identity=json.dumps({'version':VERSION,'date':result['date'],'rooms':result['rooms'],'demo':demo},ensure_ascii=False,sort_keys=True).encode()
    manifest={'version':VERSION,'date':result['date'],'reviewed':reviewed,'demo':demo,'image':'study-briefing.png',
              'sha256':hashlib.sha256(image_bytes).hexdigest(),'idempotencyKey':'study:'+hashlib.sha256(identity).hexdigest(),
              'generatedAt':datetime.now(TZ).isoformat(),'roomCount':len(result['rooms'])}
    (out_dir/'briefing-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    return manifest

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('input',type=Path); p.add_argument('--out-dir',type=Path,required=True)
    p.add_argument('--reviewed',action='store_true');p.add_argument('--demo',action='store_true')
    args=p.parse_args()
    try:
        m=render(args.input,args.out_dir,reviewed=args.reviewed,demo=args.demo)
        print(json.dumps({'ok':True,'image':str(args.out_dir/'study-briefing.png'),'date':m['date'],'reviewed':m['reviewed']},ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok':False,'code':'BRIEFING_FAILED','errorType':type(e).__name__}));raise SystemExit(1)
