"""Deterministic outdoor index based on hourly forecast data."""
from __future__ import annotations

from datetime import date as calendar_date, datetime
import json
import sys
from typing import Annotated

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, StrictInt


RULES = {
    "version": "outdoor-v10-20261126",
    "observationDecayHours": 12,
    "cloudKnots": [[0, 0], [10, 3], [20, 6], [50, 10], [100, 15]],
    "pm25Knots": [[0, 0], [60, 5], [100, 25], [150, 65], [200, 100]],
    "windLoss": {"none": 0, "blue": 22, "yellow": 70, "orange": 100},
    "rainLoss": {"none": 0, "brief": 20, "light": 35, "more": 50},
    "rainZero": {"hourlyAboveMm": 2.5, "periodAtLeastMm": 5},
    "gold": {"scoreAtLeast": 95, "cloudMeanAtMost": 5, "pm25PeakAtMost": 25,
             "windPeakAtMostMs": 5.4, "gustPeakAtMostMs": 7.9, "requiresNoRain": True},
    "periods": [["上午", 6, 12], ["下午", 12, 18]],
    "dailyPm25Above": 220,
}

Cloud = Annotated[float, Field(ge=0, le=100, strict=True)]
Pm = Annotated[float, Field(ge=0, le=5000, strict=True)]
Wind = Annotated[float, Field(ge=0, le=150, strict=True)]
Rain = Annotated[float, Field(ge=0, le=1000, strict=True)]


class OutdoorHour(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time: str
    cloud: Cloud | None
    pm25: Pm | None
    observed: Pm | None = None
    wind: Wind | None
    gust: Wind | None
    rain: Rain | None
    code: Annotated[StrictInt, Field(ge=0, le=99)] | None


class OutdoorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: str
    hours: Annotated[list[OutdoorHour], Field(max_length=48)]
    red_hazards: Annotated[list[Annotated[str, Field(min_length=1, max_length=40, pattern=r'^[\u3400-\u9fffA-Za-z0-9（）()·、-]+$')]], Field(max_length=96)] = Field(default_factory=list)


def interpolate(value, knots):
    if value >= knots[-1][0]:
        return knots[-1][1]
    for (x0, y0), (x1, y1) in zip(knots, knots[1:]):
        if x0 <= value <= x1:
            return y0 + (value - x0) * (y1 - y0) / (x1 - x0)
    raise ValueError("INVALID_SCORING_VALUE")


RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 97, 99}
MODERATE_RAIN_CODES = {63, 65, 67, 81, 82}
# No approved scoring rules for freezing precipitation, snow or thunderstorms.
UNREVIEWED_CODES = {48, 56, 57, 66, 71, 73, 75, 77, 85, 86, 95, 96, 97, 99}
SUPPORTED_CODES = {0, 1, 2, 3, 45, 51, 53, 55, 61, 63, 65, 67, 80, 81, 82}


