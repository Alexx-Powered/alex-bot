"""Local, deterministic exercise-window rules; no model, network or QQ access."""
from datetime import date as Date, datetime, time, timedelta, timezone
from math import isfinite

VERSION = "morning-rules-v1"
TZ = timezone(timedelta(hours=8))
HALF_HOUR = timedelta(minutes=30)
HOUR = timedelta(hours=1)
WEATHER_CODES = {0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67,
                 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99}
THUNDER_CODES = {95, 96, 97, 99}
FREEZING_CODES = {48, 56, 57, 66, 67}
PRECIPITATION_CODES = {51, 53, 55, 61, 63, 65, 71, 73, 75, 77, 80, 81, 82, 85, 86}
FIELDS = {
    "temperatureC": (-90, 65, "温度"), "humidityPct": (0, 100, "湿度"),
    "precipitationMm": (0, 1000, "降水量"),
    "precipitationProbabilityPct": (0, 100, "降水概率"),
    "rainMm": (0, 1000, "雨量"), "snowfallCm": (0, 100, "降雪量"),
    "windSpeedMs": (0, 200, "风速"), "solarRadiationWm2": (0, 2000, "太阳辐照"),
}


def _timestamp(value):
    if not isinstance(value, str):
        raise ValueError("INVALID_TIME")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return (stamp.replace(tzinfo=TZ) if stamp.tzinfo is None else stamp.astimezone(TZ))


def _iso(stamp):
    return stamp.isoformat(timespec="seconds")


def _ceil_half_hour(stamp):
    floor = stamp.replace(minute=30 if stamp.minute >= 30 else 0, second=0, microsecond=0)
    return floor if floor == stamp else floor + HALF_HOUR


def _number(value, minimum, maximum):
    return value if type(value) in (int, float) and isfinite(value) and minimum <= value <= maximum else None


def _hour_map(rows, weather=False):
    if not isinstance(rows, list) or len(rows) > 240:
        return {}
    result = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            stamp = _timestamp(row.get("time"))
            if stamp.minute or stamp.second or stamp.microsecond:
                continue
            valid_period = not weather or row.get("periodEnd") is None or _timestamp(row["periodEnd"]) == stamp + HOUR
        except (ValueError, TypeError, OverflowError):
            continue
        # Duplicate or mismatched periods cannot supply a trustworthy hour.
        result[stamp] = row if stamp not in result and valid_period else None
    return result


def _unique(values):
    return list(dict.fromkeys(values))


def _assess(start, weather, air):
    hour = start.replace(minute=0, second=0, microsecond=0)
    row = weather.get(hour) or {}
    air_row = air.get(hour) or {}
    values = {field: _number(row.get(field), minimum, maximum)
              for field, (minimum, maximum, _) in FIELDS.items()}
    values["pm25"] = _number(air_row.get("pm25"), 0, 5000)
    code = row.get("weatherCode")
    values["weatherCode"] = code if type(code) in (int, float) and code in WEATHER_CODES else None
    missing = [field for field, value in values.items() if value is None]
    reasons, flags, penalty, limit = [], set(), 0, 100

    def risk(reason, flag, deduction=0, cap=100):
        nonlocal penalty, limit
        reasons.append(reason)
        flags.add(flag)
        penalty += deduction
        limit = min(limit, cap)

    temperature, humidity, pm = values["temperatureC"], values["humidityPct"], values["pm25"]
    wind, solar = values["windSpeedMs"], values["solarRadiationWm2"]
    precipitation, probability, snow = values["precipitationMm"], values["precipitationProbabilityPct"], values["snowfallCm"]
    if temperature is not None:
        if temperature <= 0 or temperature >= 35:
            risk("气温过低或过高。", "avoid", cap=15)
        elif temperature < 18 or temperature > 26:
            distance = 18 - temperature if temperature < 18 else temperature - 26
            risk("气温偏凉。" if temperature < 18 else "气温偏热。", "caution", deduction=8 + distance * 2)
    if humidity is not None and (humidity >= 80 or humidity < 30):
        risk("湿度较高。" if humidity >= 80 else "空气较干燥。", "caution", deduction=10)
    if temperature is not None and humidity is not None and temperature >= 28 and humidity >= 80:
        risk("高温高湿叠加，体感闷热。", "avoid", cap=10)
    if pm is not None:
        if pm >= 60:
            risk("PM2.5预报偏高，优先室内。", "avoid", cap=15)
            flags.add("particles")
        elif pm >= 35:
            risk("PM2.5预报升高，宜缩短户外活动。", "caution", deduction=20 + (pm - 35) * 0.8)
    if wind is not None:
        if wind >= 8:
            risk("风速较大。", "avoid", cap=15)
        elif wind >= 5:
            risk("风力偏强。", "caution", deduction=20 + (wind - 5) * 5)
    if solar is not None and solar >= 500:
        risk("太阳辐照较强，注意遮阴补水。", "caution", deduction=15 + min(10, (solar - 500) / 100))
        flags.add("sun")
    rain_values = [value for value in (precipitation, values["rainMm"]) if value is not None]
    if (rain_values and max(rain_values) >= 1) or (probability is not None and probability >= 70):
        risk("降水量或降水概率较高。", "avoid", cap=15)
    elif (rain_values and max(rain_values) > 0) or (probability is not None and probability >= 30):
        risk("存在降水信号，备好避雨方案。", "caution", deduction=20)
    if snow is not None and snow > 0:
        risk("有降雪预报，留意路面湿滑。", "avoid", cap=10)
    code = values["weatherCode"]
    if code in THUNDER_CODES:
        risk("有雷暴天气预报。", "avoid", cap=0)
    elif code in FREEZING_CODES:
        risk("有冻结降水或冻雾预报，路面可能湿滑。", "avoid", cap=0)
    elif code == 45:
        risk("有雾预报，留意能见度。", "caution", deduction=20)
    elif code in PRECIPITATION_CODES:
        risk("天气码提示降水。", "caution", deduction=15)
    if missing:
        labels = [FIELDS[field][2] if field in FIELDS else "PM2.5" if field == "pm25" else "天气码" for field in missing]
        reasons.append("缺少" + "、".join(labels[:3]) + ("等" if len(labels) > 3 else "") + "关键预报。")
    level = "avoid" if "avoid" in flags else "unknown" if missing else "caution" if "caution" in flags else "suitable"
    score = 0 if level == "unknown" else max(0, min(100, int(round(min(limit, 100 - penalty)))))
    if not reasons:
        reasons.append("温湿度及天气条件较适宜。")
    return {"start": start, "end": start + HALF_HOUR, "score": score, "level": level,
            "values": values, "reasons": reasons, "flags": flags, "missingFields": missing}


