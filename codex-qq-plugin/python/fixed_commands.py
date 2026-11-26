"""Model-free compatibility for explicit commands. The online model does not call this parser."""
import re
import unicodedata
from datetime import timedelta

UNITS = {"古月币":"HU$", "hu$":"HU$", "人民币":"CNY", "元":"CNY", "cny":"CNY","rmb":"CNY","¥":"CNY",
         "马里":"马里","公里":"km","千米":"km","km":"km","米":"m","m":"m",
         "马时":"马时","小时":"h","h":"h","分钟":"min","分":"min","min":"min"}
DEFAULT_UNIT = {"HU$":"CNY","CNY":"HU$","km":"马里","m":"马里","马里":"km","h":"马时","min":"马时","马时":"h"}
UNIT = "|".join(map(re.escape,sorted(UNITS,key=len,reverse=True)))
AMOUNT = r"(\d{1,12}(?:\.\d{1,8})?|\.\d{1,8})"
JOIN = r"(?:等于|兑换成|换算成|是多少|换成|折合|转成|兑换|换算|多少|为|是|有|换|到|=|->|→)\s*(?:多少|几|成|为)?"
PROVIDERS = {"openai":"openai","deepseek":"deepseek","深度求索":"deepseek","ds":"deepseek","大肥鱼":"deepseek",
             "gemini":"gemini","anthropic":"claude","克劳德":"claude","claude":"claude","kimi":"kimi","月之暗面":"kimi"}
LAYERS = {"云图":"cloud_video","雾霾":"pm25_video","pm2.5":"pm25_video","pm25":"pm25_video",
          "降水":"precipitation_video","温度":"temperature_video"}
DATE = r"(?<!上)(?:这|本|下)?(?:周|星期)(?:[一二三四五六日]|天(?!气))|后天|明天|今天|\d{4}-\d{2}-\d{2}"
PLACE = r"[\w ·（）(),，.'’\-]{1,60}"


def conversion(text):
    m = re.fullmatch(rf"(?:换算|兑换|折合|转换)?\s*{AMOUNT}\s*({UNIT})(?:\s*(?:{JOIN}|\s+)\s*({UNIT}))?",text,re.I)
    if m:
        amount, source, target = m.groups()
    else:
        m = re.fullmatch(rf"(HU\$|CNY|RMB|¥)\s*{AMOUNT}(?:\s*{JOIN}\s*({UNIT}))?",text,re.I)
        if not m:
            return None
        source, amount, target = m.groups()
    source = UNITS[source.lower()]
    return "convert_units",dict(amount="0"+amount if amount.startswith(".") else amount,from_unit=source,
                                to_unit=UNITS[target.lower()] if target else DEFAULT_UNIT[source])


