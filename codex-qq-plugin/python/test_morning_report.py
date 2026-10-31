import json
import unittest
from copy import deepcopy
from datetime import datetime, timedelta

from morning_report import analyze_morning


def packet(day="2026-10-31", clock="06:00:00", workday=False, holiday=False, **changes):
    midnight = datetime.fromisoformat(day + "T00:00:00+08:00")
    weather = []
    for hour in range(24):
        start = midnight + timedelta(hours=hour)
        weather.append({"time": start.isoformat(), "periodEnd": (start + timedelta(hours=1)).isoformat(),
                        "temperatureC": 22, "humidityPct": 60, "precipitationMm": 0,
                        "precipitationProbabilityPct": 0, "rainMm": 0, "snowfallCm": 0,
                        "windSpeedMs": 2, "solarRadiationWm2": 100, "weatherCode": 0, **changes})
    air = [{"time": (midnight + timedelta(hours=hour)).isoformat(), "pm25": 20} for hour in range(48)]
    return {"now": day + "T" + clock + "+08:00", "date": day, "city": "beijing", "cityName": "北京",
            "calendar": {"known": True, "holiday": holiday, "holidayName": "测试节假日" if holiday else "",
                         "workday": workday, "source": "offline-calendar-fixture"},
            "weather": {"hourly": weather}, "air": {"hourly": air}}


def set_pm(data, value):
    for hour in data["air"]["hourly"]:
        hour["pm25"] = value