def assess_period(name, start, end, rows, latest=None):
    result = {"name": name, "startHour": start, "endHour": end, "status": "unknown",
              "score": None, "grade": "unknown", "character": None, "gold": False}
    if len(rows) != end - start or any(any(getattr(row, field) is None for field in
                                          ("cloud", "wind", "gust", "rain", "code")) for row in rows):
        return {**result, "reason": "关键预报数据不足"}
    scoring_pm25 = []
    for row in rows:
        value = row.pm25
        if row.observed is not None:
            value = row.observed if value is None else (value + row.observed) / 2
        elif latest and value is not None:
            gap = (datetime.fromisoformat(row.time) - datetime.fromisoformat(latest.time)).total_seconds() / 3600
            duration = RULES["observationDecayHours"]
            if 0 < gap < duration:
                observation_weight = 0.5 * (1 - gap / duration)
                value = observation_weight * latest.observed + (1 - observation_weight) * value
        if value is None and row.wind >= 3.4:
            value = 30.0
        scoring_pm25.append(value)
    if None in scoring_pm25:
        return {**result, "reason": "关键预报数据不足"}
    if any(row.code in UNREVIEWED_CODES or row.code not in SUPPORTED_CODES for row in rows):
        return {**result, "reason": "该天气类型暂不评级"}
    cloud = sum(row.cloud for row in rows) / len(rows)
    pm = 0.8 * sum(scoring_pm25)/len(rows) + 0.2 * max(scoring_pm25)
    forecast_peak = max((row.pm25 for row in rows if row.pm25 is not None), default=None)
    wind, gust = max(row.wind for row in rows), max(row.gust for row in rows)
    rain, rain_peak = sum(row.rain for row in rows), max(row.rain for row in rows)
    wet_hours = sum(row.rain > 0 or row.code in RAIN_CODES for row in rows)
    wind_level = "orange" if wind >= 24.5 or gust >= 28.5 else "yellow" if wind >= 17.2 or gust >= 20.8 else "blue" if wind >= 10.8 or gust >= 13.9 else "none"
    rain_zero = rain >= 5 or rain_peak > 2.5 or any(row.code in MODERATE_RAIN_CODES for row in rows)
    rain_level = "zero" if rain_zero else "none" if not wet_hours else "brief" if wet_hours <= 2 and rain <= 0.5 and rain_peak <= 0.2 else "light" if rain <= 2 and rain_peak <= 0.5 else "more"
    deductions = {
        "cloud": interpolate(cloud, RULES["cloudKnots"]),
        "pm25": interpolate(pm, RULES["pm25Knots"]),
        "wind": RULES["windLoss"][wind_level],
        "rain": 100 if rain_zero else RULES["rainLoss"][rain_level],
    }
    zero_reasons = []
    if pm >= 200:
        zero_reasons.append("PM2.5达到清零门槛")
    if wind_level == "orange":
        zero_reasons.append("预报风力达橙色大风门槛，本时段清零")
    if rain_zero:
        zero_reasons.append("中雨以上或雨量达到清零门槛")
    score = 0 if zero_reasons else max(0, 100 - sum(deductions.values()))
    gold = score >= 95 and cloud <= 5 and max(scoring_pm25) <= 25 and wind <= 5.4 and gust <= 7.9 and rain_level == "none"
    grade = "gold" if gold else "excellent" if score >= 80 else "fair" if score >= 60 else "poor"
    character = {"gold": "夯", "excellent": "夯", "fair": "可", "poor": "拉"}[grade]
    rain_label = {"none": "无雨", "brief": "零星小雨", "light": "持续小雨" if wet_hours >= 3 else "小雨", "more": "小雨偏多", "zero": "中雨及以上"}[rain_level]
    reasons = zero_reasons or [rain_label, "云量较多" if cloud >= 70 else "云量适中" if cloud >= 30 else "少云"]
    if wind_level in {"blue", "yellow"} and not zero_reasons:
        level = "蓝色" if wind_level == "blue" else "黄色"
        reasons.append(f"预报风力达{level}大风门槛，扣{deductions['wind']}分")
    if latest:
        reasons.append(f"{latest.time[11:16]}实测 {latest.observed:g} μg/m³")
    reason = " · ".join(reasons)
    return {**result, "status": "complete", "score": score, "displayScore": round(score, 1), "grade": grade,
            "character": character, "gold": gold, "reason": reason, "deductions": deductions,
            "conditions": {"cloudMean": cloud, "pm25Peak": forecast_peak, "windPeak": wind, "gustPeak": gust,
                           "rainTotal": rain, "rainPeak": rain_peak, "wetHours": wet_hours,
                           "rainLevel": rain_level, "rainLabel": rain_label, "windLevel": wind_level}}


