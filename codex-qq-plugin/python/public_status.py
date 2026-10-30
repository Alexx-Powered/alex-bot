"""Read-only public status tools. Sources, browser actions and output are fixed."""
from __future__ import annotations

import gzip
import hashlib
import io
import ipaddress
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from langchain.tools import tool
from pydantic import BaseModel, ConfigDict

SOURCES = {"deepseek": "https://status.deepseek.com/", "liang": "https://liang.itsuyo.top/"}
OUTPUT = Path(".private/public-status")
FRAME_REVISION = "27df48e3fa2f0b7b841fdf61e69b9c6db43c4713"
FRAME_CACHE = Path(".private/public-status-frames")
FRAME_ORIGIN = "https://raw.githubusercontent.com/Abyss-Seeker/liang-intensity-calibrator/" + FRAME_REVISION + "/public/frames/"
MAX_BODY = 2_000_000
TZ = timezone(timedelta(hours=8))
STATES = {"operational": "正常", "maintenance": "维护中", "degraded": "性能下降",
          "partial_outage": "部分故障", "full_outage": "服务中断", "unknown": "状态未知"}
ORDER = {key: i for i, key in enumerate(STATES)}
STAGES = ("小难梁", "牢梁", "梁子", "梁圣", "梁神", "梁祖")


