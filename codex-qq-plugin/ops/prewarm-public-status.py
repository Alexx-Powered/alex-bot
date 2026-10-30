"""Operator-only: cache the 31 pinned author portraits, never query/vote or send QQ."""
import json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'python'))
from public_status import liang_frame,FRAME_REVISION
for index in range(31):
    with liang_frame(index):pass
    if index%5==0 or index==30:print(json.dumps({'portrait_count':index+1,'revision':FRAME_REVISION}),flush=True)
