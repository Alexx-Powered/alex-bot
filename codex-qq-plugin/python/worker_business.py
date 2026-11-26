"""Bindings for host-authorized LangChain tools that return completed QQ replies."""
from datetime import datetime, timezone

from group_features import TOOL_FEATURES


def execute(name, args, packet, performance, grant):
    feature = TOOL_FEATURES[name]
    if name == "weather_image":
        from static_weather_card import static_weather_card
        now = datetime.fromisoformat(packet["now"].replace("Z","+00:00")) if packet.get("now") else datetime.now(timezone.utc)
        return static_weather_card(args["city"], args.get("day","today"), packet["id"], now, performance)
    if feature == "status":
        from worker_status import status_reply
        return status_reply(name, args, packet["id"])
    if feature == "campus":
        from worker_campus import execute as run
    elif feature == "radar":
        from worker_radar import execute as run
    elif feature in {"weather","air"}:
        from worker_dynamic_weather import execute as run
    else:
        raise ValueError("UNKNOWN_TOOL")
    return run(name,args,packet,performance,grant)


def error_reply(name, error):
    reason = str(error)
    if reason in {"LOCATION_INPUT_INVALID","LOCATION_NOT_FOUND"}:
        return "未找到该地点，请补充省市或地名全称。"
    if reason == "LOCATION_SOURCE_UNAVAILABLE":
        return "地点查询暂不可用，请稍后查询。"
    return {"weather":"天气预报或绘图服务暂不可用，请稍后查询。","air":"空气质量预报暂不可用，请稍后查询。",
            "status":"状态查询暂不可用，请稍后查询。","radar":"雷达查询暂不可用，请稍后查询。",
            "campus":"教室查询暂不可用，请稍后查询。"}[TOOL_FEATURES[name]]
