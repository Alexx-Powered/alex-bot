"""Recognize complete, unambiguous weather requests without an LLM.

This only selects an existing LangChain tool. Location disambiguation, dates,
permissions and data retrieval remain with that tool and the Node boundary.
Unknown places, references, negation and compound requests use the normal agent.
"""
from functools import lru_cache
import json
from pathlib import Path
import re
import unicodedata
from weather_regions import REGION_ALIASES

DAY = r'今天|今日|今晚|明天|明日|明早|明晚'
KIND = r'天气(?:预报|简报|日报|图)?|全球(?:气象)?雷达(?:图)?|雷达(?:图)?|空气质量(?:图)?|PM2\.?5|雾霾(?:图)?'
PREFIX = r'(?:请\s*)?(?:帮我\s*)?(?:(?:查询一下|查询|查一下|查查|查|给我看看|给我看|看看|看一下|发一下|发|来一张)\s*)?'
TAIL = r'(?:怎么样|怎样|如何|情况)?(?:呢|吧)?'
PATTERNS = [
    re.compile(rf'^{PREFIX}(?P<day1>{DAY})?\s*(?P<place>.+?)(?:的)?\s*(?P<day2>{DAY})?\s*(?:的)?(?P<kind>{KIND})\s*{TAIL}$', re.I),
    re.compile(rf'^{PREFIX}(?P<day1>{DAY})?\s*(?P<kind>{KIND})\s*(?P<place>.+?)$', re.I),
]
VIDEO_KIND = r'(?P<dynamic>动态)?(?P<layer>卫星云图|云图|PM2\.?5|降水|温度|气温)(?:预报)?(?P<video>(?:变化)?(?:视频|动画|动图))?'
VIDEO_TIME = r'(?P<window>(?:未来|近|最近|过去)\s*(?:48|四十八|24|二十四|6|六)\s*(?:个)?小时|未来(?:两|2)天|(?:24|48)\s*(?:h|小时))?'
VIDEO_PREFIX = r'(?:请\s*)?(?:帮我|给我|我想|想)?\s*(?:看看|看一下|看|查询一下|查询|查一下|发一下|发|来一段)?\s*'
VIDEO_PATTERNS = (
    re.compile(rf'^{VIDEO_PREFIX}(?P<place>.+?)(?:的)?\s*{VIDEO_TIME}(?:的)?\s*{VIDEO_KIND}(?:吧)?$',re.I),
    re.compile(rf'^{VIDEO_PREFIX}{VIDEO_TIME}\s*{VIDEO_KIND}\s*(?P<place>.+?)(?:吧)?$',re.I),
    re.compile(rf'^{VIDEO_PREFIX}{VIDEO_KIND}\s*{VIDEO_TIME}\s*(?P<place>.+?)(?:吧)?$',re.I),
    re.compile(rf'^{VIDEO_PREFIX}(?P<place>.+?)(?:的)?\s*{VIDEO_KIND}\s*{VIDEO_TIME}(?:吧)?$',re.I),
)
VIDEO_TOOLS = {'卫星云图':'cloud_video','云图':'cloud_video','pm2.5':'pm25_video','pm25':'pm25_video',
               '降水':'precipitation_video','温度':'temperature_video','气温':'temperature_video'}


def _compact(value):
    return re.sub(r'[\s·,，]', '', unicodedata.normalize('NFKC', value)).lower().replace('’', "'")


@lru_cache(maxsize=1)
def _known_places():
    # Reuse the shipped catalogue; never download, guess or choose a duplicate.
    try:
        rows = json.loads((Path(__file__).resolve().parent.parent / 'data/weather-locations.json').read_text(encoding='utf-8'))['places']
        rows += json.loads((Path(__file__).resolve().parent.parent / 'data/outdoor-locations.json').read_text(encoding='utf-8'))['places']
        return frozenset(_compact(name) for row in rows for name in [row['name'], *row.get('aliases', [])])
    except (OSError, ValueError, KeyError, TypeError):
        return frozenset()


def quick_weather_route(text):
    if not isinstance(text, str) or len(text) > 100 or '\n' in text or '\r' in text:
        return None
    text = unicodedata.normalize('NFKC', text).strip().rstrip('?!。').strip()
    for pattern in VIDEO_PATTERNS:
        match=pattern.fullmatch(text)
        if not match:continue
        place=match['place'].strip()
        if re.sub(r'\s+','',place) not in REGION_ALIASES and _compact(place) not in _known_places():continue
        tool=VIDEO_TOOLS[match['layer'].lower()]
        if not (match['dynamic'] or match['video'] or tool=='cloud_video'):continue
        if match['window']:
            window=re.sub(r'\s+|个','',match['window']).lower()
            permitted=r'未来(?:(?:24|二十四|48|四十八)小时|(?:两|2)天)|(?:24|48)(?:h|小时)'
            if not re.fullmatch(permitted,window):continue
            if window in ('未来48小时','未来四十八小时','未来两天','未来2天','48h','48小时'):return tool,{'city':place,'hours':48}
        return tool,{'city':place}
    for pattern in PATTERNS:
        match = pattern.fullmatch(text)
        if not match:
            continue
        values = match.groupdict()
        place = values['place'].strip()
        if not 1 <= len(place) <= 40 or _compact(place) not in _known_places():
            continue
        days = [day for day in [values.get('day1'), values.get('day2')] if day]
        tomorrow = [day.startswith('明') for day in days]
        if len(set(tomorrow)) > 1:
            continue
        kind = values['kind']
        if kind.startswith('天气'):
            return 'weather_image', {'city': place, **({'day': 'tomorrow'} if any(tomorrow) else {})}
        # These tools have no future-day mode. Let the normal agent clarify it.
        if days:
            continue
        if '雷达' in kind:
            return 'radar_image', {'target': place, **({'source': 'global'} if kind.startswith('全球') else {})}
        return 'air_quality_image', {'city': place}
    return None
