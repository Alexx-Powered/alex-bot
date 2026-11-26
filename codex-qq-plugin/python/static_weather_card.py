"""Assemble the single-place static forecast in the LangChain worker."""
import csv
import io
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, time, timedelta
from pathlib import Path
from urllib.request import urlopen

from morning_pm25 import choose_morning_pm25, choose_partial_pm25
from outdoor_index import outdoor_index
from static_forecast import TZ, ROOT, HOUR, ZONENAME, OutsideWindow, cams, forecast, resolve_place
from weather_alerts import weather_alerts


def validate_gefs(data, place, start, now):
    run = datetime.fromisoformat(data["modelRunAt"].replace("Z","+00:00"))
    fetched = datetime.fromisoformat(data["fetchedAt"].replace("Z","+00:00"))
    if not (data["city"] == place["id"] and run <= min(now,start) and now-run <= 36*HOUR
            and run.timestamp() % (6*3600) == 0 and run <= fetched <= now+timedelta(minutes=5)):
        raise ValueError("invalid GEFS run")
    offset = (start.date()-date.fromisoformat(data["date"])).days*24
    rows = data["hourly"][offset:offset+48]
    if offset not in (0,24) or len(rows) != 48:
        raise ValueError("invalid GEFS window")
    for i, row in enumerate(rows):
        value = row["pm25"]
        if (datetime.fromisoformat(row["time"]) != start+i*HOUR or
                value is not None and (type(value) not in (int,float) or not 0 <= value <= 5000)):
            raise ValueError("invalid GEFS series")
    if not any(row["pm25"] is not None for row in rows):
        raise OutsideWindow()
    return dict(city=place, timezone=ZONENAME, hourly=rows, fetchedAt=fetched.isoformat(),
                source=dict(model="gefs_aerosols", name="NOAA GEFS-Aerosols")), run


def gefs(place, start, now):
    cache = Path.cwd()/".private"
    city = place["id"]
    candidates = []
    for name in ("morning-gefs-calendar.json", f"morning-gefs-{city}.json"):
        try:
            with (cache / name).open("rb") as handle:
                data = handle.read(16 * 1024 + 1)
            if len(data) > 16 * 1024:
                continue
            raw = json.loads(data)
            if name == "morning-gefs-calendar.json":
                bundle_date = raw["date"]
                raw = raw["forecasts"][city]
                if raw["date"] != bundle_date or len(raw["hourly"]) != 72:
                    continue
            elif raw["date"] != start.date().isoformat() or len(raw["hourly"]) != 48:
                continue
            candidates.append(validate_gefs(raw,place,start,now))
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            pass
    if candidates:
        return max(candidates, key=lambda c:c[1])[0]
    proc = subprocess.run([sys.executable, "-B", str(ROOT/"python/morning_pm25.py")],
                          input=json.dumps(dict(action="dated",data=dict(city=city,date_iso=start.date().isoformat(),
                                    now_seconds=int(now.timestamp())))).encode(),
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=25, check=True)
    result = json.loads(proc.stdout)
    if "error" in result:
        raise ValueError("GEFS unavailable")
    return validate_gefs(dict(result,fetchedAt=now.isoformat()), place,start,now)[0]


def select_air(cams_data, gefs_data):
    if cams_data is None or gefs_data is None:
        return cams_data or gefs_data
    series = {key:[r["pm25"] for r in obj["hourly"]] for key,obj in (("cams",cams_data),("gefs",gefs_data))}
    if all(None not in values for values in series.values()):
        return gefs_data if choose_morning_pm25.invoke(series)["model"] == "gefs_aerosols" else cams_data
    names = choose_partial_pm25.invoke(series)
    first,second = [gefs_data if name=="gefs_aerosols" else cams_data for name in names]
    if first is second or not any(r["pm25"] is not None for r in second["hourly"][24:]):
        return first
    if not any(r["pm25"] is not None for r in first["hourly"][:24]):
        return second
    labels = ["NOAA GEFS-Aerosols" if n=="gefs_aerosols" else "CAMS / ECMWF" for n in names]
    return dict(first, source=dict(model="daily_selection",name=" → ".join(labels)),
                hourly=first["hourly"][:24]+second["hourly"][24:])


