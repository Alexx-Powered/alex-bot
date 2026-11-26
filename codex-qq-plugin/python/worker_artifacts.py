"""Worker-owned reply files. Paths and renderer entry points are never model arguments."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

DIRECTORY = Path(".private/worker-replies")
LIMITS = {"png":5*1024*1024,"jpg":5*1024*1024,"mp4":4*1024*1024}
RENDERER = Path(__file__).resolve().parents[1]/"src"/"render-worker-media.mjs"
_last_cleanup = 0.0


def publish(request_id, extension, data):
    global _last_cleanup
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", request_id) or extension not in LIMITS:
        raise ValueError("INVALID_WORKER_MEDIA")
    if not isinstance(data, bytes) or not 8 <= len(data) <= LIMITS[extension]:
        raise ValueError("INVALID_WORKER_MEDIA")
    DIRECTORY.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = time.time()
    if now - _last_cleanup > 3600:
        for entry in DIRECTORY.iterdir():
            if re.fullmatch(r"[a-f0-9-]{36}\.(png|jpg|mp4)", entry.name):
                try:
                    if entry.stat().st_mtime < now - 3600:
                        entry.unlink()
                except FileNotFoundError:
                    pass
        _last_cleanup = now
    file = DIRECTORY / (request_id+"."+extension)
    with file.open("xb") as output:
        try:
            output.write(data)
        except OSError:
            output.close()
            file.unlink(missing_ok=True)
            raise
    return {"media":extension}


def render_canvas(kind, inputs):
    if kind not in {"weather","air","status","hiking"}:
        raise ValueError("UNKNOWN_RENDERER")
    env = {key:os.environ[key] for key in ("PATH","SystemRoot","WINDIR","TEMP","TMP","HOME","USERPROFILE",
                                           "LOCALAPPDATA","QQ_FONT_REGULAR","QQ_FONT_BOLD") if key in os.environ}
    proc = subprocess.run([os.environ.get("QQ_CANVAS_NODE","node"),str(RENDERER),kind],
                          input=json.dumps(inputs,ensure_ascii=False,allow_nan=False).encode(),
                          env=env,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,check=True,timeout=35)
    if not proc.stdout.startswith(b"\x89PNG\r\n\x1a\n") or len(proc.stdout)>LIMITS["png"]:
        raise ValueError("INVALID_RENDER")
    return proc.stdout
