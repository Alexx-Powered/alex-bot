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
from campus_regions import resolve_regions,room_region,REGIONS

TZ = timezone(timedelta(hours=8))
SCHEMA = 'buaa-recommendations.v1'


class RecommendationArgs(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    date: Annotated[str, Field(pattern=r'^(?:\d{4}-\d{2}-\d{2})?$')] = ''
    session: Literal['now', 'morning', 'afternoon', 'evening'] = 'now'
    limit: Annotated[int, Field(ge=1, le=12)] = 8
    exclude_room: Annotated[str, Field(max_length=64,pattern=r'^[\w（）()· .-]*$')] = ''
    building: Annotated[str, Field(min_length=1,max_length=64,pattern=r'^[\w（）()· .-]+$')] = '三号楼'
    regions: Annotated[list[Annotated[str,Field(min_length=1,max_length=32,pattern=r'^[\w（）()· .-]+$')]],Field(max_length=12)] = []


def timestamp(value):
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('Timezone required')
    return result.astimezone(TZ)


def recommend(snapshot, args, now, request_text=None):
    args = RecommendationArgs.model_validate(args)
    current = timestamp(now)
    day = args.date or current.date().isoformat()
    selected,building=resolve_regions(snapshot,args.building,args.regions,request_text)
    result = dict(schema_version=SCHEMA, ok=False, code='CAMPUS_CACHE_EMPTY', date=day,building=building,
                  regions=selected,missing_regions=[],
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
    unknown=[r for r in selected if r not in REGIONS]
    if unknown:return fail('CAMPUS_BUILDING_NOT_FOUND','不支持的区域：'+'、'.join(unknown)+'。请选择学院路已定义区域。')
    present={room_region(row['building'],row['room']) for row in snapshot['rooms']}
    result['missing_regions']=[r for r in selected if r not in present]
    rooms={};identities={}
    for row in snapshot['rooms']:
        region=room_region(row['building'],row['room'])
        if region not in selected:continue
        room=row['room']
        if row['building']=='三号楼':
            room=plan.normalize_room(room)
            if room in plan.EXCLUDED:continue
        key=room if row['building']=='三号楼' else row['building']+'\0'+room
        rooms[key]=''.join('F' if p in row['free_periods'] else 'B' for p in range(1,15))
        identities[key]=(row['building'],room,region)
    if not rooms:return fail('CAMPUS_NO_CANDIDATES','所选区域没有可推荐的教室记录：'+'、'.join(selected))

    def at(hhmm):
        return datetime.fromisoformat(day + 'T' + hhmm).replace(tzinfo=TZ)

    labels = {'morning': '上午', 'afternoon': '下午', 'evening': '晚上'}
    if args.session == 'now':
        label = next((label for label, (_, b) in plan.RULES['sessions'].items()
                      if at(plan.RULES['periods'][b-1][1]) > current), None)
        if label is None:
            return fail('CAMPUS_DAY_FINISHED', '按当前北京时间，今天第14节已经结束，没有剩余自习时段；请查询明天。')
        labels_in_order=list(plan.RULES['sessions'])
        index=labels_in_order.index(label)
        session_end=at(plan.RULES['periods'][plan.RULES['sessions'][label][1]-1][1])
        if index+1<len(labels_in_order) and timedelta(0)<session_end-current<=timedelta(minutes=10):
            label=labels_in_order[index+1]
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
        room_building,display_room,region=identities[room]
        small=room_building=='三号楼' and room in plan.SMALL
        if display_room == args.exclude_room:
            continue
        spans = plan.runs(p for p in range(a, b+1) if slots[p-1] == 'F')
        choices = []
        for start, end in spans:
            usual_evening = label == '晚上' and start == 12 and end == 14 and a <= 12
            complete = start == a and end == b
            kind = 'full' if complete else 'evening' if usual_evening else 'partial'
            item = dict(kind=kind, room=room, start=start, end=end, session=label)
            opening, closing = at(plan.RULES['periods'][start-1][0]), at(plan.RULES['periods'][end-1][1])
            if args.session=='now':
                free_start=start
                while free_start>1 and slots[free_start-2]=='F':
                    free_start-=1
                opening=at(plan.RULES['periods'][free_start-1][0])
            previous_end = at(plan.RULES['periods'][start-2][1]) if start>1 else None
            # A scheduled lesson has ended: the break itself is usable when
            # the next lesson is free. Do not wait for its scheduled start.
            if previous_end is not None and previous_end <= current < opening:
                opening = previous_end
            release_pending = (args.session=='now' and previous_end is not None and slots[start-2]=='B'
                               and current < previous_end <= current+timedelta(minutes=10))
            if release_pending:
                opening = previous_end
            usable_from = max(current, opening)
            available = opening <= current < closing
            just_released = (args.session=='now' and available and previous_end is not None
                             and slots[start-2]=='B' and previous_end<=current)
            if release_pending and start == a+1 and end == b:
                complete = True
                kind = 'full'
            preferred = just_released or release_pending
            if kind == 'partial':
                tier = 5 if label == '下午' else 4
            elif label == '下午':
                # Before 14:00 use period 5; afterwards use the current release.
                afternoon_started = current >= at(plan.RULES['periods'][5][0])
                promoted = preferred if afternoon_started and args.session == 'now' else (
                    slots[4] == 'B' and plan.full_free(slots, 6, 10) if not afternoon_started else False)
                tier = (1 if promoted else 2) if small else 3
            else:
                tier = 1 if small else 2
            candidate = dict(room=display_room,building=room_building,region=region, small=small, tier=tier,
                             start_period=start, end_period=end,
                             usable_from=usable_from.strftime('%H:%M'), usable_until=closing.strftime('%H:%M'),
                             available_now=available, complete_remaining=complete or usual_evening,
                             period5_busy=slots[4]=='B', full_afternoon=plan.full_free(slots,6,10),just_released=just_released,release_pending=release_pending)
            release_rank = 0 if just_released else 1 if release_pending else 2
            score = (tier, release_rank,
                     label == '下午' and current < at(plan.RULES['periods'][5][0]) and slots[4] != 'B',
                     not available if args.session == 'now' else False,
                     -(closing-usable_from).total_seconds(),
                     (usable_from-current).total_seconds(), room_building, display_room)
            choices.append((score, candidate))
        if choices:
            candidates.append(min(choices, key=lambda pair: pair[0]))
    candidates.sort(key=lambda pair: pair[0])
    result['candidates'] = [candidate for _, candidate in candidates[:args.limit]]
    if not result['candidates']:
        return fail('CAMPUS_NO_CANDIDATES', f'缓存中没有{label}剩余时段内可推荐的{building}教室；未使用排除教室或已结束时段凑数。')
    result.update(ok=True, code='OK', message='')
    result['message'] = format_report(result)
    return result


def format_report(report, explanation=''):
    if not report['ok']:
        return report['message']
    now, fetched = timestamp(report['now']), timestamp(report['fetched_at'])
    lines = [f"北京时间{now:%m-%d %H:%M}；依据{fetched:%m-%d %H:%M}采集的{report['date']}{report['session']}缓存，空闲不保证有座。"]
    if report.get('regions'):lines.append('查询区域：'+'、'.join(report['regions']))
    if report.get('missing_regions'):lines.append('接口暂无教室数据：'+'、'.join(report['missing_regions']))
    for item in report['candidates']:
        room_type = ('小' if item['small'] else '普通') if item.get('building','三号楼')=='三号楼' else '容量未提供'
        status = '现在可用' if item['available_now'] else '稍后可用'
        partial = ('' if item['complete_remaining'] else '，局部') + ('，刚下课优先' if item.get('just_released') else '')
        if item.get('release_pending'):
            partial += '，即将下课优先，须等下课'
        lines.append(f"{item.get('region',item.get('building','三号楼'))} {item['room']}（{room_type}，{item['tier']}级）{item['usable_from']}—{item['usable_until']}，{status}{partial}")
    if explanation:
        lines.append(explanation)
    return '\n'.join(lines)


def verified_explanation(report, text):
    """Keep the deterministic list authoritative; reject invented rooms/times."""
    if not isinstance(text, str) or not text.strip():
        return ''
    text = text.strip()[:180]
    rooms = {token for item in report['candidates'] for token in re.findall(r'(?<!\d)[1-9]\d{2}(?!\d)',item['room'])}
    times = {item[key] for item in report['candidates'] for key in ('usable_from','usable_until')}
    if set(re.findall(r'(?<!\d)[1-9]\d{2}(?!\d)', text)) - rooms:
        return ''
    if set(re.findall(r'\b\d{1,2}:\d{2}\b', text)) - times:
        return ''
    if re.search(r'保证|已占座|已订|\d+\s*[级节]|实时抓取|已重新查询', text):
        return ''
    return text


def build_recommendation_tool(snapshot, now, request_text=None):
    @tool(args_schema=RecommendationArgs, return_direct=True)
    def cached_classroom_recommendations(date: str='', session: str='now', limit: int=8, exclude_room: str='', building: str='三号楼',regions: list[str]=[]) -> dict:
        """按服务器当前北京时间筛选缓存中的三号楼教室；只读数据，不联网，不读取凭据。"""
        return recommend(snapshot, dict(date=date, session=session, limit=limit, exclude_room=exclude_room,building=building,regions=regions), now,request_text)
    return cached_classroom_recommendations
