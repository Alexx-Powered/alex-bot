"""Fixed Visual Crossing ECMWF backup for the two scheduled morning-report cities."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import math
import re
import sys
import time
from typing import Literal

import httpx
from langchain_core.tools import tool

UTC = timezone.utc
CHINA = timezone(timedelta(hours=8))
HOUR = 3600
DAY = 24 * HOUR
FIRST_LIVE_HOUR = 8
CITIES = {"beijing": (39.9042, 116.4074), "tianjin": (39.0842, 117.2009)}
TIMELINE = "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline"
ENSEMBLE = "https://openmeteo.s3.amazonaws.com/data/ecmwf_ifs025_ensemble"
MODEL = "ecmwf_2"
NUMBER_FIELDS = {
    "temp": (-90, 65), "humidity": (0, 100), "cloudcover": (0, 100),
    "windspeed": (0, 540), "winddir": (0, 360), "windgust": (0, 540),
    "precip": (0, 1000), "snow": (0, 1000),
}
ICONS = {
    "clear-day": 0, "clear-night": 0, "partly-cloudy-day": 2, "partly-cloudy-night": 2,
    "cloudy": 3, "fog": 45, "rain": 61, "showers-day": 80, "showers-night": 80,
    "snow": 71, "snow-showers-day": 85, "snow-showers-night": 85,
    "thunder-rain": 95, "thunder-showers-day": 95, "thunder-showers-night": 95,
}
WATER_TYPES = {"rain", "snow", "freezingrain", "ice"}
EXPECTED_ERRORS = {
    "MORNING_EC_CACHE_UNAVAILABLE", "MORNING_EC_TIMELINE_UNAVAILABLE", "MORNING_EC_ENSEMBLE_UNAVAILABLE",
}


def local(stamp):
    return datetime.fromtimestamp(stamp, CHINA)


def midnight(now):
    return int(local(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


def validate_run(value, now):
    if not isinstance(value, str) or not re.fullmatch(r"\d{8}_(00|06|12|18)", value):
        raise ValueError("invalid ECMWF run")
    run = int(datetime.strptime(value, "%Y%m%d_%H").replace(tzinfo=UTC).timestamp())
    if not 0 <= now - run <= 36 * HOUR:
        raise ValueError("ECMWF run outside its validity window")
    return run


def fetch_json(client, url, **kwargs):
    with client.stream("GET", url, **kwargs) as response:
        response.raise_for_status()
        if "application/json" not in response.headers.get("Content-Type", "").lower():
            raise ValueError("unexpected response type")
        result = bytearray()
        for block in response.iter_bytes(chunk_size=16384):
            result.extend(block)
            if len(result) > 256 * 1024:
                raise ValueError("response too large")
        return json.loads(result)


def valid_value(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


def validate_row(row):
    if not all(valid_value(row.get(field), *bounds) for field, bounds in NUMBER_FIELDS.items()):
        raise ValueError("missing or invalid ECMWF field")
    icon, types = row.get("icon"), row.get("preciptype")
    if icon not in ICONS and icon != "wind":
        raise ValueError("unsupported weather icon")
    if types is not None and (not isinstance(types, list) or len(types) > 4
                              or any(kind not in WATER_TYPES for kind in types)):
        raise ValueError("unrecognized precipitation type")
    return {**{key: row[key] for key in NUMBER_FIELDS}, "icon": icon, "preciptype": types}


def timeline(client, city, start, end, wanted, now):
    coords = CITIES[city]
    fields = ["datetime", "datetimeEpoch", "source", *NUMBER_FIELDS, "icon", "preciptype"]
    date_range = "/".join(local(stamp).strftime("%Y-%m-%dT%H:%M:%S") for stamp in (start, end))
    address = f"{TIMELINE}/{coords[0]},{coords[1]}/{date_range}"
    data = fetch_json(client, address, params={
        "forecastDataset": MODEL, "unitGroup": "metric", "include": "days,hours,fcst",
        "options": "attribution,useexacttimeinterval", "iconSet": "icons2", "elements": ",".join(fields),
    })
    if data.get("timezone") != "Asia/Shanghai" or data.get("tzoffset") != 8 or any(
        not valid_value(data.get(key), value - 0.002, value + 0.002)
        for key, value in zip(("latitude", "longitude"), coords, strict=True)
    ):
        raise ValueError("mismatched Visual Crossing location")
    attribution = data["attribution"]
    if len(attribution) != 1 or attribution[0].get("modelId") != MODEL:
        raise ValueError("unexpected weather model")
    run = attribution[0]["runId"]
    validate_run(run, now)
    wanted = set(wanted)
    rows = {}
    for day in data["days"]:
        for row in day.get("hours", []):
            stamp = row.get("datetimeEpoch")
            if stamp not in wanted:
                continue
            # Interpolated hours can omit source; the enclosing request is forecast-only.
            if (type(stamp) is not int or stamp in rows or row.get("source") not in ("fcst", None)
                    or f'{day["datetime"]}T{row["datetime"]}' != local(stamp).isoformat()[:19]):
                raise ValueError("unexpected Visual Crossing forecast hour")
            rows[stamp] = validate_row(row)
    if rows.keys() != wanted:
        raise ValueError("incomplete Visual Crossing forecast")
    return run, rows


def take_snapshot(client, city, now):
    start = midnight(now) + DAY
    if not start - 2 * HOUR <= now < start:
        raise ValueError("outside evening snapshot window")
    stamps = range(start, start + FIRST_LIVE_HOUR * HOUR, HOUR)
    run, rows = timeline(client, city, start - 2 * HOUR, stamps.stop, stamps, now)
    return {"city": city, "date": local(start).date().isoformat(), "captured": now, "run": run,
            "rows": [rows[stamp] for stamp in stamps]}


def archived_rows(snapshot, city, start, now):
    if not isinstance(snapshot, dict) or snapshot.get("city") != city or snapshot.get("date") != local(start).date().isoformat():
        raise ValueError("archive location or date mismatch")
    captured = snapshot.get("captured")
    if type(captured) is not int or not start - 2 * HOUR <= captured < start or not 0 < now - captured <= 12 * HOUR:
        raise ValueError("archive outside its validity window")
    validate_run(snapshot.get("run"), captured)
    if len(snapshot["rows"]) != FIRST_LIVE_HOUR:
        raise ValueError("archive missing forecast hours")
    return [validate_row(row) for row in snapshot["rows"]]


def probabilities(client, city, start, now):
    from native_forecast import RangeFile, libraries
    np, reader = libraries()
    meta = fetch_json(client, ENSEMBLE + "/static/meta.json")
    step, length = meta["temporal_resolution_seconds"], meta["chunk_time_length"]
    run, available, data_end = (meta[key] for key in
                                ("last_run_initialisation_time", "last_run_availability_time", "data_end_time"))
    if (step != 3 * HOUR or type(length) is not int or not 48 <= length <= 256
            or not all(type(stamp) is int for stamp in (run, available, data_end))
            or not now - 36 * HOUR <= run <= available <= now + 300
            or "BBOX[-90.0,-180.0,90.0,179.75]" not in meta["crs_wkt"]):
        raise ValueError("invalid ensemble metadata")
    first, last = (start + HOUR) // step, (start + 2 * DAY + step - 1) // step
    if last * step >= data_end:
        raise ValueError("incomplete ensemble forecast")
    lat, lon = CITIES[city]
    y, x = round((lat + 90) * 4), round((lon + 180) * 4)
    values = []
    deadline = time.monotonic() + 19
    for chunk in range(first // length, last // length + 1):
        url = f"{ENSEMBLE}/precipitation_probability/chunk_{chunk}.om"
        store = RangeFile(client, url, deadline)
        if not store.updated_at or not run <= store.updated_at <= now + 300:
            raise ValueError("stale ensemble data")
        with reader.from_fsspec(store, url) as data:
            if data.shape != (721, 1440, length):
                raise ValueError("unexpected ensemble grid")
            offset = chunk * length
            values.extend(map(float, data[y, x, max(0, first - offset):min(length, last + 1 - offset)].ravel()))
    if len(values) != last - first + 1 or not all(valid_value(v, 0, 100) for v in values):
        raise ValueError("missing ensemble precipitation probability")
    # Native values describe the preceding 3h block's rate threshold. Interpolate
    # their percentages to the 48 hour-ending timestamps used by the report.
    return np.interp(np.arange(start + HOUR, start + 2 * DAY + 1, HOUR),
                     np.arange(first, last + 1) * step, values).tolist()


def precipitation(row):
    amount, snow, icon = row["precip"], row["snow"], row["icon"]
    kinds = set(row["preciptype"] or ())
    code = ICONS.get(icon, 3 if row["cloudcover"] > 90 else 2 if row["cloudcover"] > 20 else 0)
    if "freezingrain" in kinds and amount > 0:
        code = 66
    if "ice" in kinds and amount > 0:
        return None, code
    if amount == 0:
        return 0, code
    if snow == 0 and (kinds == {"rain"} or (not kinds and code in (61, 80, 95))):
        return amount, 61 if code < 51 else code
    if (kinds and "rain" not in kinds) or (not kinds and snow > 0):
        return 0, 71 if code < 66 else code
    # The total liquid equivalent cannot tell us how much of a mixed hour was rain.
    return None, code


def forecast(client, city, now, snapshot):
    start = midnight(now)
    end = start + 2 * DAY
    first_live = start + FIRST_LIVE_HOUR * HOUR
    try:
        if not start + 7 * HOUR <= now < first_live:
            raise ValueError("outside morning preparation window")
        archive = archived_rows(snapshot, city, start, now)
    except (TypeError, ValueError, KeyError, AttributeError) as error:
        raise ValueError("MORNING_EC_CACHE_UNAVAILABLE") from error
    with ThreadPoolExecutor(max_workers=3) as workers:
        current = workers.submit(timeline, client, city, start + 7 * HOUR, end,
                                 range(first_live, end, HOUR), now)
        last = workers.submit(timeline, client, city, end - 2 * HOUR, end + HOUR, [end], now)
        chance = workers.submit(probabilities, client, city, start, now)
        try:
            run, rows = current.result()
            last_run, last_row = last.result()
            if last_run != run:
                raise ValueError("the forecast cycle changed during acquisition")
            rows.update(last_row)
        except Exception as error:
            raise ValueError("MORNING_EC_TIMELINE_UNAVAILABLE") from error
        try:
            probability = chance.result()
        except Exception as error:
            raise ValueError("MORNING_EC_ENSEMBLE_UNAVAILABLE") from error
    hourly = []
    for i, stamp in enumerate(range(start, end, HOUR)):
        instant = archive[i] if stamp < first_live else rows[stamp]
        following = archive[i + 1] if stamp + HOUR < first_live else rows[stamp + HOUR]
        rain, code = precipitation(following)
        hourly.append({
            "time": local(stamp).isoformat(), "periodEnd": local(stamp + HOUR).isoformat(),
            "temperatureC": instant["temp"], "humidityPct": instant["humidity"], "cloudCoverPct": instant["cloudcover"],
            "windSpeedMs": instant["windspeed"] / 3.6, "windGustMs": following["windgust"] / 3.6,
            "windDirectionDeg": instant["winddir"], "precipitationMm": following["precip"], "rainMm": rain,
            "snowfallCm": following["snow"], "precipitationProbabilityPct": probability[i], "weatherCode": code,
        })
    return {"hourly": hourly, "weatherCode": max(row["weatherCode"] for row in hourly[:24]),
            "modelRunAt": datetime.fromtimestamp(validate_run(run, now), UTC).isoformat(),
            "archiveFetchedAt": local(snapshot["captured"]).isoformat()}


@tool
def scheduled_visual_crossing(city: Literal["beijing", "tianjin"], now: int,
                              action: Literal["capture", "forecast"], snapshot: dict | None = None) -> dict:
    """Acquire only the fixed Beijing/Tianjin morning forecast, using ECMWF and no model inference."""
    with httpx.Client(timeout=8, follow_redirects=False, trust_env=False) as client:
        if action == "capture":
            return take_snapshot(client, city, now)
        return forecast(client, city, now, snapshot)


if __name__ == "__main__":
    try:
        packet = json.loads(sys.stdin.buffer.readline(65537))
        print(json.dumps(scheduled_visual_crossing.invoke(packet), allow_nan=False))
    except Exception as error:
        code = str(error) if type(error) is ValueError and str(error) in EXPECTED_ERRORS else "MORNING_EC_TIMELINE_UNAVAILABLE"
        print(json.dumps({"error": code}))
