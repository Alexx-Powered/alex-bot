"""Dynamic weather and rolling air charts executed by the conversation worker."""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time as local_time, timedelta
import math
from pathlib import Path
import re
import time
import unicodedata

from static_forecast import HOUR, TZ, ZONENAME, catalogue, get_json, key, resolve_place
from weather_regions import REGION_ALIASES, REGIONS
from weather_video_codec import VideoFailure
from weather_video_worker import generate
from worker_artifacts import publish, render_canvas

LAYERS = {"satellite_video": "cloud", "cloud_video": "cloud_cover", "pm25_video": "pm25",
          "precipitation_video": "precipitation", "temperature_video": "temperature"}
ERRORS = {
    "VIDEO_NO_COVERAGE": "该地点不在当前葵花卫星云图覆盖内（主要为东亚及西太平洋）。",
    "VIDEO_SOURCE_STALE": "卫星云图更新时间过旧，暂不发送。",
    "VIDEO_DATA_MISSING": "时间轴或区域数据有缺测，暂时无法生成完整视频。",
    "VIDEO_TIMEOUT": "动态天气视频生成超时，请稍后再试。",
    "VIDEO_ENCODING_FAILED": "视频生成暂不可用。",
    "VIDEO_BOTH_OUTSIDE_WINDOW": "ECMWF IFS、NOAA GFS 数据源无当日预报",
    "VIDEO_GFS_OUTSIDE_WINDOW": "ECMWF IFS 暂不可用，NOAA GFS 数据源无当日预报",
}
LOCATION_ERRORS = {
    "LOCATION_INPUT_INVALID": "请提供有效的地名。",
    "LOCATION_NOT_FOUND": "未找到该地点，请补充省市县，或使用景点、山峰、村庄、步道的完整名称。",
    "LOCATION_SOURCE_UNAVAILABLE": "地点查询暂不可用，请稍后查询。",
}
# The main agent serializes requests. Keep at most four validated MP4s (16 MiB).
_cache = OrderedDict()


def report_start(day, now):
    if day is None:
        return None
    if day in ("today", "tomorrow"):
        target = now.date()+timedelta(days=int(day=="tomorrow"))
    else:
        target = date.fromisoformat(day)
        if target.isoformat() != day or target < now.date():
            raise ValueError("unsupported_time")
    return int(datetime.combine(target, local_time.min, TZ).timestamp())


def timeline_ok(data, layer, hours, start):
    satellite = layer == "cloud"
    if "forecast_detail" in data and (satellite or data["forecast_detail"] not in ("native", "sampled")):
        return False
    if any(type(data.get(k)) is not int for k in ("start", "end", "frames", "generated_at")):
        return False
    if "format_version" not in data:
        return (start is None and hours == 24 and data.get("width") == data.get("height") == 720
                and data["frames"] == (13 if satellite else 24)
                and data["end"]-data["start"] == (21600 if satellite else 82800))
    times = data.get("source_times")
    if not (data["format_version"] == 2 and data.get("width") == data.get("height") == 1080
            and data.get("fps") == 12 and isinstance(times,list)):
        return False
    if not ((2 <= len(times) <= 37) if satellite else (1 <= len(times) <= hours)):
        return False
    interval = 600 if satellite else 3600
    if (data["start"] != times[0] or data["end"] != times[-1]
            or any(type(t) is not int or t % interval for t in times)):
        return False
    if satellite:
        if not (0 < times[-1]-times[0] <= 21600 and -60 <= data["generated_at"]-times[-1] <= 5400):
            return False
    elif start is None:
        if not 0 <= times[0]-data["generated_at"] <= 3600:
            return False
    elif times[0] != start:
        return False
    frames = 1
    for first, second in zip(times, times[1:]):
        gap = second-first
        if satellite and gap > 0:
            frames += 4 if gap == 600 else 1
        elif not satellite and gap == 3600:
            frames += 3 if hours == 48 else 6
        else:
            return False
    return data["frames"] == frames