def observations(place, start, now):
    if start.date() != now.date():
        return {}
    day = start.strftime("%Y%m%d")
    with urlopen(f"https://quotsoft.net/air/data/china_cities_{day}.csv",timeout=6) as response:
        raw = response.read(2*1024*1024+1)
    if len(raw)>2*1024*1024:
        return {}
    rows = csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))
    name = place["name"]
    if not rows.fieldnames or rows.fieldnames[:3] != ["date", "hour", "type"] or name not in rows.fieldnames[3:]:
        return {}
    samples = {}
    for row in rows:
        if (row["date"] == day and row["type"] == "PM2.5" and re.fullmatch(r"\d{1,2}",row["hour"]) and
                re.fullmatch(r"\d+(\.\d+)?",row.get(name) or "")):
            h, value = int(row["hour"]),float(row[name])
            if h <= now.hour and value <= 5000:
                samples[h] = value
    return samples if samples and now-(start+max(samples)*HOUR)<=3*HOUR else {}


def warning(place, start, now):
    if 0 <= (start.date()-now.date()).days <= 1:
        day = start.date().isoformat()
        result = weather_alerts.invoke(dict(action="outdoor", query=place["id"], date=day))
        if (result.get("ok") is True and result.get("date") == day and result.get("placeId") == place["id"]
                and isinstance(result.get("hazards"), list) and len(result["hazards"]) <= 96
                and all(isinstance(h, str) and re.fullmatch(r"[\u3400-\u9fffA-Za-z0-9（）()·、-]{1,40}", h)
                        for h in result["hazards"])):
            return result
    return {}


def read_source(task):
    try:
        return task.result(), None
    except OutsideWindow:
        return None, "outside"
    except Exception:
        return None, "unavailable"


def card_inputs(place, start, now, performance):
    day = start.date().isoformat()
    winter = place["id"] in ("beijing","tianjin") and start.month in (11,12,1,2,3)
    def timed(stage, fetch):
        with performance.span(stage):
            return fetch(place,start,now)
    with ThreadPoolExecutor(max_workers=5) as pool:
        weather_job = pool.submit(timed,"weather_fetch",forecast)
        air_job = pool.submit(timed,"air_fetch",cams)
        gefs_job = pool.submit(timed,"morning_air_gefs",gefs) if winter else None
        warning_job = pool.submit(timed,"warning_fetch",warning)
        observation_job = pool.submit(observations,place,start,now)
        wx, wx_error = read_source(weather_job)
        air, air_error = read_source(air_job)
        if gefs_job:
            other, other_error = read_source(gefs_job)
            air = select_air(air, other)
            if not air and other_error != "outside":
                air_error = "unavailable"
        info, _ = read_source(warning_job)
        measured, _ = read_source(observation_job)
    if wx is None and air is None and "outside" not in (wx_error,air_error):
        raise ValueError("FORECAST_UNAVAILABLE")
    info = info or {}
    hours = []
    for i in range(24):
        row = wx["hourly"][i] if wx else {}
        hours.append(dict(time=(start+i*HOUR).isoformat(), cloud=row.get("cloudCoverPct"),
                          pm25=air["hourly"][i]["pm25"] if air else None, wind=row.get("windSpeedMs"),
                          gust=row.get("windGustMs"), rain=row.get("rainMm"), code=row.get("weatherCode"),
                          observed=(measured or {}).get(i)))
    score = outdoor_index.invoke(dict(date=day,hours=hours,red_hazards=info.get("hazards",[])))
    score.update(city=place["id"])
    if not info.get("ok") or info.get("partial"):
        score["warningPartial"] = True
    return dict(date=day,cities=[place["id"]],places=[place],weather=[wx],air=air,
                now=int(now.timestamp()*1000),outdoorIndex=score,weatherUnavailable=wx_error=="unavailable",
                airUnavailable=air is None and air_error=="unavailable",
                airSources="CAMS / ECMWF、NOAA GEFS-Aerosols" if winter and air is None else "CAMS / ECMWF")


def static_weather_card(city, day, request_id, now, performance):
    """Arguments have passed the LangChain schema; the gateway supplies the request ID."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}",request_id):
        raise ValueError("invalid request id")
    now = now.astimezone(TZ)
    target = (now.date() if day=="today" else now.date()+timedelta(days=1) if day=="tomorrow" else date.fromisoformat(day))
    if target < now.date():
        raise ValueError("unsupported_time")
    with performance.span("resolve_location"):
        place = resolve_place(city)
    inputs = card_inputs(place, datetime.combine(target,time.min,TZ), now, performance)
    with performance.span("weather_render"):
        from worker_artifacts import publish, render_canvas
        return {"text":"", **publish(request_id,"png",render_canvas("weather",inputs))}
