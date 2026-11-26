"""Point forecasts for a two-calendar-day weather card (Beijing time)."""
import json
import math
import re
import time
import unicodedata
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from functools import lru_cache
from pathlib import Path
from threading import Lock
from urllib.parse import urlencode
from urllib.request import Request, build_opener

from outdoor_places import NoRedirect, search_outdoor_places
from weather_summary import weather_summary
from wind_brief import wind_brief

TZ = timezone(timedelta(hours=8))
HOUR = timedelta(hours=1)
ROOT = Path(__file__).resolve().parents[1]
ZONENAME = "Asia/Shanghai"
_place_cache = OrderedDict()
_place_lock = Lock()
FIXED = {"beijing": ("北京", 39.9042, 116.4074), "tianjin": ("天津", 39.0842, 117.2009),
         "guangzhou": ("广州", 23.1291, 113.2644)}
FIELDS = {
    # provider name: output name, unit, range, sample offset in hours.
    "temperature_2m": ("temperatureC", "°C", -90, 65, 0),
    "relative_humidity_2m": ("humidityPct", "%", 0, 100, 0),
    "apparent_temperature": ("apparentTemperatureC", "°C", -120, 100, 0),
    "cloud_cover": ("cloudCoverPct", "%", 0, 100, 0),
    "wind_speed_10m": ("windSpeedMs", "m/s", 0, 150, 0),
    "wind_direction_10m": ("windDirectionDeg", "°", 0, 360, 0),
    "wind_gusts_10m": ("windGustMs", "m/s", 0, 150, 3),
    "precipitation": ("precipitationMm", "mm", 0, 1000, 1),
    "precipitation_probability": ("precipitationProbabilityPct", "%", 0, 100, 1),
    "rain": ("rainMm", "mm", 0, 1000, 1), "snowfall": ("snowfallCm", "cm", 0, 1000, 1),
    "shortwave_radiation": ("solarRadiationWm2", "W/m²", 0, 2000, 1),
    "weather_code": ("weatherCode", "wmo code", 0, 99, 0),
}
SOURCES = (
    ("https://previous-runs-api.open-meteo.com/v1/forecast",
     "https://s3.us-west-2.amazonaws.com/openmeteo/data/ecmwf_ifs/static/meta.json"),
    ("https://api.open-meteo.com/v1/ecmwf",
     "https://openmeteo.s3.amazonaws.com/data/ecmwf_ifs/static/meta.json"),
)


class OutsideWindow(ValueError):
    pass


def get_json(url, params=None, *, now=None, timeout=8):
    address = url + ("?" + urlencode(params) if params else "")
    with build_opener(NoRedirect()).open(Request(address, headers={"Accept": "application/json"}), timeout=timeout) as response:
        if response.headers.get_content_type() != "application/json":
            raise ValueError("invalid provider content type")
        if now:
            age = now - parsedate_to_datetime(response.headers["Date"])
            if not -timedelta(minutes=5) <= age <= timedelta(minutes=30):
                raise ValueError("stale provider response")
        data = response.read(524289)
    if len(data) > 524288:
        raise ValueError("provider response too large")
    value = json.loads(data)
    if not isinstance(value, dict) or value.get("error"):
        raise ValueError("invalid provider response")
    return value


def key(name):
    return re.sub(r"[\s·,，]", "", unicodedata.normalize("NFKC", name)).casefold().replace("’", "'")


@lru_cache(maxsize=1)
def catalogue():
    aliases = {}
    for filename in ("weather-locations.json", "outdoor-locations.json"):
        for row in json.loads((ROOT / "data" / filename).read_bytes())["places"]:
            place = {k: row[k] for k in ("id", "name", "latitude", "longitude")}
            for alias in [row["id"], row["name"], *row.get("aliases", [])]:
                aliases.setdefault(key(alias), []).append(place)
    for ident, (name, lat, lon) in FIXED.items():
        for alias in (ident, name, name + "市"):
            aliases[key(alias)] = [dict(id=ident, name=name, latitude=lat, longitude=lon)]
    return aliases


def best(places, query):
    def score(place):
        name = key(place["name"].split("·")[-1])
        return 3 if name == key(query) else 2 if key(place["name"]).endswith(key(query)) else int(key(query) in name)
    return max(places, key=score)