def matches_region(data, region):
    if region is None:
        return "region_id" not in data
    bounds = data.get("view_bounds")
    if (data.get("region_id") != region["id"] or not isinstance(bounds, list) or len(bounds) != 4
            or not all(type(v) in (int,float) and math.isfinite(v) for v in bounds)):
        return False
    west,south,east,north = region["bounds"]
    return (-180 <= bounds[0] <= west and -85.06 <= bounds[1] <= south
            and east <= bounds[2] <= 180 and north <= bounds[3] <= 85.06)


def read_video(data):
    folder = Path.cwd()/".private"/"weather-video"
    file = folder/(data["artifact_id"]+".mp4")
    if file.is_symlink() or not file.is_file() or file.resolve().parent != folder.resolve():
        raise ValueError("VIDEO_RESULT_INVALID")
    try:
        size = file.stat().st_size
        if size != data.get("bytes") or not 32 <= size <= 4*1024*1024:
            raise ValueError("VIDEO_RESULT_INVALID")
        with file.open("rb") as source:
            content = source.read(size+1)
        if (len(content)!=size or content[4:8]!=b"ftyp"
                or not 16 <= int.from_bytes(content[:4], "big") <= size):
            raise ValueError("VIDEO_RESULT_INVALID")
        return content
    finally:
        file.unlink(missing_ok=True)


def video(name, args, packet, performance, now):
    layer = LAYERS[name]
    hours = args.get("hours", 24)
    start = report_start(args.get("day"), now)
    if type(hours) is not int or hours not in (24,48) or layer=="cloud" and (start is not None or hours!=24):
        raise ValueError("unsupported_time")
    with performance.span("resolve_location"):
        compact = "".join(unicodedata.normalize("NFKC",args["city"]).split())
        region = REGIONS.get(REGION_ALIASES.get(compact))
        if region:
            ident = "region:"+region["id"]
            target = dict(name=region["name"],region_id=region["id"])
        else:
            place = resolve_place(args["city"])
            ident = place["id"]
            target = {k:place[k] for k in ("name","latitude","longitude")}
    cache_key = (layer, ident, hours, start)
    stamp = time.time()
    for k in [k for k, (expiry, _) in _cache.items() if expiry <= stamp]:
        del _cache[k]
    if cache_key in _cache:
        with performance.span("video_cache_hit"):
            _cache.move_to_end(cache_key)
            return {"text":"", **publish(packet["id"],"mp4",_cache[cache_key][1])}
    if start is not None:
        target["start"] = start
    if hours == 48:
        target["hours"] = hours
    data = generate(dict(target,layer=layer), getattr(performance, "video_event", None))
    if not data.get("ok"):
        raise VideoFailure(data.get("code","VIDEO_SOURCE_UNAVAILABLE"))
    if (not re.fullmatch(r"[0-9a-f]{32}", str(data.get("artifact_id","")))
            or data.get("layer") != layer or not timeline_ok(data,layer,hours,start)
            or abs(time.time()-data["generated_at"]) > 300 or not matches_region(data,region)):
        raise ValueError("VIDEO_RESULT_INVALID")
    with performance.span("video_read_mp4"):
        content = read_video(data)
    freshness = data["end"]+5400 if layer=="cloud" else data["start"]+.001
    expires = min(data["generated_at"]+300, freshness)
    if data.get("forecast_detail") != "sampled" and expires > time.time():
        if len(_cache)>=4:
            _cache.popitem(last=False)
        _cache[cache_key] = expires,content
    return {"text":"", **publish(packet["id"],"mp4",content)}


