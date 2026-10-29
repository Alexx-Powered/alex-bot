"""Bounded cached-classroom recommendations. No network, credentials or model."""
import importlib
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal
from langchain.tools import tool
from pydantic import BaseModel, ConfigDict, Field
from campus_report import SCRIPTS, observations
from campus_classrooms import CampusError

TZ = timezone(timedelta(hours=8))
SCHEMA = 'buaa-recommendations.v1'


class RecommendationArgs(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    date: Annotated[str, Field(pattern=r'^(?:\d{4}-\d{2}-\d{2})?$')] = ''
    session: Literal['now', 'morning', 'afternoon', 'evening'] = 'now'
    limit: Annotated[int, Field(ge=1, le=12)] = 8
    exclude_room: Annotated[str, Field(pattern=r'^(?:[1-9]\d{2})?$')] = ''


def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timezone required')
    return result.astimezone(TZ)


def recommend(snapshot, args, now):
    args = RecommendationArgs.model_validate(args)
    current = timestamp(now)
    day = args.date or current.date().isoformat()
    result = dict(schema_version=SCHEMA, ok=False, code='CAMPUS_CACHE_EMPTY', date=day,
                  now=current.isoformat(), fetched_at='', session='', candidates=[],
                  message='没有这一天的教室缓存，请先发送“查空教室”并指定对应日期。')

    def fail(code, message):
        result.update(code=code, message=message)
        return result

    if day < current.date().isoformat():
        return fail('CAMPUS_DATE_PASSED', '这一天已经结束，请查询今天的教室数据。')
    if not snapshot or snapshot.get('date') != day or snapshot.get('ok') is not True:
        return result
    fetched = timestamp(snapshot['fetched_at'])
    result['fetched_at'] = fetched.isoformat()
    if current - fetched > timedelta(hours=24) or fetched - current > timedelta(minutes=5):
        return fail('CAMPUS_CACHE_EXPIRED', '教室缓存已过期，请先重新发送“查空教室”。')
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    plan = importlib.import_module('plan')
    try:
        observed = observations(snapshot)
    except CampusError:
        return fail('CAMPUS_NO_CANDIDATES', '缓存中没有三号楼教室记录，请重新查询；未编造推荐。')
    if not any(plan.normalize_room(row['room']) not in plan.EXCLUDED for row in observed['rows']):
        return fail('CAMPUS_NO_CANDIDATES', '缓存中只有已排除的三号楼教室，没有可推荐的教室。')
    rooms, _, _, _ = plan.load_observations(observed)

    def at(hhmm):
        return datetime.fromisoformat(day + 'T' + hhmm).replace(tzinfo=TZ)

    labels = {'morning': '上午', 'afternoon': '下午', 'evening': '晚上'}
    if args.session == 'now':
        label = next((label for label, (_, b) in plan.RULES['sessions'].items()
                      if at(plan.RULES['periods'][b-1][1]) > current), None)
        if label is None:
            return fail('CAMPUS_DAY_FINISHED', '按当前北京时间，今天第14节已经结束，没有剩余自习时段；请查询明天。')
    else:
        label = labels[args.session]
    result['session'] = label
    a, b = plan.RULES['sessions'][label]
    remaining = [p for p in range(a, b+1) if at(plan.RULES['periods'][p-1][1]) > current]
    if not remaining:
        return fail('CAMPUS_SESSION_FINISHED', f'按当前北京时间，今天{label}已经结束，请改问后续时段。')
    a = remaining[0]
    candidates = []
    for room, slots in rooms.items():
        if room == args.exclude_room:
            continue
        spans = plan.runs(p for p in range(a, b+1) if slots[p-1] == 'F')
        choices = []
        for start, end in spans:
            usual_evening = label == '晚上' and start == 12 and end == 14 and a <= 12
            complete = start == a and end == b
            kind = 'full' if complete else 'evening' if usual_evening else 'partial'
            item = dict(kind=kind, room=room, start=start, end=end, session=label)
            opening, closing = at(plan.RULES['periods'][start-1][0]), at(plan.RULES['periods'][end-1][1])
            usable_from = max(current, opening)
            available = opening <= current < closing
            tier = plan.recommendation_tier(item, rooms)
            candidate = dict(room=room, small=room in plan.SMALL, tier=tier,
                             start_period=start, end_period=end,
                             usable_from=usable_from.strftime('%H:%M'), usable_until=closing.strftime('%H:%M'),
                             available_now=available, complete_remaining=complete or usual_evening,
                             period5_busy=slots[4]=='B', full_afternoon=plan.full_free(slots,6,10))
            # A "change now" request first needs a room that is usable now.
            score = (not available if args.session=='now' else False, tier,
                     not candidate['complete_remaining'], room not in plan.SMALL,
                     -(closing-usable_from).total_seconds(), int(room))
            choices.append((score, candidate))
        if choices:
            candidates.append(min(choices, key=lambda pair: pair[0]))
    candidates.sort(key=lambda pair: pair[0])
    result['candidates'] = [candidate for _, candidate in candidates[:args.limit]]
    if not result['candidates']:
        return fail('CAMPUS_NO_CANDIDATES', f'缓存中没有{label}剩余时段内可推荐的三号楼教室；未使用排除教室或已结束时段凑数。')
    result.update(ok=True, code='OK', message='')
    result['message'] = format_report(result)
    return result


def format_report(report, explanation=''):
    if not report['ok']:
        return report['message']
    now, fetched = timestamp(report['now']), timestamp(report['fetched_at'])
    lines = [f"北京时间{now:%m-%d %H:%M}；依据{fetched:%m-%d %H:%M}采集的{report['date']}{report['session']}缓存，空闲不保证有座。"]
    for item in report['candidates']:
        room_type = '小' if item['small'] else '普通'
        status = '现在可用' if item['available_now'] else '稍后可用'
        partial = '' if item['complete_remaining'] else '，局部'
        lines.append(f"{item['room']}（{room_type}，{item['tier']}级）{item['usable_from']}—{item['usable_until']}，{status}{partial}")
    if explanation:
        lines.append(explanation)
    return '\n'.join(lines)


def verified_explanation(report, text):
    """Keep the deterministic list authoritative; reject invented rooms/times."""
    if not isinstance(text, str) or not text.strip():
        return ''
    text = text.strip()[:180]
    rooms = {item['room'] for item in report['candidates']}
    times = {item[key] for item in report['candidates'] for key in ('usable_from','usable_until')}
    if set(re.findall(r'(?<!\d)[1-9]\d{2}(?!\d)', text)) - rooms:
        return ''
    if set(re.findall(r'\b\d{1,2}:\d{2}\b', text)) - times:
        return ''
    if re.search(r'保证|已占座|已订|\d+\s*[级节]|实时抓取|已重新查询', text):
        return ''
    return text


def build_recommendation_tool(snapshot, now):
    @tool(args_schema=RecommendationArgs, return_direct=True)
    def cached_classroom_recommendations(date: str='', session: str='now', limit: int=8, exclude_room: str='') -> dict:
        """按服务器当前北京时间筛选缓存中的三号楼教室；只读数据，不联网，不读取凭据。"""
        return recommend(snapshot, dict(date=date, session=session, limit=limit, exclude_room=exclude_room), now)
    return cached_classroom_recommendations