def _conditions(slots):
    def observed(field):
        return [slot["values"][field] for slot in slots if slot["values"][field] is not None]

    def extent(field):
        values = observed(field)
        return {"min": min(values) if values else None, "max": max(values) if values else None}

    def peak(field):
        values = observed(field)
        return max(values) if values else None

    return {"temperatureC": extent("temperatureC"), "humidityPct": extent("humidityPct"),
            "pm25Max": peak("pm25"), "precipitationProbabilityMax": peak("precipitationProbabilityPct"),
            "solarRadiationMax": peak("solarRadiationWm2"), "windSpeedMax": peak("windSpeedMs"),
            "precipitationMax": peak("precipitationMm"), "snowfallMax": peak("snowfallCm")}


def _summarize(slots, start, end):
    levels = {slot["level"] for slot in slots}
    level = next((level for level in ("avoid", "unknown", "caution", "suitable") if level in levels), "expired")
    flags = set().union(*(slot["flags"] for slot in slots)) if slots else set()
    if level == "expired":
        advice, reasons = "请查看之后的时段。", ["该时段已过，不参与推荐。"]
    elif "particles" in flags:
        advice, reasons = "颗粒物浓度预报偏高，改为室内运动。", _unique(reason for slot in slots for reason in slot["reasons"])
    elif level == "avoid":
        advice, reasons = "优先室内运动，等待天气条件改善。", _unique(reason for slot in slots for reason in slot["reasons"])
    elif level == "unknown":
        advice, reasons = "关键数据不足，暂不推荐户外时段。", _unique(reason for slot in slots for reason in slot["reasons"])
    elif "sun" in flags:
        advice, reasons = "选择遮阴处，适量补水，避开直晒。", _unique(reason for slot in slots for reason in slot["reasons"])
    elif level == "caution":
        advice, reasons = "宜短时低强度活动，留意天气变化。", _unique(reason for slot in slots for reason in slot["reasons"])
    else:
        advice, reasons = "可考虑户外散步或适度运动，量力而行。", ["温湿度及天气条件较适宜。"]
    if level != "suitable":
        reasons = [reason for reason in reasons if reason != "温湿度及天气条件较适宜。"]
    return {"start": _iso(start), "end": _iso(end), "score": min((slot["score"] for slot in slots), default=0),
            "level": level, "conditions": _conditions(slots), "reasons": reasons[:6], "advice": advice,
            "evaluatedHalfHours": len(slots), "missingFields": _unique(field for slot in slots for field in slot["missingFields"])}