def rolling_air(place, now):
    start = now.replace(minute=0,second=0,microsecond=0)
    europe = -24.95 <= place["longitude"] <= 44.95 and 30.05 <= place["latitude"] <= 71.95
    domain = "cams_europe" if europe else "cams_global"
    params = dict(latitude=place["latitude"],longitude=place["longitude"],domains=domain,
                  forecast_hours=48,hourly="pm2_5",timezone=ZONENAME)
    with ThreadPoolExecutor(max_workers=2) as pool:
        meta_job = pool.submit(get_json,f"https://air-quality-api.open-meteo.com/data/{domain}/static/meta.json",
                               now=now,timeout=15)
        data_job = pool.submit(get_json,"https://air-quality-api.open-meteo.com/v1/air-quality",params,
                               now=now,timeout=15)
        meta,data = meta_job.result(),data_job.result()
    run,ready,end = [datetime.fromtimestamp(meta[k],TZ) for k in
                     ("last_run_initialisation_time","last_run_availability_time","data_end_time")]
    if not (run <= ready <= now+timedelta(minutes=5) and now-run <= (48 if europe else 36)*HOUR
            and now-ready <= 24*HOUR and end >= start+47*HOUR):
        raise ValueError("FORECAST_MODEL_STALE")
    times, values = data["hourly"]["time"], data["hourly"]["pm2_5"]
    if (data["timezone"] != ZONENAME or data["utc_offset_seconds"] != 28800
            or data["hourly_units"]["pm2_5"].replace("µ","μ") != "μg/m³"
            or not isinstance(times,list) or not 0 < len(times) <= 240 or times != sorted(set(times))
            or not all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:00", t) for t in times)
            or not isinstance(values,list) or len(times)!=len(values)):
        raise ValueError("FORECAST_DATA_INVALID")
    samples = dict(zip(times,values))
    rows = []
    for hour in range(48):
        stamp = start+hour*HOUR
        v = samples[stamp.strftime("%Y-%m-%dT%H:00")]
        rows.append({"time":stamp.isoformat(),"pm25":v if type(v) in (int,float) and 0<=v<=5000 else None})
    if sum(row["pm25"] is not None for row in rows)<24:
        raise ValueError("FORECAST_DATA_MISSING")
    return {"city":place,"timezone":ZONENAME,"hourly":rows}


def air_chart(args, packet, performance, now):
    query = unicodedata.normalize("NFKC",args["city"]).strip()
    with performance.span("resolve_location"):
        # Exact catalogue selections (including qualified disambiguation replies) have priority.
        selected = re.search(r"\(([-a-zA-Z0-9]+)\)$", query)
        aliases = catalogue()
        compact = key(selected[1] if selected else query)
        choices = aliases.get(compact) or aliases.get(re.sub(r"[市区县旗]$","",compact)) or []
        choices = list({p["id"]:p for p in choices}.values())
        if len(choices)>1:
            labels = []
            for p in sorted(choices,key=lambda p:(p["name"],p["id"]))[:8]:
                label = f"{p['name']}（{p['id']}）"
                labels.append(label if len(label)<=60 else p["id"])
            return {"text":"地名有重名，请加省市：\n"+"\n".join(labels)}
        place = choices[0] if choices else resolve_place(query)
    with performance.span("air_fetch"):
        result = rolling_air(place,now)
    with performance.span("weather_render"):
        png = render_canvas("air",result)
    return {"text":"", **publish(packet["id"],"png",png)}


def execute(name,args,packet,performance,grant):
    now = datetime.fromisoformat(packet["now"].replace("Z","+00:00")).astimezone(TZ) if packet.get("now") else datetime.now(TZ)
    try:
        if name=="air_quality_image":
            return air_chart(args,packet,performance,now)
        with performance.span("weather_video"):
            return video(name,args,packet,performance,now)
    except VideoFailure as error:
        if error.code=="VIDEO_OUTSIDE_WINDOW":
            return {"text":("CAMS" if name=="pm25_video" else "ECMWF IFS")+"数据源无当日预报"}
        return {"text":ERRORS.get(error.code,"动态天气数据源暂不可用，请稍后重试。")}
    except (KeyError, OverflowError, OSError, TypeError, ValueError) as error:
        if str(error) == "unsupported_time":
            return {"text":"预报视频支持未来日期的24或48小时；历史云图展示最近6小时。"}
        message = LOCATION_ERRORS.get(str(error))
        if not message:
            message = "预报数据暂不可用，请稍后查询。" if name=="air_quality_image" else "动态天气视频暂不可用，请稍后查询。"
        return {"text":message}
