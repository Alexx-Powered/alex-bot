"""A bounded projection of the campus timetable for conversational questions."""
import re
import unicodedata
from typing import Annotated

from pydantic import Field

from campus_classrooms import CampusQueryArgs
from campus_planner import RULES
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
    same_day = snapshot['date'] == now.date().isoformat()
    clock = now.strftime('%H:%M')
    current = next((i for i, (start, end) in periods.items() if start <= clock < end), None) if same_day else None
    return {
        'campus': snapshot['campus'], 'source': snapshot['source'], 'date': snapshot['date'],
        'fetched_at': snapshot['fetched_at'], 'now': now.isoformat(), 'periods': periods, 'current_period': current,
        'semantics': '仅为教务课表。记录内的空闲节次以外均为有课；课间、缺少记录或实际在场人数均无法据此判断。',
        'building_filter': args.get('building', ''), 'available_buildings': snapshot['buildings'],
        'matches': {name: {'count': len(ids), 'row_indices': [i for i in ids if i < limit]} for name, ids in matches.items()},
        'total_rows': len(records), 'omitted_rows': max(0, len(records) - limit), 'free_counts_per_period_by_region': counts,
        'rows': [{'building': row['building'], 'room': row['room'], 'free_periods': row['free_periods']} for row in records[:limit]],
    }