class MorningReportTests(unittest.TestCase):
    def test_two_day_weather_does_not_mix_tomorrow_into_today_exercise_advice(self):
        data = packet()
        expected = analyze_morning(data)
        tomorrow = deepcopy(data["weather"]["hourly"])
        for row in tomorrow:
            for field in ("time", "periodEnd"):
                row[field] = (datetime.fromisoformat(row[field]) + timedelta(days=1)).isoformat()
            row.update(temperatureC=40, windSpeedMs=15, precipitationMm=20, weatherCode=95)
        data["weather"]["hourly"].extend(tomorrow)
        self.assertEqual(analyze_morning(data), expected)

    def test_normal_monday_and_wednesday_only_consider_evening(self):
        for day in ("2026-11-02", "2026-10-28"):
            with self.subTest(day=day):
                report = analyze_morning(packet(day, workday=True))
                self.assertEqual(len(report["windows"]), 1)
                self.assertEqual(report["windows"][0]["start"][11:16], "20:00")
                self.assertEqual(report["windows"][0]["end"][11:16], "22:00")
                self.assertEqual(report["recommendation"]["start"][11:16], "20:00")

    def test_holiday_rest_day_weekend_and_other_workdays_have_three_periods(self):
        cases = [packet("2026-11-02", holiday=True), packet("2026-10-28", holiday=True),
                 packet("2026-11-02", workday=False), packet("2026-10-31"),
                 packet("2026-11-01"), packet("2026-10-29", workday=True)]
        for data in cases:
            with self.subTest(day=data["date"], calendar=data["calendar"]):
                report = analyze_morning(data)
                self.assertEqual([(w["start"][11:16], w["end"][11:16]) for w in report["windows"]],
                                 [("07:00", "08:30"), ("16:00", "19:00"), ("20:00", "22:00")])
                self.assertEqual(report["windows"][0]["evaluatedHalfHours"], 3)
                self.assertEqual(report["recommendation"]["end"][11:16], "08:00")

    def test_unknown_or_inconsistent_calendar_uses_safe_weekday_schedule(self):
        for calendar in ({"known": False}, {"known": True}, {"known": True, "holiday": True, "workday": True}):
            data = packet("2026-11-02")
            data["calendar"] = calendar
            report = analyze_morning(data)
            self.assertEqual(len(report["windows"]), 1)
            self.assertTrue(any("节假日信息未确认" in note for note in report["notes"]))

    def test_late_start_rounds_up_to_half_hour_and_never_recommends_past(self):
        cases = [("07:00:00", "07:00"), ("07:00:01", "07:30"), ("07:30:00", "07:30"),
                 ("07:30:01", "08:00"), ("08:00:00", "08:00")]
        for clock, expected in cases:
            with self.subTest(clock=clock):
                data = packet(clock=clock)
                report = analyze_morning(data)
                self.assertEqual(report["windows"][0]["start"][11:16], expected)
                recommendation = report["recommendation"]
                self.assertGreaterEqual(datetime.fromisoformat(recommendation["start"]), datetime.fromisoformat(data["now"]))
        report = analyze_morning(packet(clock="08:30:00"))
        self.assertEqual(report["windows"][0]["level"], "expired")
        self.assertGreaterEqual(report["recommendation"]["start"][11:16], "16:00")
        self.assertEqual(analyze_morning(packet(clock="17:40:00"))["windows"][1]["start"][11:16], "18:00")

    def test_final_half_hour_and_entirely_expired_day(self):
        report = analyze_morning(packet(clock="21:00:01"))
        self.assertEqual(report["recommendation"]["start"][11:16], "21:30")
        self.assertEqual(report["recommendation"]["end"][11:16], "22:00")
        self.assertEqual(report["recommendation"]["evaluatedHalfHours"], 1)
        for clock in ("21:30:01", "22:00:00", "23:50:00"):
            with self.subTest(clock=clock):
                report = analyze_morning(packet(clock=clock))
                self.assertIsNone(report["recommendation"])
                self.assertTrue(all(w["level"] == "expired" for w in report["windows"]))
        data = packet()
        data["now"] = "2026-11-01T06:00:00+08:00"
        self.assertIsNone(analyze_morning(data)["recommendation"])

    def test_utc_now_is_converted_to_beijing_time(self):
        data = packet()
        data["now"] = "2026-10-31T09:01:00Z"
        report = analyze_morning(data)
        self.assertEqual(report["windows"][1]["start"], "2026-10-31T17:30:00+08:00")

    def test_all_avoid_thresholds_and_weather_codes(self):
        dangers = [{"temperatureC": 0}, {"temperatureC": 35}, {"windSpeedMs": 8},
                   {"precipitationMm": 1}, {"rainMm": 1}, {"precipitationProbabilityPct": 70},
                   {"snowfallCm": 0.01}, {"temperatureC": 28, "humidityPct": 80}]
        dangers += [{"weatherCode": code} for code in (95, 96, 97, 99, 56, 57, 66, 67, 48)]
        for danger in dangers:
            with self.subTest(danger=danger):
                report = analyze_morning(packet(**danger))
                self.assertTrue(all(w["level"] == "avoid" for w in report["windows"]))
                self.assertIsNone(report["recommendation"])
        data = packet()
        set_pm(data, 60)
        report = analyze_morning(data)
        self.assertTrue(all(w["level"] == "avoid" for w in report["windows"]))
        self.assertIsNone(report["recommendation"])
        self.assertIn("室内", report["windows"][0]["advice"])

    def test_caution_thresholds_and_ideal_temperature_boundaries(self):
        for changes in ({"solarRadiationWm2": 500}, {"windSpeedMs": 5}, {"weatherCode": 45},
                        {"temperatureC": 17.9}, {"temperatureC": 26.1}, {"precipitationProbabilityPct": 30}):
            with self.subTest(changes=changes):
                report = analyze_morning(packet(**changes))
                self.assertEqual(report["windows"][0]["level"], "caution")
        for pm in (35, 59.9):
            data = packet()
            set_pm(data, pm)
            self.assertEqual(analyze_morning(data)["windows"][0]["level"], "caution")
        for temperature in (18, 26):
            self.assertEqual(analyze_morning(packet(temperatureC=temperature))["windows"][0]["level"], "suitable")
        self.assertIn("遮阴", analyze_morning(packet(solarRadiationWm2=500))["windows"][0]["advice"])

    def test_every_missing_critical_field_is_unknown_not_zero_or_suitable(self):
        critical = ("temperatureC", "humidityPct", "precipitationMm", "precipitationProbabilityPct",
                    "rainMm", "snowfallCm", "windSpeedMs", "solarRadiationWm2", "weatherCode")
        for field in critical:
            with self.subTest(field=field):
                report = analyze_morning(packet(**{field: None}))
                self.assertEqual(report["windows"][0]["level"], "unknown")
                self.assertIsNone(report["recommendation"])
                self.assertIn(field, report["windows"][0]["missingFields"])
        data = packet()
        set_pm(data, None)
        report = analyze_morning(data)
        self.assertIsNone(report["windows"][0]["conditions"]["pm25Max"])
        self.assertIsNone(report["recommendation"])
        data = packet(solarRadiationWm2=0, precipitationMm=0, windSpeedMs=0)
        set_pm(data, 0)
        report = analyze_morning(data)
        self.assertEqual(report["windows"][0]["level"], "suitable")
        self.assertEqual(report["windows"][0]["conditions"]["pm25Max"], 0)

    def test_missing_data_does_not_hide_known_danger_and_no_hourly_interpolation(self):
        data = packet(temperatureC=None)
        set_pm(data, 60)
        self.assertEqual(analyze_morning(data)["windows"][0]["level"], "avoid")
        data = packet()
        data["weather"]["hourly"][7]["solarRadiationWm2"] = 600
        data["weather"]["hourly"][8]["solarRadiationWm2"] = 100
        report = analyze_morning(data)
        self.assertEqual(report["windows"][0]["conditions"]["solarRadiationMax"], 600)
        self.assertEqual(report["windows"][0]["score"], 84)
        self.assertEqual(report["recommendation"]["start"][11:16], "16:00", "same-score 60 minutes wins over the 08:00 half-hour")
        data["weather"]["hourly"].pop(7)
        self.assertEqual(analyze_morning(data)["windows"][0]["level"], "unknown")

    def test_worst_half_hour_wins_and_danger_is_never_averaged_away(self):
        data = packet()
        for row in data["weather"]["hourly"]:
            row["solarRadiationWm2"] = 500
        data["weather"]["hourly"][7]["solarRadiationWm2"] = 100
        data["weather"]["hourly"][8]["weatherCode"] = 95
        report = analyze_morning(data)
        self.assertEqual(report["windows"][0]["level"], "avoid")
        self.assertEqual(report["windows"][0]["score"], 0)
        self.assertEqual(report["recommendation"]["start"][11:16], "07:00")
        self.assertEqual(report["recommendation"]["end"][11:16], "08:00")
        self.assertEqual(report["recommendation"]["score"], 100)
        bad = packet(temperatureC=34, humidityPct=79, windSpeedMs=7.9, solarRadiationWm2=1500,
                     precipitationMm=0.9, precipitationProbabilityPct=69)
        set_pm(bad, 59.9)
        self.assertIsNone(analyze_morning(bad)["recommendation"])

    def test_pm_units_solar_meaning_and_json_contract_are_explicit(self):
        data = packet()
        data["city"], data["cityName"] = "tianjin", "天津"
        report = analyze_morning(data)
        self.assertTrue(report["title"].startswith("天津"))
        self.assertEqual((report["date"], report["city"], report["cityName"]), (data["date"], "tianjin", "天津"))
        notes = "\n".join(report["notes"])
        for phrase in ("μg/m³", "不是综合AQI", "不是UV指数", "按小时模型", "不是官方运动指数", "m/s"):
            self.assertIn(phrase, notes)
        self.assertEqual(json.loads(json.dumps(report, allow_nan=False))["version"], report["version"])
        for window in report["windows"]:
            self.assertIn(window["level"], {"suitable", "caution", "avoid", "unknown", "expired"})
            self.assertGreaterEqual(window["score"], 0)
            self.assertLessEqual(window["score"], 100)
        data["air"]["unit"] = "mg/m³"
        self.assertEqual(analyze_morning(data)["windows"][0]["level"], "unknown")

    def test_duplicate_or_wrong_weather_periods_are_not_trusted(self):
        data = packet()
        data["weather"]["hourly"].append(deepcopy(data["weather"]["hourly"][7]))
        self.assertEqual(analyze_morning(data)["windows"][0]["level"], "unknown")
        data = packet()
        data["weather"]["hourly"][7]["periodEnd"] = "2026-10-31T09:00:00+08:00"
        self.assertEqual(analyze_morning(data)["windows"][0]["level"], "unknown")


if __name__ == "__main__":
    unittest.main()