@tool(args_schema=OutdoorInput)
def outdoor_index(date: str, hours: list[OutdoorHour], red_hazards: list[str] | None = None) -> dict:
    """Score two fixed daytime windows from bounded public forecast samples, without I/O or model calls."""
    if calendar_date.fromisoformat(date).isoformat() != date:
        raise ValueError("INVALID_REPORT_DATE")
    by_hour = {}
    for item in hours:
        row = item if isinstance(item, OutdoorHour) else OutdoorHour.model_validate(item)
        stamp = datetime.fromisoformat(row.time)
        if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 8 * 3600 or stamp.minute or stamp.second or stamp.microsecond:
            raise ValueError("INVALID_FORECAST_HOUR")
        if stamp.date().isoformat() != date:
            continue
        if stamp.hour in by_hour:
            raise ValueError("DUPLICATE_FORECAST_HOUR")
        by_hour[stamp.hour] = row
    latest = next((by_hour[h] for h in sorted(by_hour, reverse=True) if by_hour[h].observed is not None), None)
    periods = [assess_period(name, start, end, [by_hour[h] for h in range(start, end) if h in by_hour], latest)
               for name, start, end in RULES["periods"]]
    polluted = len(by_hour) == 24 and all(row.pm25 is not None and row.pm25 > RULES["dailyPm25Above"] for row in by_hour.values())
    pollution_names = {'重污染', '重污染天气', '空气重污染', '空气重污染天气'}
    hazards = sorted({'重污染天气' if h in pollution_names else h for h in red_hazards or []})
    if polluted or hazards:
        reasons = [h+'红色预警' for h in hazards]
        if polluted and '重污染天气' not in hazards:
            reasons.append('全天PM2.5高于220 μg/m³')
        for p in periods:
            p.update(status='complete', score=0, displayScore=0, grade='poor', character='拉', gold=False, reason='应当避免外出')
        return {'date':date, 'version':RULES['version'], 'status':'complete', 'periods':periods, 'score':0,
                'displayScore':0, 'grade':'poor', 'character':'拉', 'gold':False,
                'dailyDanger':{'reasons':reasons},
                'recommendation':{'word':'全天', 'suffix':'应当避免外出'}}
    complete = all(p["status"] == "complete" for p in periods)
    if not complete:
        return {"date": date, "version": RULES["version"], "periods": periods, "status": "unknown",
                "recommendation": {"word": "数据不足", "suffix": "暂不评级"}}
    best = max(periods, key=lambda p: (p["score"], p["gold"]))
    ideal = [p for p in periods if p["score"] >= 80]
    fair = [p for p in periods if p["score"] >= 60]
    if ideal:
        recommendation = {"word": "全天" if len(ideal) == 2 else ideal[0]["name"], "suffix": "宜户外活动"}
    elif fair:
        recommendation = {"word": "全天" if len(fair) == 2 else fair[0]["name"], "suffix": "户外条件尚可"}
    else:
        recommendation = {"word": "全天", "suffix": "不宜户外活动"}
        labels = {"pm25": "雾霾（PM2.5 偏高）", "wind": "大风", "rain": "降雨", "cloud": "云量较多"}
        losses = {key: sum(p["deductions"][key] for p in periods) for key in labels}
        largest = max(losses.values())
        recommendation["causes"] = [label for key, label in labels.items() if losses[key] == largest]
    all_day = recommendation["word"] == "全天"
    score = sum(p["score"] for p in periods) / len(periods) if all_day else best["score"]
    gold = all(p["gold"] for p in periods) if all_day else best["gold"]
    grade = "excellent" if best["gold"] and not gold else best["grade"]
    return {"date": date, "version": RULES["version"], "status": "complete", "periods": periods,
            "bestPeriod": best["name"], "score": score, "displayScore": round(score, 1),
            "grade": grade, "character": best["character"], "gold": gold,
            "recommendation": recommendation}



if __name__ == "__main__":
    try:
        packet = json.loads(sys.stdin.buffer.readline(65537))
        print(json.dumps(outdoor_index.invoke(packet), ensure_ascii=False, allow_nan=False))
    except Exception:
        print(json.dumps({"error": "OUTDOOR_INDEX_UNAVAILABLE"}))
