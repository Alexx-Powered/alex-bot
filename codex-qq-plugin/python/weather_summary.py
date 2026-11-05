"""Map the provider's daily WMO forecast code to the supplied eight artwork families.

Daily weather_code represents the most severe condition in that calendar day.
Sources: https://open-meteo.com/en/docs#daily-parameter-definition
         https://open-meteo.com/en/docs/ecmwf-api
No model, network, file or recipient access. PM2.5 is not a fog diagnosis.
"""
from datetime import date as calendar_date
from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, StrictInt


class WeatherSummaryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: str
    code: StrictInt | None = None


CONDITIONS = {
    0: ("sunny", "晴"), 1: ("sunny", "晴"), 2: ("partly-cloudy", "晴间多云"),
    3: ("overcast", "阴"), 45: ("fog", "雾"), 48: ("fog", "雾凇"),
    51: ("light-rain", "毛毛雨"), 53: ("light-rain", "毛毛雨"), 55: ("light-rain", "密集毛毛雨"),
    56: ("light-rain", "冻毛毛雨"), 57: ("light-rain", "冻毛毛雨"),
    61: ("light-rain", "小雨"), 63: ("light-rain", "中雨"), 65: ("heavy-rain", "大雨"),
    66: ("light-rain", "冻雨"), 67: ("heavy-rain", "强冻雨"),
    71: ("snow", "小雪"), 73: ("snow", "中雪"), 75: ("snow", "大雪"), 77: ("snow", "米雪"),
    80: ("light-rain", "阵雨"), 81: ("light-rain", "中等阵雨"), 82: ("heavy-rain", "强阵雨"),
    85: ("snow", "阵雪"), 86: ("snow", "强阵雪"),
    95: ("thunderstorm", "雷阵雨"), 96: ("thunderstorm", "雷暴伴冰雹"),
    97: ("thunderstorm", "强雷暴"), 99: ("thunderstorm", "雷暴伴冰雹"),
}


@tool(args_schema=WeatherSummaryInput)
def weather_summary(date: str, code: int | None = None) -> dict:
    """Match one validated daily WMO code to a bounded illustration key and exact weather label."""
    if calendar_date.fromisoformat(date).isoformat() != date:
        raise ValueError("INVALID_SUMMARY_DATE")
    icon, label = CONDITIONS.get(code, (None, "天气类型缺数据"))
    return {"date": date, "code": code if icon else None, "icon": icon, "label": label}
