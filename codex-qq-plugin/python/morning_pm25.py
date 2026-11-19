"""Fixed Beijing and Tianjin PM2.5 forecasts for winter weather reports."""

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import date, datetime, time, timedelta, timezone
import json
from itertools import islice
import math
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
from typing import Annotated, Literal

import httpx
from langchain_core.tools import tool
from pydantic import Field


UTC = timezone.utc
BEIJING = timezone(timedelta(hours=8))
HOUR = timedelta(hours=1)
CITIES = {"beijing": (39.9042, 116.4074), "tianjin": (39.0842, 117.2009)}
GEFS_BUCKET = "https://noaa-gefs-pds.s3.amazonaws.com"
MAX_INDEX_BYTES = 16 * 1024
MAX_GRIB_BYTES = 2 * 1024 * 1024
PM25_UNITS = {"(10**-6 g) m**-3", "10**-6 g m**-3", "µg m**-3", "μg m**-3"}
Pm25 = Annotated[float, Field(strict=True, ge=0, le=5000)]
HourlyPm25 = Annotated[list[Pm25], Field(min_length=48, max_length=48)]


@tool
def choose_morning_pm25(cams: HourlyPm25, gefs: HourlyPm25) -> dict:
    """Choose the lower mean over two complete, aligned 48-hour PM2.5 forecasts."""
    cams_mean = math.fsum(cams) / 48
    gefs_mean = math.fsum(gefs) / 48
    return {"model": "gefs_aerosols" if gefs_mean < cams_mean else "cams_global",
            "camsMean": cams_mean, "gefsMean": gefs_mean}


