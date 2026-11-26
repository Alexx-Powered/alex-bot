"""Both static weather pipelines see the same bounded calendar forecast."""
from contextlib import nullcontext
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image
import static_forecast as forecast
import static_weather_card as card
import worker_artifacts


START = datetime(2026, 11, 26, tzinfo=forecast.TZ)
NOW = START + 10 * forecast.HOUR
BEIJING = dict(id="beijing", name="北京", latitude=39.9042, longitude=116.4074)


def provider_data():
    count = 49
    stamps = [(START + h * forecast.HOUR).strftime("%Y-%m-%dT%H:%M") for h in range(count)]
    hourly = {k: [0] * count for k in forecast.FIELDS}
    hourly.update(time=stamps, wind_speed_10m=[1] * count, wind_gusts_10m=list(range(count)),
                  wind_direction_10m=[35] * count, precipitation=[h / 10 for h in range(count)],
                  weather_code=[2.0] * count)
    # A malformed optional field should affect only that series.
    hourly["cloud_cover"] = [43]
    day = START.date().isoformat()
    return {"timezone": forecast.ZONENAME, "utc_offset_seconds": 28800, "hourly": hourly,
            "hourly_units": {k: spec[1] for k, spec in forecast.FIELDS.items()},
            "daily": {"time": [day, day], "weather_code": [0, 95]}, "daily_units": {"weather_code": "wmo code"}}


def metadata():
    return dict(last_run_initialisation_time=int(START.timestamp()),
                last_run_availability_time=int(NOW.timestamp()),
                data_end_time=int((START + 29 * forecast.HOUR).timestamp()))


def air(source, values):
    return {"city": BEIJING, "timezone": forecast.ZONENAME, "source": {"model": source},
            "fetchedAt": NOW.isoformat(),
            "hourly": [{"time": (START + i * forecast.HOUR).isoformat(), "pm25": v} for i, v in enumerate(values)]}


class Timing:
    def span(self, name):
        return nullcontext()