def parse(text, today, previous_city=None):
    if not isinstance(text,str) or not 1 <= len(text) <= 320:
        return None
    raw = text.strip()
    from rag_runtime import project_write_route
    project = project_write_route(raw)
    if project:
        return project
    text = unicodedata.normalize("NFKC",raw).rstrip("?。!~ ").strip()
    if found := conversion(text):
        return found
    if re.fullmatch(r"(?:查|查询)\s*(?:DeepSeek|深度求索)\s*(?:账户)?余额",text,re.I):
        return "deepseek_account_balance",{}
    status = re.sub(r"^(梁圣|梁祖|梁嗨|小难梁|大肥鱼)\s+","",text)
    if re.fullmatch(r"(?:/梁状态|(?:查询?|查询?一下)?\s*滑动变[阻祖]器\s*(?:实时)?状态)",status):
        return "liang_status",{}
    provider = "|".join(PROVIDERS)
    m = re.fullmatch(rf"(?:/?(?:查询?(?:一下)?|发)?\s*)({provider})\s*(?:服务|运行)?\s*(?:状态|status)",status,re.I)
    m = m or re.fullmatch(rf"/status\s+({provider})",status,re.I)
    if m:
        return "ai_service_status",{"provider":PROVIDERS[m[1].lower()]}
    health = (r"(?:DeepSeek|深度求索|DS|大肥鱼)\s*(?:现在|今天|目前)?\s*"
              r"(?:还\s*(?:活着|健在)(?:吗|么|没(?:有)?)|(?:还\s*)?(?:正常|能用)(?:吗|么|不)|"
              r"(?:是不是|是否|又)?\s*(?:挂了|崩了|炸了|死了)(?:吗|么|没(?:有)?)?|恢复了(?:吗|么|没(?:有)?))")
    if any(re.fullmatch(health, candidate, re.I) for candidate in (text,status)):
        return "deepseek_service_status",{}
    if m := re.fullmatch(r"(?:查空教室|三号楼简报)(?:\s+(\d{4}-\d{2}-\d{2}))?",text):
        return "buaa_classroom_query",{"date":m[1] or ""}
    if m := re.fullmatch(r"(?:发\s+|/)?徒步\s+([\w·-]{2,24})(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(不露营|住店|露营))?",text):
        return "hiking_trip_card",dict(destination=m[1],**({"start_date":m[2]} if m[2] else {}),
                                       overnight={None:"auto","不露营":"inn","住店":"inn","露营":"tent"}[m[3]])
    if m := re.fullmatch(rf"发\s*历史云图\s+({PLACE})",text):
        return "satellite_video",{"city":m[1].strip()}
    if m := re.fullmatch(r"(?:雷达目录|雷达站点|发\s*雷达\s*目录)\s*(.{0,40})",text):
        return "radar_catalog",{"query":m[1].strip()}
    if m := re.fullmatch(r"(?:发\s*)?全球雷达(?:图)?\s*(.{0,40})",text):
        return "radar_image",{"target":m[1].strip() or "全球","source":"global"}
    if m := re.fullmatch(r"发\s*雷达\s*(.{1,40})",text):
        return "radar_image",{"target":m[1].strip()}
    if re.search(r"上(?:周|星期)|昨天|前天",text):
        return None
    day = {}
    if m := re.search(DATE,text):
        token=m[0]
        if token in ("今天","明天"):
            day["day"]={"今天":"today","明天":"tomorrow"}[token]
        elif token[:1].isdigit():
            day["day"]=token
        else:
            delta=2 if token=="后天" else "一二三四五六日".index(token[-1].replace("天","日"))-today.weekday()+7*token.startswith("下")
            day["day"]=(today+timedelta(days=delta)).isoformat()
        text=(text[:m.start()]+text[m.end():]).strip()
        text=re.sub(r"^(发(?:一下)?)?\s*的",r"\1",text)
    text=re.sub(r"^发一下","发",text)
    text=re.sub(r"pm2\.?5\s*/\s*雾霾|雾霾\s*/\s*pm2\.?5","PM2.5",text,flags=re.I)
    m = re.fullmatch(r"(?:发\s*)?(?:(\d+)\s*(?:小时|h)\s*)?(?:动态|预报)\s*(云图|pm2\.?5|雾霾|降水|温度)\s*(.*)",text,re.I)
    m = m or re.fullmatch(r"发\s*()(云图|pm2\.?5|降水|温度)\s+(.+)",text,re.I)
    if m:
        first, layer, rest=m.groups()
        windows=re.findall(r"(\d+)\s*(?:小时|h)",rest,re.I)
        city=re.sub(r"(\d+)\s*(?:小时|h)","",rest,flags=re.I).strip() or previous_city
        windows={int(x) for x in ([first] if first else [])+windows}
        if len(windows)>1 or windows-{24,48}:
            return "clarify_or_ignore",{"reason":"unsupported_time"}
        if not city:
            return "clarify_or_ignore",{"reason":"missing_place"}
        return LAYERS[layer.lower()],dict(city=city,**day,**({"hours":48} if 48 in windows else {}))
    if m := re.fullmatch(r"发\s*(?:雾霾|CAMS|PM2\.?5|空气(?:质量)?)(?:\s*曲线)?\s*(.*)",text,re.I):
        return "air_quality_image",{"city":m[1].strip() or "北京"}
    m=re.fullmatch(rf"发\s*天气(?:预报图|预报|图)?\s*({PLACE}?)的?",text)
    m=m or re.fullmatch(rf"(?:请|看看|查一下)?\s*({PLACE}?)(?:的)?天气(?:预报图|预报|图)?"+(r"(?:咋样|怎么样|如何)?" if day else ""),text)
    if m:
        return "weather_image",dict(city=m[1].strip(),**day)
    return None
