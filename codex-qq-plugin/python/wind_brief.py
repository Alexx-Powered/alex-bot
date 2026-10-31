"""Bounded, deterministic LangChain tool for two calendar days of public wind samples."""
import json
import math
import sys
from collections import Counter
from langchain_core.tools import tool


@tool
def wind_brief(speeds: list[float | None], directions: list[float | None], gusts: list[float | None] | None = None) -> list[str]:
    """Summarize up to 48 ordered hourly 10m wind samples in m/s and degrees; no I/O."""
    if len(speeds) != len(directions) or not 1 <= len(speeds) <= 48:
        raise ValueError("INVALID_WIND_WINDOW")
    if gusts is not None and len(gusts) != len(speeds):
        raise ValueError("INVALID_GUST_WINDOW")
    def valid(value, maximum):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= maximum
    days = []
    names = ["北风", "东北风", "东风", "东南风", "南风", "西南风", "西风", "西北风"]
    # Beaufort thresholds for 10m sustained wind, not gusts.
    limits = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7]
    for start in (0, 24):
        rows = list(zip(speeds[start:start + 24], directions[start:start + 24]))
        values = [speed for speed, _ in rows if valid(speed, 150)]
        if not values:
            days.append("风速缺数据")
            continue
        sectors = Counter(int((direction + 22.5) // 45) % 8 for speed, direction in rows
                          if valid(speed, 150) and speed >= 0.3 and valid(direction, 360))
        leaders = sectors.most_common()
        direction = "静风" if max(values) < 0.3 else "风向缺数据"
        if leaders:
            direction = names[leaders[0][0]] if leaders[0][1] > sum(sectors.values()) / 3 and (len(leaders) < 2 or leaders[0][1] > leaders[1][1]) else "风向多变"
        level = sum(max(values) >= threshold for threshold in limits)
        minimum_level = sum(min(values) >= threshold for threshold in limits)
        gust_values = [value for value in (gusts or [])[start:start + 24] if valid(value, 150)]
        gust_text = f"阵风最大{sum(max(gust_values) >= threshold for threshold in limits)}级" if gust_values else "阵风缺数据"
        if gust_values and len(gust_values) < 24:
            gust_text += "（部分）"
        missing = 24 - len(values)
        days.append(f"{direction}  {minimum_level}–{level}级 · {gust_text}" + (f"（风速缺{missing}小时）" if missing else ""))
    return days


if __name__ == "__main__":
    try:
        packet = json.loads(sys.stdin.buffer.readline(65537))
        if not {"speeds", "directions"} <= set(packet) or set(packet) - {"speeds", "directions", "gusts"}:
            raise ValueError("INVALID_FIELDS")
        print(json.dumps(wind_brief.invoke(packet), ensure_ascii=False))
    except Exception:
        print(json.dumps(["风速暂不可用", "风速暂不可用"], ensure_ascii=False))