class NoArgs(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("STATUS_REDIRECT_DENIED")


def stamp():
    return datetime.now(TZ).isoformat(timespec="seconds")


def clean(value, limit=150):
    if not isinstance(value, str):
        raise ValueError("STATUS_SCHEMA_CHANGED")
    return re.sub(r"[\x00-\x1f\x7f@<>]", " ", value).strip()[:limit]


def fetch_deepseek():
    request = Request(SOURCES["deepseek"], headers={"User-Agent": "Mozilla/5.0 AlexQQ-Status/1.0",
                      "Accept": "text/html", "Accept-Encoding": "identity", "Cache-Control": "no-cache"})
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        raw = response.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError("STATUS_TOO_LARGE")
    if raw.startswith(b"\x1f\x8b"):
        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError("STATUS_TOO_LARGE")
    return raw.decode("utf-8")


class FlightParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.in_script = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        self.in_script = tag == "script" if tag == "script" else self.in_script

    def handle_endtag(self, tag):
        if tag == "script":
            self.in_script = False

    def handle_data(self, data):
        if not self.in_script or not data.startswith("self.__next_f.push("):
            return
        value, _ = json.JSONDecoder().raw_decode(data[len("self.__next_f.push("):])
        if isinstance(value, list) and len(value) == 2 and value[0] == 1 and isinstance(value[1], str):
            self.parts.append(value[1])


def parse_deepseek(html, now=None):
    """Read the same initialData/affected_components used by the official page."""
    if not isinstance(html, str) or len(html.encode("utf-8")) > MAX_BODY:
        raise ValueError("STATUS_SCHEMA_CHANGED")
    parser = FlightParser()
    parser.feed(html)
    flight = "".join(parser.parts)
    match = re.search(r'"initialData":', flight)
    if not match:
        raise ValueError("STATUS_SCHEMA_CHANGED")
    data, size = json.JSONDecoder().raw_decode(flight[match.end():])
    suffix = flight[match.end() + size:]
    updated_match = re.match(r',"initialDataUpdatedAt":(\d{13})', suffix)
    instant = now or datetime.now(timezone.utc)
    if not updated_match or not -60 <= instant.timestamp() - int(updated_match[1]) / 1000 <= 300:
        raise ValueError("STATUS_STALE")
    page, changes = data.get("page", {}), data.get("active_changes")
    components = page.get("components")
    if page.get("custom_domain") != "status.deepseek.com" or page.get("name") != "DeepSeek" or not isinstance(components, list) or not 1 <= len(components) <= 40 or not isinstance(changes, list) or len(changes) > 50:
        raise ValueError("STATUS_SCHEMA_CHANGED")
    rows, seen = [], set()
    for component in components:
        cid = component.get("component_id")
        if not isinstance(cid, str) or not cid or cid in seen:
            raise ValueError("STATUS_SCHEMA_CHANGED")
        seen.add(cid)
        rows.append({"id": cid, "name": clean(component.get("name"), 100), "status": "operational"})
    incidents = []
    for change in changes:
        if change.get("status") in {"resolved", "completed", "cancelled", "scheduled"}:
            continue
        affected = change.get("affected_components")
        if not isinstance(affected, list) or len(affected) > 40:
            raise ValueError("STATUS_SCHEMA_CHANGED")
        incidents.append({"title": clean(change.get("title") or change.get("name") or "官方正在处理的事件"),
                          "status": clean(change.get("status", "unknown"), 40)})
        for item in affected:
            state = item.get("status", "unknown")
            if state not in STATES:
                state = "unknown"
            for row in rows:
                if item.get("component_id") == row["id"] and ORDER[state] > ORDER[row["status"]]:
                    row["status"] = state
    # An event with no recognized impacts must not become an 'all normal' claim.
    overall = max((row["status"] for row in rows), key=ORDER.get)
    if incidents and overall == "operational":
        overall = "unknown"
    return {"overall": overall, "components": [{"name": r["name"], "status": r["status"]} for r in rows],
            "incidents": incidents[:5], "source_updated_at": datetime.fromtimestamp(int(updated_match[1]) / 1000, TZ).isoformat(timespec="seconds")}


def parse_liang_prefix(text):
    """Parse top-level JSON metadata before the large historical events array.

    The publisher's API emits tally fields first. Stop before events rather
    than downloading the history; a slow/broken history stream is irrelevant.
    """
    decoder, data, position = json.JSONDecoder(), {}, 0
    text = text.lstrip()
    if not text:
        return None
    if text[0] != '{':
        raise ValueError('STATUS_SCHEMA_CHANGED')
    position = 1
    try:
        for _ in range(30):
            while position < len(text) and text[position].isspace(): position += 1
            key, size = decoder.raw_decode(text[position:])
            position += size
            while position < len(text) and text[position].isspace(): position += 1
            if position >= len(text): return None
            if not isinstance(key, str) or text[position] != ':' or key in data:
                raise ValueError('STATUS_SCHEMA_CHANGED')
            position += 1
            if key == 'events':
                required = {'up','down','level','weightedUp','weightedDown'}
                if not required.issubset(data) or not all(isinstance(data[k], (int,float)) and not isinstance(data[k],bool) and math.isfinite(data[k]) for k in required):
                    raise ValueError('STATUS_SCHEMA_CHANGED')
                if not -30 <= data['level'] <= 60 or any(data[k] < 0 for k in required - {'level'}):
                    raise ValueError('STATUS_SCHEMA_CHANGED')
                if any(not isinstance(data[k], int) or data[k] > 10**12 for k in ('up','down')):
                    raise ValueError('STATUS_SCHEMA_CHANGED')
                rounded = min(30, max(0, math.floor(data['level'] + .5)))
                return {'level':format(data['level'],'.4f'),'stage':STAGES[rounded//6],
                        'frame':rounded,'up':data['up'],'down':data['down'],'half_life_hours':18}
            while position < len(text) and text[position].isspace(): position += 1
            value, size = decoder.raw_decode(text[position:])
            data[key] = value
            position += size
            while position < len(text) and text[position].isspace(): position += 1
            if position >= len(text): return None
            if text[position] != ',': raise ValueError('STATUS_SCHEMA_CHANGED')
            position += 1
    except json.JSONDecodeError:
        return None
    raise ValueError('STATUS_SCHEMA_CHANGED')


def fetch_liang_vote():
    # Use the system HTTPS transport's compression/ALPN support on ECS's weak
    # Cloudflare route. Only one fixed read-only URL; never shell or model args.
    url = SOURCES['liang'] + 'api/vote?status_query=' + str(int(time.time()))
    if sys.platform=='win32':
        # urllib honors Windows' existing system proxy settings. No proxy
        # credentials/settings are read, copied or added to our configuration.
        request=Request(url,headers={'User-Agent':'Mozilla/5.0','Accept-Encoding':'identity','Cache-Control':'no-cache'})
        with build_opener(NoRedirect()).open(request,timeout=12) as response:
            return read_liang_stream(response)
    curl = str(Path(os.environ.get('SystemRoot','C:/Windows'))/'System32/curl.exe') if sys.platform=='win32' else '/usr/bin/curl'
    # Try at most two IPv4 routes returned by the origin's own DNS. Some ECS
    # routes stall after TCP connects. Host/SNI and certificate verification
    # stay liang.itsuyo.top; no caller-selected addresses or TLS exceptions.
    addresses=sorted({item[4][0] for item in socket.getaddrinfo('liang.itsuyo.top',443,socket.AF_INET,socket.SOCK_STREAM)
                      if ipaddress.ip_address(item[4][0]).is_global},key=ipaddress.ip_address)[:2]
    for address in addresses:
        args=[curl,'-q','--ipv4','--no-buffer','--fail','--silent','--compressed','--connect-timeout','4','--max-time','10',
              '--max-filesize','2000000','--resolve','liang.itsuyo.top:443:'+address,'--header','Cache-Control: no-cache','--url',url]
        process=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,
                                 shell=False,creationflags=0)
        try:
            return read_liang_stream(process.stdout)
        except (ValueError,OSError):
            pass
        finally:
            if process.poll() is None:process.terminate()
            try:process.wait(timeout=2)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
            process.stdout.close()
    raise ValueError('STATUS_SOURCE_UNAVAILABLE')


def read_liang_stream(stream):
    started,body=time.monotonic(),b''
    while len(body)<16384 and time.monotonic()-started<20:
        chunk=stream.read1(4096)
        if not chunk:break
        body+=chunk
        if len(body)>16384:break
        try:facts=parse_liang_prefix(body.decode('utf8'))
        except UnicodeDecodeError:continue
        if facts:return facts
    raise ValueError('STATUS_SOURCE_UNAVAILABLE')


def liang_frame(index):
    """Immutable author key frame, bounded internal index; never a caller URL."""
    from PIL import Image
    if not isinstance(index,int) or isinstance(index,bool) or not 0 <= index <= 30:
        raise ValueError('STATUS_FRAME_INVALID')
    FRAME_CACHE.mkdir(mode=0o700,parents=True,exist_ok=True)
    target=FRAME_CACHE/f'frame-{index:02d}.webp'
    manifest_file=FRAME_CACHE/'manifest.json'
    manifest={}
    try:
        if manifest_file.stat().st_size > 20000 or target.stat().st_size > 500000: raise ValueError('INVALID_CACHE')
        manifest=json.loads(manifest_file.read_text(encoding='utf8'))
        raw=target.read_bytes()
        if manifest.get('revision')!=FRAME_REVISION or hashlib.sha256(raw).hexdigest()!=manifest['frames'][str(index)]['sha256']:
            raise ValueError('INVALID_CACHE')
        with Image.open(io.BytesIO(raw)) as image:
            if image.size!=(1254,1254):raise ValueError('INVALID_CACHE')
            return image.convert('RGB')
    except Exception:
        pass
    request=Request(FRAME_ORIGIN+f'frame-{index:02d}.png',headers={'User-Agent':'Mozilla/5.0','Accept':'image/png'})
    with build_opener(NoRedirect()).open(request,timeout=12) as response:raw=response.read(3500001)
    if len(raw)>3500000:raise ValueError('STATUS_IMAGE_TOO_LARGE')
    source_sha=hashlib.sha256(raw).hexdigest()
    with Image.open(io.BytesIO(raw)) as image:
        if image.size!=(1254,1254):raise ValueError('STATUS_IMAGE_INVALID')
        image=image.convert('RGB')
    buffer=io.BytesIO();image.save(buffer,format='WEBP',quality=90)
    cached=buffer.getvalue();target.write_bytes(cached);target.chmod(0o600)
    # Worker calls are serial; the operator's prewarm is also serial.
    try:manifest=json.loads(manifest_file.read_text(encoding='utf8'))
    except Exception:manifest={}
    if manifest.get('revision')!=FRAME_REVISION:manifest={'revision':FRAME_REVISION,'frames':{}}
    manifest['frames'][str(index)]={'sha256':hashlib.sha256(cached).hexdigest(),'source_sha256':source_sha}
    manifest_file.write_text(json.dumps(manifest),encoding='utf8');manifest_file.chmod(0o600)
    return image


def render_liang(facts, checked_at):
    from PIL import Image,ImageDraw
    portrait=liang_frame(facts['frame'])
    image=Image.new('RGB',(1080,1410),'#f5f1eb');draw=ImageDraw.Draw(image)
    draw.rounded_rectangle((28,25,1052,185),radius=24,fill='#a9613e')
    draw.text((57,43),'滑动变祖器',font=_font(45,True),fill='white')
    draw.text((57,113),facts['stage']+' · '+facts['level']+' 级',font=_font(36,True),fill='white')
    image.paste(portrait.resize((800,800),Image.Resampling.LANCZOS),(140,210))
    y=1055
    draw.rounded_rectangle((64,y,1016,y+16),radius=8,fill='#dfcaba')
    x=64+952*min(30,max(0,float(facts['level'])))/30
    draw.rounded_rectangle((64,y,max(80,x),y+16),radius=8,fill='#b66b40')
    draw.ellipse((x-13,y-5,x+13,y+21),fill='#834424')
    for i,name in enumerate(STAGES):
        left=64+i*952/5;offset=draw.textlength(name,font=_font(25))/2
        draw.text((min(990-offset,max(20,left-offset)),y+34),name,font=_font(25),fill='#473c35')
    draw.text((70,1149),f"社区投票  ▲ {facts['up']}    ▼ {facts['down']}",font=_font(31,True),fill='#4c3a2e')
    draw.text((70,1200),'默认18小时半衰期',font=_font(25),fill='#705d4e')
    draw.line((55,1255,1025,1255),fill='#dacdc1',width=2)
    draw.text((55,1280),checked_at.replace('T',' ')[:19]+'  北京时间',font=_font(24),fill='#65564a')
    draw.text((55,1320),'来源 '+SOURCES['liang'],font=_font(24),fill='#65564a')
    draw.text((55,1360),'素材 github.com/Abyss-Seeker/liang-intensity-calibrator',font=_font(21),fill='#786b61')
    buffer=io.BytesIO();image.save(buffer,format='PNG',optimize=True)
    return buffer.getvalue()


def _font(size, bold=False):
    from PIL import ImageFont
    from render_fonts import font_path
    return ImageFont.truetype(font_path(bold), size)


def _wrap(draw, text, font, width):
    lines, current = [], ""
    for char in text:
        if current and draw.textlength(current + char, font=font) > width:
            lines.append(current)
            current = ""
        current += char
    return lines + [current]


def render_deepseek(facts, checked_at):
    from PIL import Image, ImageDraw
    rows = facts["components"]
    image = Image.new("RGB", (1080, 290 + 110 * len(rows) + 75 * len(facts["incidents"])), "#f5f7fc")
    draw = ImageDraw.Draw(image)
    title, normal, small = _font(45, True), _font(30), _font(24)
    draw.rounded_rectangle((28, 25, 1052, 190), radius=24, fill="#344cba")
    draw.text((58, 45), "DeepSeek 服务状态", font=title, fill="white")
    draw.text((58, 114), "官方状态：" + STATES[facts["overall"]], font=normal, fill="white")
    y = 210
    colors = {"operational": "#287443", "maintenance": "#856221", "degraded": "#a6660b", "partial_outage": "#b63d38", "full_outage": "#a31d25", "unknown": "#696b78"}
    for row in rows:
        draw.rounded_rectangle((28, y, 1052, y + 98), radius=16, fill="white")
        for i, line in enumerate(_wrap(draw, row["name"], normal, 770)[:2]):
            draw.text((54, y + 13 + i * 36), line, font=normal, fill="#1c2545")
        draw.text((855, y + 31), STATES[row["status"]], font=_font(27, True), fill=colors[row["status"]])
        y += 110
    for incident in facts["incidents"]:
        for i, line in enumerate(_wrap(draw, incident["title"], small, 970)[:2]):
            draw.text((52, y + i * 30), line, font=small, fill="#8c4335")
        y += 75
    draw.text((50, y + 10), checked_at.replace("T", " ")[:19] + "  北京时间", font=small, fill="#60677b")
    draw.text((50, y + 45), "来源 " + SOURCES["deepseek"], font=small, fill="#60677b")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def query_status(service):
    if service not in SOURCES:
        raise ValueError("STATUS_SERVICE_INVALID")
    checked_at = stamp()
    result = {"service": service, "source": SOURCES[service], "checked_at": checked_at, "ok": False, "artifact_id": None}
    try:
        if service == "deepseek":
            facts = parse_deepseek(fetch_deepseek())
            checked_at = stamp()
            lines = ["DeepSeek 官方状态：" + STATES[facts["overall"]]]
            lines += [r["name"] + "：" + STATES[r["status"]] for r in facts["components"]]
            lines += ["当前事件：" + r["title"] for r in facts["incidents"]]
            png = render_deepseek(facts, checked_at)
        else:
            facts = fetch_liang_vote()
            checked_at = stamp()
            lines = ["滑动变祖器：" + facts["stage"] + " · " + facts["level"] + " 级",
                     f"社区投票：往上 {facts['up']} / 往下 {facts['down']}（默认18小时半衰期）"]
            png = render_liang(facts, checked_at)
        if len(png) > 1_500_000:
            raise ValueError("STATUS_IMAGE_TOO_LARGE")
        OUTPUT.mkdir(mode=0o700, parents=True, exist_ok=True)
        artifact_id = uuid.uuid4().hex
        file = OUTPUT / (artifact_id + ".png")
        file.write_bytes(png)
        file.chmod(0o600)
        result.update(ok=True, artifact_id=artifact_id, checked_at=checked_at,
                      text="\n".join(lines) + "\n查询时间：" + checked_at.replace("T", " ")[:19] + "（北京时间）\n来源：" + SOURCES[service])
    except Exception:
        # Raw browser/network exceptions can contain URLs and environment paths.
        name = "DeepSeek 官方状态" if service == "deepseek" else "滑动变祖器实时状态或图片"
        result["text"] = "这次未能获取" + name + "，稍后再试一下\n来源：" + SOURCES[service]
    return result


@tool(args_schema=NoArgs, return_direct=True)
def deepseek_service_status() -> dict:
    """只读查询DeepSeek官方当前服务状态及当前事件，生成状态图。无需API Key，不查询账户余额，无URL/账户/文件参数。"""
    return query_status("deepseek")


@tool(args_schema=NoArgs, return_direct=True)
def liang_status() -> dict:
    """只读查询liang.itsuyo.top滑动变祖器当前社区评分与形态，按实时评分匹配作者素材生成状态图；默认18小时半衰期，不投票、不改设置。"""
    return query_status("liang")
