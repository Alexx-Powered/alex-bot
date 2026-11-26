"""A bounded projection of the campus timetable for conversational questions."""
import re
import unicodedata
from datetime import datetime, time
from typing import Annotated

from pydantic import Field

from campus_classrooms import CampusQueryArgs
from campus_planner import RULES, runs
from campus_regions import room_region


Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r'^[\w（）()· .-]+$')]


class ClassroomDataArgs(CampusQueryArgs):
    rooms: Annotated[list[Identifier], Field(max_length=12, description='提到的教室标识，保留楼名或字母前缀；未指定可留空。')] = []
    building: Annotated[str, Field(max_length=64, description='明确指定的楼宇或分区；留空查询所有楼。')] = ''


def _key(value):
    return re.sub(r'[\s-]+', '', unicodedata.normalize('NFKC', value)).casefold()


def _room_keys(row):
    name, building = _key(row['room']), _key(row['building'])
    region = room_region(row['building'], row['room'])
    keys = {name, building + name}
    number = re.search(r'\d+$', name)
    if number:
        suffix = number.group()
        keys.add(suffix)
        if region:
            keys.add(_key(region) + suffix)
        if region == '主楼':
            keys.add('主' + suffix)
    return keys


def _schedule_position(day, now, periods):
    if day != now.date().isoformat():
        return {'phase': 'other_date', 'current_period': None, 'next_period': None}
    clock = now.strftime('%H:%M')
    current = next((i for i, (start, end) in periods.items() if start <= clock < end), None)
    following = next((i for i, (start, _) in periods.items() if clock < start), None)
    if current is not None:
        phase = 'in_class'
    elif following is None:
        phase = 'after_last'
    elif following == 1:
        phase = 'before_first'
    else:
        phase = 'break'
    position = {'phase': phase, 'current_period': current, 'next_period': following}
    if following is not None:
        hour, minute = map(int, periods[following][0].split(':'))
        position['minutes_to_next_start'] = (hour - now.hour) * 60 + minute - now.minute
    return position


def _today_at(now, hhmm):
    return datetime.combine(now.date(), time.fromisoformat(hhmm), tzinfo=now.tzinfo)


def _nearest_free_block(free, anchor, periods, now):
    # The campus timetable has separate morning, afternoon and evening sessions.
    # Adjacent period numbers across lunch or dinner do not establish continuous use.
    for first, last in RULES['sessions'].values():
        blocks = runs(p for p in free if max(first, anchor) <= p <= last)
        if blocks:
            start, end = blocks[0]
            opens, closes = _today_at(now, periods[start][0]), _today_at(now, periods[end][1])
            minutes = int((closes - max(now, opens)).total_seconds() // 60)
            return {'first_period': start, 'last_period': end, 'start': periods[start][0],
                    'end': periods[end][1], 'remaining_minutes': minutes}
    return None


def classroom_evidence(snapshot, args, now):
    rooms = args.get('rooms', [])
    building = _key(args.get('building', ''))
    filters = {name: _key(name) for name in rooms}
    matches = {name: [] for name in filters}
    records = []
    counts = {}
    for row in snapshot['rooms']:
        region = room_region(row['building'], row['room']) or row['building']
        if building and building not in {_key(row['building']), _key(region)}:
            continue
        if filters:
            keys = _room_keys(row)
            names = [name for name, key in filters.items() if key in keys]
            if not names:
                continue
            for name in names:
                matches[name].append(len(records))
        records.append(row)
        by_period = counts.setdefault(region, [0] * 14)
        for period in row['free_periods']:
            by_period[period - 1] += 1

    limit = 64
    periods = {i: interval for i, interval in enumerate(RULES['periods'], 1)}
    position = _schedule_position(snapshot['date'], now, periods)
    anchor = position['current_period'] or position['next_period']
    rows = []
    for record in records[:limit]:
        row = {key: record[key] for key in ('building', 'room', 'free_periods')}
        if anchor is not None:
            row['nearest_free_block'] = _nearest_free_block(row['free_periods'], anchor, periods, now)
            booked = next((p for p in periods if p >= anchor and p not in row['free_periods']), None)
            row['first_booking'] = None
            if booked is not None:
                start = periods[booked][0]
                minutes = max(0, int((_today_at(now, start) - now).total_seconds() // 60))
                row['first_booking'] = {'period': booked, 'start': start, 'minutes_before_conflict': minutes}
        rows.append(row)
    return {
        'campus': snapshot['campus'], 'source': snapshot['source'], 'date': snapshot['date'],
        'fetched_at': snapshot['fetched_at'], 'now': now.isoformat(), 'periods': periods,
        'current_period': position['current_period'], 'schedule_position': position,
        'semantics': 'free_periods 为无排课节次，其余节次有课。nearest_free_block 是从当前或下一节起最近的连续空闲课节，午休、晚饭处分段。end 是末节下课铃，remaining_minutes 是其中剩余分钟。first_booking.start 才是最早发生排课冲突的时间，minutes_before_conflict 为距冲突的整分钟数。课间可否留用取决于现场，数据源没有清场、门禁或座位信息。',
        'building_filter': args.get('building', ''), 'available_buildings': snapshot['buildings'],
        'matches': {name: {'count': len(ids), 'row_indices': [i for i in ids if i < limit]} for name, ids in matches.items()},
        'total_rows': len(records), 'omitted_rows': max(0, len(records) - limit), 'free_counts_per_period_by_region': counts,
        'rows': rows,
    }