class WorkerStaticWeatherTests(unittest.TestCase):
    def test_partial_calendar_matches_original_js_across_hour_and_three_hour_intervals(self):
        data, meta = provider_data(), metadata()
        js = """
          import {getWeatherBrief} from './src/weather.mjs';
          import {readFileSync} from 'node:fs';
          const p=JSON.parse(readFileSync(0, 'utf8'));
          const fetchImpl=async address => new Response(JSON.stringify(
            String(address).includes('meta.json') ? p.meta : p.data
          ), {headers:{'date': new Date(p.now).toUTCString(), 'content-type':'application/json'}});
          const output=await getWeatherBrief({place:p.place, day:'today', days:2, exerciseFields:true,
            partialWindow:true, now:p.now, fetchImpl});
          process.stdout.write(JSON.stringify([output.hourly,output.windBrief,output.weatherSummary]));
        """
        run = subprocess.run(["node", "--input-type=module", "-e", js], cwd=forecast.ROOT,
                             input=json.dumps(dict(data=data, meta=meta, now=int(NOW.timestamp()*1000), place=BEIJING)),
                             capture_output=True, text=True, encoding="utf-8", timeout=25, check=True,
                             env=dict(os.environ, QQ_PYTHON=sys.executable))
        with patch.object(forecast, "get_json", side_effect=[meta, data]):
            new = forecast.forecast(BEIJING, START, NOW)
        self.assertEqual([new["hourly"], new["windBrief"], new["weatherSummary"]], json.loads(run.stdout))
        self.assertEqual([p["windGustMs"] for p in new["hourly"][:4]], [3, 3, 3, 6])
        self.assertEqual(new["hourly"][23]["precipitationMm"], 2.4)
        self.assertIsNone(new["hourly"][28]["precipitationMm"])
        self.assertIsNone(new["hourly"][29]["temperatureC"])
        self.assertIsNone(new["weatherSummary"]["code"])

    def test_stale_source_wrong_units_and_air_horizon_have_distinct_results(self):
        data, meta = provider_data(), metadata()
        stale = {**meta, "last_run_initialisation_time": int((NOW - 30 * forecast.HOUR).timestamp())}
        with patch.object(forecast, "get_json", side_effect=[stale, stale]) as get:
            with self.assertRaisesRegex(ValueError, "stale forecast"):
                forecast.forecast(BEIJING, START, NOW)
            self.assertEqual(get.call_count, 2)
        with patch.object(forecast, "get_json", return_value=meta):
            with self.assertRaises(forecast.OutsideWindow):
                forecast.cams(BEIJING, START + 48 * forecast.HOUR, NOW)
        with patch.object(forecast, "get_json", side_effect=[meta, data]):
            with self.assertRaisesRegex(ValueError, "invalid hourly series"):
                forecast.cams(BEIJING, START, NOW)

    def test_location_selection_uses_fixed_identity_and_caches_selected_dynamic_place(self):
        place = forecast.resolve_place("桦皮岭")
        self.assertEqual(forecast.resolve_place(f"桦皮岭（{place['id']}）"), place)
        point = dict(id="amap-TESTFIXTURE", name="综合测试岭村", latitude=40.23, longitude=114.56)
        with patch.object(forecast, "_place_cache", forecast.OrderedDict()), patch.object(forecast, "search_outdoor_places") as tool:
            tool.invoke.return_value = {"places": [point]}
            self.assertEqual(forecast.resolve_place("综合测试岭村"), point)
            self.assertEqual(forecast.resolve_place("综合测试岭村（amap-TESTFIXTURE）"), point)
            self.assertEqual(forecast.resolve_place("综合测试岭村"), point)
            tool.invoke.assert_called_once()
            with self.assertRaisesRegex(ValueError, "LOCATION_NOT_FOUND"):
                forecast.resolve_place("不存在（amap-UNKNOWN）")

    def test_winter_partial_sources_share_the_same_series_with_scoring_and_canvas(self):
        data, meta = provider_data(), metadata()
        data["hourly"]["cloud_cover"] = [5] * 49
        data["hourly"]["wind_gusts_10m"] = [1] * 49
        with patch.object(forecast, "get_json", side_effect=[meta, data]):
            weather = forecast.forecast(BEIJING, START, NOW)
        cams = air("cams_global", [38] * 24 + [None] * 24)
        complete_gefs = air("gefs_aerosols", [40] * 48)
        self.assertIs(card.select_air(air("cams_global", [50] * 48), complete_gefs), complete_gefs)
        gefs = air("gefs_aerosols", [None] * 24 + [80] * 24)
        with patch.object(card, "forecast", return_value=weather), patch.object(card, "cams", return_value=cams), \
                patch.object(card, "gefs", return_value=gefs), patch.object(card, "observations", return_value={10: 18}), \
                patch.object(card, "weather_alerts") as alerts:
            alerts.invoke.return_value = dict(ok=True, placeId="tianjin", date=START.date().isoformat(), hazards=["暴雨"])
            inputs = card.card_inputs(BEIJING, START, NOW, Timing())
            self.assertTrue(inputs["outdoorIndex"]["warningPartial"])
            self.assertNotIn("dailyDanger", inputs["outdoorIndex"])
            self.assertEqual([r["pm25"] for r in inputs["air"]["hourly"]], [38] * 24 + [80] * 24)
            self.assertEqual(inputs["air"]["source"]["name"], "CAMS / ECMWF → NOAA GEFS-Aerosols")
            self.assertIn("实测", inputs["outdoorIndex"]["periods"][0]["reason"])
            alerts.invoke.return_value.update(placeId="beijing", hazards=["重污染天气"], partial=False)
            with TemporaryDirectory() as tmp, patch.object(worker_artifacts, "DIRECTORY", Path(tmp)):
                reply = card.static_weather_card("北京", "today", "card", NOW, Timing())
                self.assertEqual(reply, {"text":"", "media":"png"})
                with Image.open(Path(tmp)/"card.png") as image:
                    self.assertGreater(image.width, 1000)
                    self.assertGreater(image.height, 3000)
                    image.verify()
            score = card.card_inputs(BEIJING, START, NOW, Timing())["outdoorIndex"]
            self.assertEqual(score["score"], 0)
            self.assertEqual(score["dailyDanger"]["reasons"], ["重污染天气红色预警"])