def resolve_place(query):
    import amap_places
    query = unicodedata.normalize("NFKC", query).strip()
    if not re.fullmatch(r"[\w ·（）(),，.'’\-]{1,60}", query):
        raise ValueError("LOCATION_INPUT_INVALID")
    selected = re.search(r"\(([A-Za-z0-9][A-Za-z0-9:_-]{0,79})\)$", query)
    ident = selected[1] if selected else query
    if selected or ident.isascii():
        matches = catalogue().get(key(ident), [])
        if exact := next((place for place in matches if place["id"] == ident), None):
            return exact
    if re.fullmatch(r"(?:landmark|qweather|amap|geonames|osm)-[A-Za-z0-9-]+", ident):
        with _place_lock:
            for expires, places in _place_cache.values():
                if expires > time.monotonic():
                    if exact := next((place for place in places if place["id"] == ident), None):
                        return exact
        raise ValueError("LOCATION_NOT_FOUND")
    rows = catalogue().get(key(query)) or catalogue().get(re.sub(r"[市区县旗]$", "", key(query)))
    if rows:
        if re.search(r"[县区旗乡镇]$", query):
            try:
                amap = amap_places.search(query)
                if amap:
                    return best(amap, query)
            except (ValueError, OSError):
                pass
        return best(rows, query)
    poi = bool(re.search(r"村|峰|山|岭|峡|沟|湖|岛|景区|公园|古道|步道|寺|车站|机场|大学|博物馆|trail|peak|mount", query, re.I))
    def outdoor():
        result = search_outdoor_places.invoke({"query": query, "expanded": True})
        if result.get("error"):
            raise ValueError(result["error"])
        return result["places"]

    def gazetteer():
        data = get_json("https://geocoding-api.open-meteo.com/v1/search", {"name": query, "count": 100, "language": "zh", "format": "json"})
        matches = []
        results = data.get("results", [])
        if not isinstance(results, list) or len(results) > 100:
            raise ValueError("LOCATION_SOURCE_UNAVAILABLE")
        for item in results:
            feature = item.get("feature_code")
            if poi:
                if not key(query).endswith(key(item["name"])):
                    continue
                if query.endswith(("峰", "岭", "山")) and feature not in {"MT","MTS","PK","PKS","RDGE","PASS","HLL","HLLS","SPUR"}:
                    continue
            elif feature not in {"PPLC","PPLA","PPLA2","PPLA3","PPLA4","PPL","PPLX","ADM2","ADM3","ADM4"}:
                continue
            parts = dict.fromkeys(item[k] for k in ("country", "admin1", "admin2", "name") if item.get(k))
            name = "·".join(parts)
            if (not item.get("name") or len(name) > 100 or
                    any(not isinstance(p, str) or not re.fullmatch(r"[\w ·（）(),，.'’\-]{1,80}", p) for p in parts) or
                    type(item["id"]) is not int or item["id"] <= 0 or
                    any(type(item[k]) not in (int, float) or not -limit <= item[k] <= limit
                        for k, limit in (("latitude", 90), ("longitude", 180)))):
                raise ValueError("LOCATION_SOURCE_UNAVAILABLE")
            matches.append(dict(id=f"geonames-{item['id']}", name=name, latitude=item["latitude"], longitude=item["longitude"]))
        return matches

    failed = False
    cache_key = key(query)
    with _place_lock:
        cached = _place_cache.get(cache_key)
        if cached and cached[0] > time.monotonic():
            return best(cached[1], query)
    for lookup in ((outdoor, gazetteer) if poi or re.search(r"[\u3400-\u9fff]", query) else (gazetteer, outdoor)):
        try:
            found = lookup()
            if found:
                with _place_lock:
                    _place_cache[cache_key] = time.monotonic() + 86400, found
                    _place_cache.move_to_end(cache_key)
                    if len(_place_cache) > 512:
                        _place_cache.popitem(last=False)
                return best(found, query)
        except (ValueError, OSError, KeyError, TypeError):
            failed = True
    raise ValueError("LOCATION_SOURCE_UNAVAILABLE" if failed else "LOCATION_NOT_FOUND")


