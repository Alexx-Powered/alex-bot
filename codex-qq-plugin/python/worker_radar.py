"""Radar business adapter for the chat worker. All network targets originate in fixed official sources."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
import re
import struct
from threading import RLock
import time
from urllib.parse import urljoin, urlsplit

import httpx

NMC = "https://www.nmc.cn"
REGIONS_URL = NMC + "/publish/radar/chinaall.html"
RAINVIEWER = "https://www.rainviewer.com/"
REGIONS = dict(zip("全国 华北 东北 华东 华中 华南 西南 西北".split(),
                   "ACHN ANCN ANEC AECN ACCN ASCN ASWC ANWC".split()))
BEIJING = timezone(timedelta(hours=8))
NAME = re.compile(r"[\u3400-\u9fffA-Za-z0-9 ()（）·_-]+")
CATALOG_PATH = re.compile(r"/publish/(?:radar/|tianqishikuang/leidatu/(?:danzhanleida|leidapintu)/)[a-z0-9/-]+\.html?", re.I)
PRODUCT = re.compile(r"/product/\d{4}/\d{2}/\d{2}/RDCP/(?:medium/)?SEVP_AOC_RDCP_SLDAS3_ECREF_([A-Z0-9]+)_L88_PI_(\d{14})\d{3}\.(?:png|jpe?g)", re.I)
PNG = b"\x89PNG\r\n\x1a\n"
GLOBAL_ERRORS = {
    "GLOBAL_RADAR_LOCATION_AMBIGUOUS": "地名有重名，请补充国家或省市",
    "GLOBAL_RADAR_LOCATION_NOT_FOUND": "全球雷达未找到该地点，请使用城市或国家名称",
    "GLOBAL_RADAR_LOCATION_INVALID": "请提供有效的城市、国家或地区名",
    "GLOBAL_RADAR_STALE": "全球雷达数据已过期，暂不发送旧图",
    "GLOBAL_RADAR_TIMEOUT": "全球雷达数据请求超时（单次10秒时限），请稍后重试",
}
GLOBAL_FALLBACK = {"NOT_FOUND", "RADAR_STALE", "RADAR_SOURCE_CHANGED", "RADAR_TIMEOUT", "RADAR_UNAVAILABLE"}
DOMESTIC_ERRORS = {
    "RADAR_SOURCE_CHANGED": "中央气象台雷达页面暂时没有可核验的原图，请稍后重试。",
    "RADAR_SOURCE_REJECTED": "官方雷达来源地址未通过校验，请稍后重试。",
    "RADAR_TIME_INVALID": "官方雷达图时间与本机时间不一致，请稍后重试。",
    "RADAR_TOO_LARGE": "官方雷达文件超出下载大小限制，请稍后重试。",
    "RADAR_TIMEOUT": "下载官方雷达图超时，请稍后重试。",
    "RADAR_UNAVAILABLE": "中央气象台雷达数据暂时不可用，请稍后重试。",
}


class RadarError(Exception):
    def __init__(self, code, message=None):
        super().__init__(message or DOMESTIC_ERRORS.get(code, "雷达图暂不可用，请稍后查询。"))
        self.code = code


@dataclass(frozen=True)
class Source:
    name: str
    url: str
    province: str = ""
    station: str = ""

    @property
    def label(self):
        return self.province + "·" + self.name if self.province else self.name


FIXED = {
    "北京": Source("大兴", NMC + "/publish/radar/bei-jing/da-xing.htm", "北京", "AZ9010"),
    "天津": Source("塘沽", NMC + "/publish/radar/tian-jin/tian-jin.htm", "天津", "AZ9220"),
}


def normalized(value):
    value = re.sub(r"[\s()（）·_-]", "", value)
    return re.sub(r"(?:壮族|回族|维吾尔)?自治区$|[省市]$", "", value).lower()


def official_url(url, kind):
    host = "www.nmc.cn" if kind == "page" else "image.nmc.cn"
    if not isinstance(url, str):
        raise RadarError("RADAR_SOURCE_REJECTED")
    try:
        parts = urlsplit(url)
        if parts.scheme == "https" and parts.netloc.lower() == host and not parts.fragment and not re.search(r"[\x00-\x20\\]", url):
            return parts
    except ValueError:
        pass
    raise RadarError("RADAR_SOURCE_REJECTED")


def download(url, kind, *, transport=None):
    original = official_url(url, kind)
    mimes = ("text/html",) if kind == "page" else ("image/jpeg", "image/png")
    limit = 512*1024 if kind == "page" else 5*1024*1024
    deadline = time.monotonic() + 10
    try:
        with httpx.Client(transport=transport, follow_redirects=False, trust_env=False) as client:
            for _ in range(4):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RadarError("RADAR_TIMEOUT")
                with client.stream("GET", url, headers={"Accept": ",".join(mimes)}, timeout=remaining) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        location = response.headers.get("location")
                        if not location:
                            raise RadarError("RADAR_SOURCE_REJECTED")
                        url = urljoin(url, location)
                        target = official_url(url, kind)
                        if kind == "image" and target.path != original.path:
                            raise RadarError("RADAR_SOURCE_REJECTED")
                        continue
                    if not response.is_success:
                        raise RadarError("RADAR_UNAVAILABLE")
                    mime = response.headers.get("content-type", "").split(";")[0].strip().lower()
                    if mime not in mimes:
                        raise RadarError("RADAR_SOURCE_CHANGED")
                    size = response.headers.get("content-length", "")
                    if size.isdecimal() and int(size) > limit:
                        raise RadarError("RADAR_TOO_LARGE")
                    body = bytearray()
                    for chunk in response.iter_bytes(chunk_size=32768):
                        if time.monotonic() > deadline:
                            raise RadarError("RADAR_TIMEOUT")
                        if len(body) + len(chunk) > limit:
                            raise RadarError("RADAR_TOO_LARGE")
                        body.extend(chunk)
                    if not body:
                        raise RadarError("RADAR_SOURCE_CHANGED")
                    return bytes(body), mime
        raise RadarError("RADAR_SOURCE_REJECTED")
    except httpx.TimeoutException:
        raise RadarError("RADAR_TIMEOUT") from None
    except httpx.HTTPError:
        raise RadarError("RADAR_UNAVAILABLE") from None


class Page(HTMLParser):
    """Read the NMC station menus, product title and frame attributes."""
    def __init__(self, raw):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.in_title = False
        self.frames = []
        self.menus = {}
        self.level = None
        self.href = None
        self.label = ""
        self.feed(raw.decode("utf-8", errors="replace"))
        self.close()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self.in_title = True
        elif tag == "div":
            classes = (attrs.get("class") or "").split()
            if "time" in classes and "data-img" in attrs:
                self.frames.append((attrs["data-img"], attrs.get("data-time")))
            if "p-nav" in classes:
                self.level = next((n for n in (2,3) if f"nav{n}" in classes and n not in self.menus), None)
                if self.level:
                    self.links = []
        elif tag == "a" and self.level:
            self.href = attrs.get("href", "")
            self.label = ""

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if self.href is not None:
            self.label += data

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        elif tag == "a" and self.level and self.href is not None:
            self.links.append((self.label.strip(), self.href))
            self.href = None
        elif tag == "ul" and self.level:
            self.menus[self.level] = self.links
            self.level = self.href = None

    def menu(self, level, limit):
        entries = {}
        for label, href in self.menus.get(level, []):
            if not href or not NAME.fullmatch(label) or len(label) > 40:
                raise RadarError("RADAR_SOURCE_CHANGED")
            url = urljoin(NMC, href)
            parts = official_url(url, "page")
            if not CATALOG_PATH.fullmatch(parts.path) or parts.query:
                raise RadarError("RADAR_SOURCE_REJECTED")
            entries[label,url] = None
        if not 0 < len(entries) <= limit:
            raise RadarError("RADAR_SOURCE_CHANGED")
        return list(entries)

    def latest(self, source):
        if not source.station:
            labels = self.title.split("_")[-2:]
            if labels != [source.province or "雷达拼图",source.name]:
                raise RadarError("RADAR_SOURCE_CHANGED")
        expected = source.station or (None if source.province else REGIONS.get(source.name))
        frames = []
        for url, label in self.frames:
            match = PRODUCT.fullmatch(official_url(url, "image").path)
            if not match:
                raise RadarError("RADAR_SOURCE_CHANGED")
            code, stamp = match.groups()
            if (expected and code != expected) or not re.fullmatch(r"AZ\d+" if source.province else r"A[A-Z]{3}", code):
                raise RadarError("RADAR_SOURCE_CHANGED")
            expected = code
            try:
                dt = datetime.strptime(stamp, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)
            except ValueError:
                raise RadarError("RADAR_SOURCE_CHANGED") from None
            if label not in (dt.strftime("%m/%d %H:%M"),dt.astimezone(BEIJING).strftime("%m/%d %H:%M")):
                raise RadarError("RADAR_SOURCE_CHANGED")
            frames.append((dt.timestamp(),url))
        if not frames:
            raise RadarError("RADAR_SOURCE_CHANGED")
        return max(frames, key=lambda f:f[0])


def fresh(stamp, now):
    if stamp > now + 300:
        raise RadarError("RADAR_TIME_INVALID")
    if now - stamp > 3600:
        raise RadarError("RADAR_STALE", "该雷达图已过期，暂不发送。")


def image_type(data, mime):
    if mime == "image/png" and len(data) >= 33 and data.startswith(PNG) and data[12:16] == b"IHDR":
        if data.endswith(b"\0\0\0\0IEND\xaeB\x60\x82") and all(0 < n <= 8192 for n in struct.unpack(">II", data[16:24])):
            return "png"
    if mime == "image/jpeg" and len(data) >= 4 and data.startswith(b"\xff\xd8") and data.endswith(b"\xff\xd9"):
        return "jpg"
    raise RadarError("RADAR_SOURCE_CHANGED")


class DomesticRadar:
    def __init__(self, fetch=download, clock=time.time):
        self.fetch, self.clock = fetch, clock
        self.cache = OrderedDict()
        self.entries = []
        self.catalog_at = self.retry_at = 0
        self.lock = RLock()

    def page(self, url):
        raw, _ = self.fetch(url, "page")
        return Page(raw)

    def catalog(self):
        with self.lock:
            now = self.clock()
            if self.entries and 0 <= now - self.catalog_at < 86400:
                return self.entries
            if now < self.retry_at:
                raise RadarError("RADAR_CATALOG_UNAVAILABLE", "官方雷达目录暂不可用，请稍后查询。")
            try:
                with ThreadPoolExecutor(max_workers=3) as pool:
                    stations = pool.submit(self.page, FIXED["北京"].url)
                    regions = self.page(REGIONS_URL).menu(2,30)
                    station_page = stations.result()
                    provinces = station_page.menu(2,50)

                    def province_sources(province):
                        name, url = province
                        page = station_page if url == FIXED["北京"].url else self.page(url)
                        return [Source(label, link, name) for label, link in page.menu(3,200)]

                    entries = [Source(name,url) for name,url in regions]
                    for group in pool.map(province_sources, provinces):
                        entries.extend(group)
                if len({s.url for s in entries}) != len(entries):
                    raise RadarError("RADAR_SOURCE_CHANGED")
            except (RadarError, ValueError):
                self.retry_at = self.clock() + 300
                raise RadarError("RADAR_CATALOG_UNAVAILABLE", "官方雷达目录暂不可用，请稍后查询。") from None
            self.entries, self.catalog_at = entries, self.clock()
            self.retry_at = 0
            return self.entries

    def resolve(self, target):
        key = normalized(target)
        if key in FIXED:
            return FIXED[key]
        entries = self.catalog()
        matches = [s for s in entries if key in (normalized(s.name), normalized(s.label), normalized(s.province))]
        if not matches:
            matches = [s for s in entries if key in normalized(s.label)]
        if not matches:
            raise RadarError("NOT_FOUND", "未找到站点或区域，请发送“雷达目录”查询。")
        if len(matches) > 1:
            names = "\n".join(s.label for s in matches[:25])
            raise RadarError("AMBIGUOUS_TARGET", f"匹配到多个雷达站点，请使用完整名称：\n{names}\n例如：发 雷达 完整站名")
        return matches[0]

    def image(self, target):
        source = self.resolve(target)
        with self.lock:
            now = self.clock()
            for url, (fetched, _, _, _) in list(self.cache.items()):
                if not 0 <= now - fetched < 300:
                    del self.cache[url]
            if source.url in self.cache:
                _, stamp, ext, data = self.cache[source.url]
                fresh(stamp, now)
                return ext, data
            stamp, url = self.page(source.url).latest(source)
            fresh(stamp, self.clock())
            data, mime = self.fetch(url, "image")
            ext = image_type(data, mime)
            fresh(stamp, self.clock())
            self.cache[source.url] = self.clock(), stamp, ext, data
            while len(self.cache) > 16 or sum(len(row[3]) for row in self.cache.values()) > 24 * 1024 * 1024:
                self.cache.popitem(last=False)
            return ext, data

    def listing(self, query):
        query = query.strip()
        page = 1
        match = re.fullmatch(r"(.*?)\s+([0-9]+)", query)
        if match:
            query, page = match[1].strip(), int(match[2])
        if page < 1:
            raise RadarError("NOT_FOUND", "目录页码需为正整数，例如“雷达目录 新疆 2”。")
        entries = self.catalog()
        if not query:
            regions = [s.name for s in entries if not s.province]
            provinces = {}
            for s in entries:
                if s.province:
                    provinces[s.province] = provinces.get(s.province, 0) + 1
            counts = "、".join(f"{name}({n})" for name, n in provinces.items())
            text = (f"中央气象台雷达目录\n区域拼图（{len(regions)}）：{'、'.join(regions)}\n"
                    f"单站（{sum(provinces.values())}站/{len(provinces)}省级地区）：{counts}\n"
                    "查站：雷达目录 广东\n翻页：雷达目录 新疆 2\n取图：发 雷达 华北 / 发 雷达 北京海坨山\n"
                    "北京、天津默认分别为大兴、塘沽站。目录每日更新；实际出图以官方供应为准。")
        else:
            key = normalized(query)
            matches = [s for s in entries if key in normalized(s.label) or key == normalized(s.province)]
            if not matches:
                raise RadarError("NOT_FOUND", "目录中未找到匹配名称；发送“雷达目录”查看区域和省份。")
            pages = (len(matches) + 11) // 12
            if page > pages:
                raise RadarError("NOT_FOUND", f"该目录共{pages}页，请使用有效页码。")
            items = matches[(page - 1) * 12 : page * 12]
            names = "\n".join(s.label if s.province else s.name+"（区域拼图）" for s in items)
            text = f"中央气象台雷达目录：{query}（{len(matches)}项，第{page}/{pages}页）\n{names}\n取图：发 雷达 {items[0].label}"
            if page < pages:
                text += f"\n下一页：雷达目录 {query} {page+1}"
            text += "\n目录收录不保证该站当前有新图；无图或图已过期时会明确提示。"
        if len(text) > 1300:
            raise RadarError("RADAR_SOURCE_CHANGED")
        return text


domestic = DomesticRadar()


def global_image(target):
    from global_radar import build_global_radar_tool
    private = Path.cwd()/".private"
    data = build_global_radar_tool(private).invoke({"target":target})
    if data.get("ok") is not True:
        message = GLOBAL_ERRORS.get(data.get("code"), "全球雷达数据暂不可用，请稍后重试")
        raise RadarError("GLOBAL_RADAR_FAILED", message+"\n来源：RainViewer "+RAINVIEWER)
    identifier = data.get("artifact_id","")
    if not re.fullmatch(r"[0-9a-f]{32}", identifier):
        raise RadarError("GLOBAL_RADAR_IMAGE_INVALID")
    file = private/"global-radar"/(identifier+".png")
    try:
        stamp = datetime.fromisoformat(data["issued_at"])
        if stamp.tzinfo is None or not -300 <= time.time()-stamp.timestamp() <= 3600:
            raise RadarError("GLOBAL_RADAR_STALE",GLOBAL_ERRORS["GLOBAL_RADAR_STALE"]+"\n来源：RainViewer "+RAINVIEWER)
        if data["source"] != RAINVIEWER or not isinstance(data["name"],str) or not 0 < len(data["name"]) <= 80 or type(data["covered"]) is not bool:
            raise RadarError("GLOBAL_RADAR_IMAGE_INVALID")
        with file.open("rb") as handle:
            raw = handle.read(4_500_001)
        if len(raw)>4_500_000 or image_type(raw,"image/png")!="png" or struct.unpack(">II",raw[16:24])!=(1080,1370):
            raise RadarError("GLOBAL_RADAR_IMAGE_INVALID")
        caption = data["name"]+" · 全球雷达拼图"
        if not data["covered"]:
            caption += "\n目标位置暂无有效雷达覆盖，图中灰纹为缺测"
        return raw, caption+"\n来源：RainViewer "+RAINVIEWER
    finally:
        file.unlink(missing_ok=True)


def execute(name, args, packet, performance, grant):
    from worker_artifacts import publish
    if name not in ("radar_image","radar_catalog"):
        raise ValueError("UNKNOWN_RADAR_TOOL")
    try:
        with performance.span("radar_query"):
            if name == "radar_catalog":
                query = args.get("query", "")
                if query and (not NAME.fullmatch(query) or len(query)>40):
                    raise RadarError("NOT_FOUND", "请输入官方雷达区域或站名。")
                return {"text":domestic.listing(query)}
            target = args["target"].strip()
            source = args.get("source","auto")
            if source not in ("auto","global") or not target or len(target)>40:
                raise RadarError("NOT_FOUND", "请输入官方雷达区域或站名。")
            if source == "auto" and target.lower() not in ("全球","世界","global","world") and NAME.fullmatch(target):
                try:
                    ext, raw = domestic.image(target)
                    return {"text":"", **publish(packet["id"], ext, raw)}
                except RadarError as exc:
                    if exc.code not in GLOBAL_FALLBACK:
                        raise
            raw, caption = global_image(target)
            return {"text":caption, "richMedia":True, **publish(packet["id"], "png", raw)}
    except RadarError as exc:
        return {"text":str(exc)}