def analyze_morning(packet):
    """Score only future half-hour windows, conservatively reusing hourly samples."""
    try:
        if not isinstance(packet, dict) or packet.get("city") not in {"beijing", "tianjin", "guangzhou"}:
            raise ValueError()
        now = _timestamp(packet["now"])
        day = Date.fromisoformat(packet["date"])
        if day.isoformat() != packet["date"]:
            raise ValueError()
        city_name = packet["cityName"]
        if not isinstance(city_name, str) or not city_name.strip() or len(city_name) > 80:
            raise ValueError()
    except (KeyError, ValueError, TypeError, OverflowError):
        raise ValueError("MORNING_PACKET_INVALID") from None
    calendar = packet.get("calendar") if isinstance(packet.get("calendar"), dict) else {}
    known_calendar = (calendar.get("known") is True and type(calendar.get("workday")) is bool and
                      type(calendar.get("holiday")) is bool and not (calendar["workday"] and calendar["holiday"]))
    normal_workday = calendar.get("workday") is True and calendar.get("holiday") is not True if known_calendar else day.weekday() < 5
    evening_only = day.weekday() in (0, 2) and normal_workday
    periods = [(time(20), time(22))] if evening_only else [(time(7), time(8, 30)), (time(16), time(19)), (time(20), time(22))]
    weather_packet = packet.get("weather") if isinstance(packet.get("weather"), dict) else {}
    air_packet = packet.get("air") if isinstance(packet.get("air"), dict) else {}
    weather = _hour_map(weather_packet.get("hourly"), weather=True)
    air_unit_valid = air_packet.get("unit", "μg/m³") in {"μg/m³", "µg/m³"}
    air = _hour_map(air_packet.get("hourly")) if air_unit_valid else {}
    notes = [
        "自定义天气适宜度评分（0–100），不是官方运动指数或医疗结论。",
        "北京时间 UTC+8；按小时模型保守评估半小时时段，不插值，也不代表半小时预报精度。",
        "PM2.5单位为μg/m³，仅表示颗粒物预报风险，不是综合AQI或霾的确诊。",
        "太阳辐照单位为W/m²，是区间平均辐照，不是UV指数；风速单位为m/s。",
        "18–26°C较理想；≤0或≥35°C、≥28°C且湿度≥80%、PM2.5≥60、风≥8m/s、降水≥1mm或概率≥70%、降雪>0均避开。",
        "PM2.5≥35且<60、辐照≥500W/m²、风≥5且<8m/s、温度偏离18–26°C、湿度<30%或≥80%、少量降水或概率≥30%需谨慎。",
        "雷暴码95/96/97/99、冻结降水56/57/66/67和冻雾48避开；普通雾45及其他降水天气码至少谨慎。",
        "缺关键数据不判适宜；按时段内最差半小时评分，不用平均分掩盖危险；自定义评分低于40不推荐。",
    ]
    if not known_calendar:
        notes.append("节假日信息未确认；周一、周三按普通工作日保守仅考虑20–22时。")
    if not air_unit_valid:
        notes.append("PM2.5单位不符，未使用该数据。")
    if known_calendar and calendar.get("holiday"):
        holiday_name = calendar.get("holidayName")
        label = holiday_name.strip()[:60] if isinstance(holiday_name, str) and holiday_name.strip() else "节假日"
        notes.append(f"日历：{label}，按休息日时段安排。")
    if isinstance(calendar.get("source"), str) and calendar["source"].strip():
        notes.append("日历来源：" + calendar["source"].strip()[:180])
    if evening_only:
        notes.append("普通工作日周一、周三仅考虑20–22时。")
    windows, candidates = [], []
    cutoff = _ceil_half_hour(now)
    for start_time, end_time in periods:
        original_start = datetime.combine(day, start_time, tzinfo=TZ)
        end = datetime.combine(day, end_time, tzinfo=TZ)
        start = max(original_start, cutoff)
        slots = []
        cursor = start
        while cursor + HALF_HOUR <= end:
            slots.append(_assess(cursor, weather, air))
            cursor += HALF_HOUR
        windows.append(_summarize(slots, start if slots else original_start, end))
        for index, slot in enumerate(slots):
            for length in (1, 2):
                chosen = slots[index:index + length]
                if len(chosen) == length and all(item["level"] in {"suitable", "caution"} and item["score"] >= 40 for item in chosen):
                    candidates.append(_summarize(chosen, chosen[0]["start"], chosen[-1]["end"]))
    recommendation = min(candidates, key=lambda item: (-item["score"], -item["evaluatedHalfHours"], item["start"])) if candidates else None
    if recommendation:
        start_text, end_text = recommendation["start"][11:16], recommendation["end"][11:16]
        summary = f"优先考虑{start_text}–{end_text}，自定义评分{recommendation['score']}/100。{recommendation['advice']}"
    elif all(window["level"] == "expired" for window in windows):
        summary = "今日候选时段均已过，不推荐过去的时间。"
    elif any(window["level"] == "avoid" for window in windows):
        summary = "剩余时段没有合适的连续半小时，优先室内运动。"
    elif any(window["level"] == "unknown" for window in windows):
        summary = "关键预报数据不足，暂不推荐户外时段。"
    else:
        summary = "剩余时段条件不佳，优先室内运动或等待改善。"
    return {"date": day.isoformat(), "city": packet["city"], "cityName": city_name.strip(),
            "title": f"{city_name.strip()}早安运动建议｜{day.isoformat()}", "summary": summary,
            "windows": windows, "recommendation": recommendation, "notes": notes,
            "version": VERSION, "timezone": "Asia/Shanghai"}
