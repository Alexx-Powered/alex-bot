"""A bounded projection of the campus timetable for conversational questions."""
import re
import unicodedata
from datetime import datetime, time
from typing import Annotated

from pydantic import Field, model_validator

from campus_classrooms import CampusQueryArgs
from campus_planner import EXCLUDED, NEAR, RULES, runs
from campus_regions import REGIONS, building_names, resolve_regions, room_address, room_region


Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r'^[\w（）()· .-]+$')]


class ClassroomDataArgs(CampusQueryArgs):
    rooms: Annotated[list[Identifier], Field(max_length=12, description='提到的教室标识，保留楼名或字母前缀；未指定可留空。')] = []
    building: Annotated[str, Field(max_length=64, description='明确指定的楼宇或分区；留空查询所有楼。')] = ''


ClockTime = Annotated[str, Field(pattern=r'^(?:[01]?\d|2[0-3]):[0-5]\d$')]


class ClassroomLookupArgs(ClassroomDataArgs):
    near_room: Identifier | None = Field(None, description='找附近的其他教室时填参照门牌，保留楼名前缀；参照教室无需有课表记录。')
    floor: Annotated[int, Field(ge=1, le=99, description='用户指定的地上楼层，按教室号筛选。')] | None = None
    start_time: ClockTime | None = Field(None, description='指定区间的北京时间起点，与 end_time 一起填写。')
    end_time: ClockTime | None = Field(None, description='同一天的截止时间，到点离开。')

    @model_validator(mode='after')
    def check_window(self):
        if (self.start_time is None) != (self.end_time is None):
            raise ValueError('起止时间需要同时提供。')
        if self.start_time is not None:
            self.start_time = self.start_time.zfill(5)
            self.end_time = self.end_time.zfill(5)
            if self.start_time >= self.end_time:
                raise ValueError('截止时间须晚于当天的开始时间。')
        return self


def _key(value):
    return re.sub(r'[\s-]+', '', unicodedata.normalize('NFKC', value)).casefold()


def _room_keys(row):
    name, building = _key(row['room']), _key(row['building'])
    region = room_region(row['building'], row['room'])
    keys = {name, building + name, _lookup_key(row['room'])}
    number = re.search(r'\d+$', name)
    if number:
        suffix = number.group()
        keys.add(suffix)
        if region:
            keys.add(_key(region) + suffix)
        if region == '主楼':
            keys.add('主' + suffix)
    return keys


def _lookup_key(value):
    address = room_address(value)
    if address:
        region, number, suffix = address
        return _key(region + str(number) + suffix)
    return _key(value)


def _physical_building(row):
    region = room_region(row['building'], row['room'])
    if region:
        return region
    # These source headings combine multiple buildings. Unclassified doors
    # cannot establish membership in any one of them.
    return None if row['building'] in ('主楼', '新主楼') else row['building']


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
    if args.get('near_room'):
        return _nearby_evidence(snapshot, args, now)
    return _project(snapshot, args, now)