def hourly_source(endpoint, meta_url, place, start, now, fields, max_age, params, *, air=False):
    meta = get_json(meta_url, now=now)
    times = [meta[k] for k in ("last_run_initialisation_time", "last_run_availability_time", "data_end_time")]
    if any(type(t) is not int or not 0 < t < 253402214400 for t in times):
        raise ValueError("invalid model metadata")
    run, available, end = [datetime.fromtimestamp(t, TZ) for t in times]
    if not run <= available <= now + timedelta(minutes=5) or now - run > max_age * HOUR or now - available > 24 * HOUR or end < now:
        raise ValueError("stale forecast")
    if end <= start:
        raise OutsideWindow()
    params = dict(params, latitude=place["latitude"], longitude=place["longitude"], timezone=ZONENAME,
                  hourly=",".join(fields), start_date=start.date(), end_date=min(end, start+(47 if air else 48)*HOUR).date())
    data = get_json(endpoint, params, now=now)
    if data["timezone"] != ZONENAME or data["utc_offset_seconds"] != 28800:
        raise ValueError("invalid timezone")
    series = data["hourly"]
    stamps = series["time"]
    if not 0 < len(stamps) <= 240 or stamps != sorted(set(stamps)) or not all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:00", t) for t in stamps):
        raise ValueError("invalid time axis")
    index = {datetime.fromisoformat(t).replace(tzinfo=TZ): i for i, t in enumerate(stamps)}
    rows = [{"time": (start+i*HOUR).isoformat()} for i in range(48)]
    if not air:
        for h, row in enumerate(rows):
            row["periodEnd"] = (start + (h + 1) * HOUR).isoformat()
    for source, (field, unit, low, high, offset) in fields.items():
        values = series.get(source)
        supplied_unit = data.get("hourly_units", {}).get(source)
        valid_series = (isinstance(values, list) and len(values) == len(stamps)
                        and isinstance(supplied_unit, str) and supplied_unit.replace("µ","μ") == unit)
        if not valid_series and (air or source in series and source in {
                "temperature_2m", "relative_humidity_2m", "precipitation", "precipitation_probability", "rain", "snowfall"}):
            raise ValueError("invalid hourly series")
        for h, row in enumerate(rows):
            t = start + ((h//3*3+3) if offset == 3 else h+offset)*HOUR
            i = index.get(t)
            v = values[i] if t < end and i is not None and valid_series else None
            row[field] = v if type(v) in (float,int) and math.isfinite(v) and low <= v <= high else None
            if field == "weatherCode" and row[field] is not None:
                row[field] = int(v) if v == int(v) else None
    return rows, data


def forecast(place, start, now):
    day = start.date().isoformat()
    for index, (endpoint, meta) in enumerate(SOURCES):
        try:
            rows, data = hourly_source(endpoint, meta, place, start, now, FIELDS, 24,
                                       dict(models="ecmwf_ifs", daily="weather_code", wind_speed_unit="ms",
                                            temperature_unit="celsius", precipitation_unit="mm"))
            break
        except OutsideWindow:
            raise
        except (ValueError, OSError, KeyError, TypeError):
            if index == len(SOURCES)-1:
                raise
    daily = data.get("daily") or {}
    dates, codes = daily.get("time"), daily.get("weather_code")
    code = None
    if (isinstance(dates, list) and isinstance(codes, list) and len(dates) == len(codes) <= 4
            and dates.count(day) == 1 and data.get("daily_units", {}).get("weather_code") == "wmo code"):
        value = codes[dates.index(day)]
        if type(value) in (int, float) and 0 <= value <= 99 and value == int(value):
            code = int(value)
    return dict(date=day, city=place, timezone=ZONENAME, hourly=rows, fetchedAt=now.isoformat(),
                source=dict(model="ecmwf_ifs", provider="Open-Meteo"),
                weatherSummary=weather_summary.invoke(dict(date=day, code=code if type(code) is int else None)),
                windBrief=wind_brief.invoke({k:[row[field] for row in rows] for k,field in
                                           (("speeds","windSpeedMs"),("gusts","windGustMs"),("directions","windDirectionDeg"))}))


def cams(place, start, now):
    europe = -24.95 <= place["longitude"] <= 44.95 and 30.05 <= place["latitude"] <= 71.95
    domain = "cams_europe" if europe else "cams_global"
    rows, _ = hourly_source("https://air-quality-api.open-meteo.com/v1/air-quality",
                            f"https://air-quality-api.open-meteo.com/data/{domain}/static/meta.json",
                            place, start, now, {"pm2_5": ("pm25","μg/m³",0,5000,0)}, 48 if europe else 36,
                            {"domains":domain}, air=True)
    if all(row["pm25"] is None for row in rows):
        raise OutsideWindow()
    return dict(city=place, timezone=ZONENAME, hourly=rows, source=dict(model=domain), fetchedAt=now.isoformat())