def forecast_window(day: date, now: datetime, hours: int = 48) -> tuple[datetime, datetime, range]:
    start = datetime.combine(day, time(), BEIJING).astimezone(UTC)
    first_native = start.replace(hour=start.hour // 3 * 3)
    # A single cycle must cover the first native point as well as the last.
    latest_ready = min(first_native, now - 4 * HOUR)
    run = latest_ready.replace(hour=latest_ready.hour // 6 * 6, minute=0, second=0, microsecond=0)
    first = (first_native - run) // HOUR
    last = math.ceil(((start + (hours - 1) * HOUR - run) // HOUR) / 3) * 3
    if not 0 <= first <= last <= 120 or now - run > 36 * HOUR:
        raise ValueError("GEFS forecast cycle does not cover the report window")
    return start, run, range(first, last + 1, 3)


def download(client, url: str, limit: int, byte_range: tuple[int, int] | None = None) -> bytes:
    headers = {"Range": f"bytes={byte_range[0]}-{byte_range[1]}"} if byte_range else {}
    for attempt in range(2):
        try:
            with client.stream("GET", url, headers=headers) as response:
                response.raise_for_status()
                expected_status = 206 if byte_range else 200
                if response.status_code != expected_status or response.headers.get("content-encoding", "identity") != "identity":
                    raise ValueError("unexpected GEFS response")
                if byte_range:
                    lo, hi = byte_range
                    if not re.fullmatch(rf"bytes {lo}-{hi}/[0-9]+", response.headers.get("content-range", "")):
                        raise ValueError("unexpected GEFS byte range")
                payload = bytearray()
                for chunk in response.iter_raw(65536):
                    payload.extend(chunk)
                    if len(payload) > limit:
                        raise ValueError("GEFS response exceeds size limit")
                if not payload or (byte_range and len(payload) != limit):
                    raise ValueError("incomplete GEFS response")
                return bytes(payload)
        except httpx.HTTPStatusError as exc:
            if attempt or exc.response.status_code not in {408, 500, 502, 503, 504}:
                raise
        except (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError):
            if attempt:
                raise


def load_frame(client, run: datetime, hour: int) -> bytes:
    cycle = run.strftime("%H")
    url = (f"{GEFS_BUCKET}/gefs.{run:%Y%m%d}/{cycle}/chem/pgrb2ap25/"
           f"gefs.chem.t{cycle}z.a2d_0p25.f{hour:03d}.grib2")
    lines = download(client, url + ".idx", MAX_INDEX_BYTES).decode("ascii").splitlines()
    matching = [i for i, line in enumerate(lines) if f":d={run:%Y%m%d%H}:PMTF:surface:" in line
                and ":aerosol=Total aerosol:aerosol_size <2.5e-06:" in line]
    if len(matching) != 1 or matching[0] + 1 >= len(lines):
        raise ValueError("GEFS total surface PM2.5 index entry is missing")
    index = matching[0]
    lo, stop = (int(lines[i].split(":")[1]) for i in (index, index + 1))
    if not (0 <= lo < stop <= 128 * 1024 * 1024 and 1000 <= stop - lo <= MAX_GRIB_BYTES):
        raise ValueError("invalid GEFS index offsets")
    return download(client, url, stop - lo, (lo, stop - 1))


def decode_points(eccodes, raw: bytes, run: datetime, hour: int, cities: tuple[str, ...]) -> dict[str, float]:
    if raw[:4] != b"GRIB" or raw[-4:] != b"7777" or int.from_bytes(raw[8:16], "big") != len(raw):
        raise ValueError("invalid GEFS GRIB2 message")
    message = eccodes.codes_new_from_message(raw)
    try:
        expected = {"edition": 2, "discipline": 0, "parameterCategory": 13, "parameterNumber": 193,
                    "typeOfLevel": "surface", "aerosolType": 62000, "indicatorOfUnitOfTimeRange": 1,
                    "forecastTime": hour, "dataDate": int(run.strftime("%Y%m%d")), "dataTime": run.hour * 100}
        if any(eccodes.codes_get(message, field) != value for field, value in expected.items()):
            raise ValueError("unexpected GEFS PM2.5 field or forecast time")
        scale = eccodes.codes_get(message, "scaleFactorOfFirstSize")
        size = eccodes.codes_get(message, "scaledValueOfFirstSize")
        if (not -12 <= scale <= 12 or not math.isclose(size * 10.0 ** -scale, 2.5e-6, rel_tol=0.001)
                or eccodes.codes_get(message, "units") not in PM25_UNITS
                or eccodes.codes_get(message, "numberOfPoints") != 1440 * 721):
            raise ValueError("unexpected GEFS PM2.5 units, particle size or grid")
        values = {}
        for city in cities:
            point, = eccodes.codes_grib_find_nearest(message, *CITIES[city])
            if not 0 <= point.distance <= 25 or not 0 <= point.value <= 5000:
                raise ValueError("GEFS grid point is outside the requested area or value range")
            values[city] = float(point.value)
        return values
    finally:
        eccodes.codes_release(message)


def interpolate_hourly(start: datetime, run: datetime, native: dict[int, float], hours: int = 48) -> list[dict]:
    result = []
    for index in range(hours):
        stamp = start + index * HOUR
        hour = (stamp - run) // HOUR
        lo, remainder = divmod(hour, 3)
        lo *= 3
        value = native[lo]
        if remainder:
            value += (native[lo + 3] - value) * remainder / 3
        result.append({"time": stamp.astimezone(BEIJING).isoformat(), "pm25": value})
    return result


def forecast_cities(cities: tuple[str, ...], day: date, now: datetime, hours: int) -> dict:
    # Keep the optional decoder out of the main Agent and map runtimes.
    runtime = Path(__file__).resolve().parent / ".pm25-runtime"
    if runtime.is_dir():
        sys.path.insert(0, str(runtime))
    import eccodes

    start, run, leads = forecast_window(day, now, hours)
    native = {city: {} for city in cities}
    leads = iter(leads)
    workers = 5
    with httpx.Client(timeout=httpx.Timeout(9, connect=4, pool=4), trust_env=False,
                      headers={"Accept-Encoding": "identity", "User-Agent": "AlexBot morning GEFS forecast"},
                      limits=httpx.Limits(max_connections=workers, max_keepalive_connections=workers)) as client:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            pending = {pool.submit(load_frame, client, run, hour): hour for hour in islice(leads, workers)}
            while pending:
                done, _ = wait(pending, return_when=FIRST_COMPLETED)
                for frame in done:
                    hour = pending.pop(frame)
                    for city, value in decode_points(eccodes, frame.result(), run, hour, cities).items():
                        native[city][hour] = value
                    following = next(leads, None)
                    if following is not None:
                        pending[pool.submit(load_frame, client, run, following)] = following
    return {city: {"city": city, "date": day.isoformat(), "modelRunAt": run.isoformat(),
                   "hourly": interpolate_hourly(start, run, native[city], hours)}
            for city in cities}


@tool
def forecast_morning_gefs(city: Literal["beijing", "tianjin"], date_iso: str, now_seconds: int) -> dict:
    """Read the public NOAA GEFS-Aerosols surface PM2.5 field for a scheduled city."""
    now = datetime.fromtimestamp(now_seconds, UTC)
    day = date.fromisoformat(date_iso)
    if day != now.astimezone(BEIJING).date() or day.month not in {11, 12, 1, 2, 3}:
        raise ValueError("GEFS request is outside the morning report's winter window")
    return forecast_cities((city,), day, now, 48)[city]


@tool
def forecast_calendar_gefs(now_seconds: int) -> dict:
    """Fetch both cities and the two overlapping 48-hour report windows in one download."""
    now = datetime.fromtimestamp(now_seconds, UTC)
    day = now.astimezone(BEIJING).date()
    if day.month not in {11, 12, 1, 2, 3}:
        raise ValueError("GEFS cache is outside its winter schedule")
    forecasts = forecast_cities(tuple(CITIES), day, now, 72)
    for result in forecasts.values():
        result["fetchedAt"] = now.isoformat()
    return {"date": day.isoformat(), "forecasts": forecasts}


def write_cache(filename: str, data: dict) -> None:
    target = Path(os.environ["QQ_BRIDGE_HOME"]) / ".private" / filename
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(data, stream, allow_nan=False)
            stream.close()
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)


def prepare_cache(city: str, date_iso: str, now_seconds: int) -> dict:
    forecast = forecast_morning_gefs.invoke({"city": city, "date_iso": date_iso, "now_seconds": now_seconds})
    forecast["fetchedAt"] = datetime.fromtimestamp(now_seconds, UTC).isoformat()
    write_cache(f"morning-gefs-{city}.json", forecast)
    return {"ok": True, "date": date_iso, "city": city,
            "modelRunAt": forecast["modelRunAt"], "hours": len(forecast["hourly"])}


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else None
    try:
        if action == "--calendar-cache":
            data = forecast_calendar_gefs.invoke({"now_seconds": int(sys.argv[2])})
            write_cache("morning-gefs-calendar.json", data)
            result = {"ok": True, "date": data["date"], "cities": list(data["forecasts"]),
                      "hours": len(data["forecasts"]["beijing"]["hourly"])}
        elif action == "--cache":
            _, city, date_iso, now_seconds = sys.argv[1:]
            result = prepare_cache(city, date_iso, int(now_seconds))
        else:
            actions = {"forecast": forecast_morning_gefs, "choose": choose_morning_pm25}
            packet = json.loads(sys.stdin.buffer.readline(16385))
            result = actions[packet["action"]].invoke(packet["data"])
    except ImportError:
        result = {"error": "MORNING_GEFS_DECODER_UNAVAILABLE"}
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        result = {"error": "FORECAST_SOURCE_RATE_LIMITED" if status == 429 else "FORECAST_SOURCE_HTTP_ERROR",
                  "httpStatus": status}
    except httpx.TimeoutException:
        result = {"error": "FORECAST_SOURCE_TIMEOUT"}
    except httpx.RequestError:
        result = {"error": "FORECAST_SOURCE_UNAVAILABLE"}
    except Exception:
        result = {"error": "MORNING_PM25_UNAVAILABLE"}
    print(json.dumps(result, allow_nan=False))
    return int(action in {"--cache", "--calendar-cache"} and "error" in result)


if __name__ == "__main__":
    sys.exit(main())