def _nearby_evidence(snapshot, args, now):
    ref = args['near_room']
    address = room_address(ref)
    selected = resolve_regions(snapshot, args['building'])[0] if args.get('building') else []
    region, number, suffix = address or ('', 0, '')
    if not region and len(selected) == 1 and selected[0] in REGIONS:
        region = selected[0]
    info = {'reference': ref, 'building': region, 'floor': number // 100}
    empty = {'date': snapshot['date'], 'source': snapshot['source'], 'nearby': info, 'rows': []}
    if not address or not region:
        return {**empty, 'clarification': '请补充参照教室的楼名和门牌号。'}
    if (selected and region not in selected) or args.get('floor') not in (None, number // 100):
        return {**empty, 'clarification': '参照门牌和指定的楼栋或楼层不一致，请确认。'}

    info['names_for_same_building'] = building_names(region)
    info['reference_has_timetable_row'] = False
    neighbors = []
    for row in snapshot['rooms']:
        door = room_address(row['room'])
        if _physical_building(row) != region or not door or door[1] // 100 != number // 100:
            continue
        if door[1:] == (number, suffix):
            info['reference_has_timetable_row'] = True
            continue
        if region == '三号楼' and str(door[1]) in EXCLUDED:
            continue
        neighbors.append((door[1], row))

    if region == '主楼':
        neighbors.sort(key=lambda pair: (abs(pair[0] - number), pair[0]))
        info['order'] = '同层按门牌号差由小到大，号大在北、号小在南。门牌号差不代表两间房相邻或实际步行距离。'
    elif region == '三号楼':
        adjacent = {n for n, _ in neighbors if frozenset((str(n), str(number))) in NEAR}
        neighbors.sort(key=lambda pair: pair[0] not in adjacent)
        info['known_neighbors'] = [r['room'] for n, r in neighbors if n in adjacent]
        info['order'] = '已知相邻教室优先，其他仅能确认同楼同层。'
    else:
        info['order'] = '仅能确认同楼同层，该楼缺少可核实的方向和距离。'

    door_label = str(number) + suffix
    reference_keys = {_key(region + door_label), _key(door_label)}
    filters = {**args, 'building': region, 'floor': number // 100,
               'rooms': [r for r in args.get('rooms', []) if _lookup_key(r) not in reference_keys]}
    if not args.get('start_time') and snapshot['date'] == now.date().isoformat():
        periods = dict(enumerate(RULES['periods'], 1))
        position = _schedule_position(snapshot['date'], now, periods)
        period = position['current_period'] or position['next_period']
        if period is None:
            return {**empty, 'schedule_position': position, 'semantics': '今日课节已结束，开放情况须现场确认。'}
        filters.update(start_time=now.strftime('%H:%M'), end_time=periods[period][1])
        info['schedule_position'] = position
    data = _project({**snapshot, 'rooms': [r for _, r in neighbors]}, filters, now, keep_order=True)
    if 'window' in data:
        start, end = data['window']['start'], data['window']['end']
        data['verified_class_segments'] = [
            {'period': p, 'from': max(s, start), 'until': min(e, end)}
            for p, (s, e) in data.pop('periods').items()
        ]
    if region == '主楼':
        for row in data['rows']:
            n = room_address(row['room'])[1]
            if n != number:
                row['side'] = '北' if n > number else '南'
    info['scope'] = '参照门牌仅用于定位。rows 是已查实的同楼同层候选；参照教室自身是否被课表收录不影响这些结果。'
    return {**data, 'nearby': info}


def _project(snapshot, args, now, keep_order=False):
    rooms = args.get('rooms', [])
    building = args.get('building', '')
    regions = {_key(name) for name in resolve_regions(snapshot, building)[0]} if building else set()
    floor = args.get('floor')
    periods = {i: interval for i, interval in enumerate(RULES['periods'], 1)}
    start, end = args.get('start_time'), args.get('end_time')
    overlap = [p for p, (s, e) in periods.items() if s < end and start < e] if start else []
    scope_count = 0
    unknown_floor = 0
    named_conflicts = []
    filters = {name: _lookup_key(name) for name in rooms}
    matches = {name: [] for name in filters}
    records = []
    counts = {}
    for row in snapshot['rooms']:
        region = _physical_building(row)
        if regions and (not region or _key(region) not in regions):
            continue
        names = []
        if filters:
            keys = _room_keys(row)
            names = [name for name, key in filters.items() if key in keys]
            if not names:
                continue
        if floor is not None:
            number = re.search(r'(?<!\d)([1-9]\d{2,3})(?:[a-z])?$', _key(row['room']))
            if not number:
                unknown_floor += 1
                continue
            if int(number[1][:-2]) != floor:
                continue
        scope_count += 1
        if start:
            busy = [p for p in overlap if p not in row['free_periods']]
            if busy and names and len(named_conflicts) < 64:
                named_conflicts.append({'room': row['room'], 'building': row['building'], 'busy_in_window': busy})
            if busy or not overlap:
                continue
        for name in names:
            matches[name].append(len(records))
        records.append(row)
        if not start:
            by_period = counts.setdefault(region or '未分类', [0] * 14)
            for period in row['free_periods']:
                by_period[period - 1] += 1

    limit = 64
    if start:
        # Keep a window answer grounded in that window. A full-day schedule invites
        # unrelated claims about later classes or availability after the requested end.
        if building and not keep_order:
            records.sort(key=lambda r: r['room'])
        return {
            'campus': snapshot['campus'], 'source': snapshot['source'], 'date': snapshot['date'],
            'fetched_at': snapshot['fetched_at'], 'building_filter': building, 'floor': floor,
            'requested_rooms': rooms,
            'window': {'start': start, 'end': end, 'overlapping_periods': overlap,
                       'rooms_in_scope': scope_count, 'rooms_free_for_all_periods': len(records)},
            'periods': {p: periods[p] for p in overlap},
            'rows': [{'room': row['room'], 'building': _physical_building(row)} for row in records[:limit]],
            'omitted_rows': max(0, len(records) - limit), 'unclassified_floor_rows': unknown_floor,
            'named_room_conflicts': named_conflicts,
            'semantics': 'rows 中每间教室在查询区间相交的所有课节均无排课。截止时刻开始的课不冲突。无相交课节时无法凭课表推荐。仅核实本时段，不推断其后的排课。课前及课间能否入内或留用、门禁和座位以现场为准。',
        }
    position = _schedule_position(snapshot['date'], now, periods)
    anchor = position['current_period'] or position['next_period']
    rows = []
    for record in records[:limit]:
        row = {'building': _physical_building(record), 'room': record['room'], 'free_periods': record['free_periods']}
        if anchor is not None:
            row['nearest_free_block'] = _nearest_free_block(row['free_periods'], anchor, periods, now)
            booked = next((p for p in periods if p >= anchor and p not in row['free_periods']), None)
            row['first_booking'] = None
            if booked is not None:
                start = periods[booked][0]
                minutes = max(0, int((_today_at(now, start) - now).total_seconds() // 60))
                row['first_booking'] = {'period': booked, 'start': start, 'minutes_before_conflict': minutes}
        rows.append(row)
    evidence = {
        'campus': snapshot['campus'], 'source': snapshot['source'], 'date': snapshot['date'],
        'fetched_at': snapshot['fetched_at'], 'now': now.isoformat(), 'periods': periods,
        'current_period': position['current_period'], 'schedule_position': position,
        'semantics': 'free_periods 为无排课节次，其余节次有课。nearest_free_block 是从当前或下一节起最近的连续空闲课节，午休、晚饭处分段。end 是末节下课铃，remaining_minutes 是其中剩余分钟。first_booking.start 才是最早发生排课冲突的时间，minutes_before_conflict 为距冲突的整分钟数。课间可否留用取决于现场，数据源没有清场、门禁或座位信息。',
        'building_filter': args.get('building', ''),
        'available_buildings': list(dict.fromkeys(name for r in snapshot['rooms'] if (name := _physical_building(r)))),
        'matches': {name: {'count': len(ids), 'row_indices': [i for i in ids if i < limit]} for name, ids in matches.items()},
        'total_rows': len(records), 'omitted_rows': max(0, len(records) - limit), 'free_counts_per_period_by_region': counts,
        'rows': rows,
    }
    if floor is not None:
        evidence.update(floor=floor, unclassified_floor_rows=unknown_floor)
    return evidence
