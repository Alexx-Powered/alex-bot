#!/usr/bin/env python3
"""Validate per-period observations and produce a Building 3 study plan. Stdlib only."""
import argparse
import itertools
import json
import re
from datetime import date as date_type
from pathlib import Path

RULES = json.loads((Path(__file__).resolve().parents[1] / 'references' / 'rules.json').read_text(encoding='utf-8'))
SMALL = set(RULES['small_rooms'])
EXCLUDED = set(RULES['excluded_rooms'])
KNOWN = set(RULES['known_rooms'])
MIN_RECOMMENDATIONS = 5
NEAR = {frozenset(p) for p in RULES['near_pairs']}
for group in RULES['near_groups']:
    NEAR.update(frozenset(p) for p in itertools.combinations(group, 2))


def task_title(query_date):
    if not query_date:
        return None
    day = date_type.fromisoformat(query_date)
    weekday = '一二三四五六日'[day.weekday()]
    return f'{day.month}月{day.day}日星期{weekday}三号楼自习教室'


def normalize_room(raw):
    match = re.fullmatch(r'(?:(?:\(三\)|（三）|三号楼)\s*)?(\d{3})', str(raw).strip())
    if not match:
        raise ValueError(f'无法确认三号楼教室号：{raw!r}，不要混入主楼等其他楼宇。')
    return match[1]


def load_observations(data):
    if data.get('building') != '三号楼':
        raise ValueError('building 必须是三号楼；其他楼宇须先从截图中分离。')
    date = data.get('date')
    if date is not None:
        date_type.fromisoformat(date)
    rows = data.get('rows')
    if not isinstance(rows, list) or not rows:
        raise ValueError('rows 必须含至少一行截图数据。')
    seen = {}
    sources = {}
    dropped = set()
    for row in rows:
        room = normalize_room(row['room'])
        # User guarantees every image in this request belongs to one day.
        # The batch date is authoritative; per-row OCR metadata cannot split it.
        if row.get('building', '三号楼') != '三号楼':
            raise ValueError('混入其他楼宇的行。')
        slots = row['slots']
        if not isinstance(slots, str) or len(slots) != 14 or set(slots) - set('FB?'):
            raise ValueError(f'{room} 的 slots 必须是 14 位 F/B/? 字符串。')
        if room in EXCLUDED:
            dropped.add(room)
            continue
        seen.setdefault(room, [set() for _ in range(14)])
        sources.setdefault(room, set()).add(str(row.get('source', '未标注截图来源')))
        for i, value in enumerate(slots):
            if value != '?':
                seen[room][i].add(value)
    if not seen:
        raise ValueError('截图中没有可纳入规划的教室。')
    conflicts = []
    rooms = {}
    for room, cells in seen.items():
        values = []
        for i, cell in enumerate(cells, 1):
            if len(cell) > 1:
                conflicts.append({'room': room, 'period': i, 'sources': sorted(sources[room])})
            values.append(next(iter(cell)) if len(cell) == 1 else '?')
        rooms[room] = ''.join(values)
    missing = sorted(SMALL - set(rooms), key=int)
    return rooms, conflicts, missing, sorted(dropped, key=int)


def runs(periods):
    result = []
    for p in sorted(set(periods)):
        if result and p == result[-1][1] + 1:
            result[-1][1] = p
        else:
            result.append([p, p])
    return result


def period_text(periods):
    return '、'.join(f'第{a}节' if a == b else f'第{a}—{b}节' for a, b in runs(periods))


def window_text(a, b):
    start = RULES['periods'][a-1][0]
    end = RULES['periods'][b-1][1]
    return f'{period_text(range(a, b+1))}（{start}—{end}）'


def availability(slots, a, b):
    free = [p for p in range(a, b+1) if slots[p-1] == 'F']
    unknown = [p for p in range(a, b+1) if slots[p-1] == '?']
    if len(free) == b-a+1:
        return '全空闲'
    if not free and not unknown:
        return '无'
    if len(unknown) == b-a+1:
        return '待确认'
    text = period_text(free) if free else '无已确认空闲'
    if unknown:
        text += '；' + period_text(unknown) + '待确认'
    return text


def full_free(slots, a, b):
    return all(slots[p-1] == 'F' for p in range(a, b+1))


def distance(a, b):
    if a == b:
        return 0
    if a not in KNOWN or b not in KNOWN:
        return 4  # Unknown topology is not an inferred adjacency.
    if a[0] != b[0]:
        return 3
    return 1 if frozenset((a, b)) in NEAR else 2


DISTANCE_LABEL = {0: '原教室', 1: '相邻/同一区域', 2: '同层较远', 3: '跨楼层', 4: '位置待确认'}


def preference(room, slots, session):
    a, b = RULES['sessions'][session]
    item = {'kind': 'full', 'room': room, 'start': a, 'end': b, 'session': session}
    return (recommendation_tier(item, {room: slots}), room not in SMALL, session == '下午' and slots[4] != 'B', int(room))


def recommendation_tier(item, rooms):
    """Preference tiers, not a probability of finding an actual seat."""
    session = item.get('session') or next(label for label, (a, b) in RULES['sessions'].items() if a <= item['start'] <= b)
    afternoon = session == '下午'
    if item['kind'] == 'route':
        return 4 if afternoon else 3
    if item['kind'] == 'partial':
        return 5 if afternoon else 4
    slots = rooms[item['room']]
    if afternoon and item['room'] in SMALL and slots[4] == 'B' and full_free(slots, 6, 10):
        return 1
    return (1 if item['room'] in SMALL else 2) + int(afternoon)


def compress_path(path, start):
    segments = []
    for p, room in enumerate(path, start):
        if segments and room == segments[-1]['room']:
            segments[-1]['end'] = p
        else:
            segments.append({'room': room, 'start': p, 'end': p})
    transfers = []
    for before, after in zip(segments, segments[1:]):
        p = before['end']
        transfers.append({
            'from': before['room'], 'to': after['room'],
            'after_period': p, 'before_period': p+1,
            'leave_after': RULES['periods'][p-1][1],
            'arrive_by': RULES['periods'][p][0],
            'distance': DISTANCE_LABEL[distance(before['room'], after['room'])]
        })
    return segments, transfers


def path_signature(path):
    return tuple(room for i, room in enumerate(path) if i == 0 or room != path[i-1])


def find_routes(rooms, a, b, limit=MIN_RECOMMENDATIONS):
    candidates = {p: sorted((r for r, s in rooms.items() if s[p-1] == 'F'), key=int)
                  for p in range(a, b+1)}
    gaps = [p for p, values in candidates.items() if not values]
    if gaps:
        return [], gaps
    # Additive cost: moves, uncertain-location moves, floor changes, non-near moves,
    # distance classes, periods spent in non-small rooms. Keep K distinct room
    # sequences per end room; different switch times are not extra alternatives.
    states = {r: [((0, 0, 0, 0, 0, int(r not in SMALL)), (r,))] for r in candidates[a]}
    for p in range(a+1, b+1):
        updated = {}
        for room in candidates[p]:
            options = {}
            for previous, paths in states.items():
                d = distance(previous, room)
                delta = (int(d > 0), int(d == 4), int(d == 3), int(d >= 2), d, int(room not in SMALL))
                for cost, path in paths:
                    if d > 0 and room in path:
                        last_period = a + max(i for i, value in enumerate(path) if value == room)
                        if full_free(rooms[room], last_period, p):
                            continue  # An avoidable out-and-back move is not a useful option.
                    candidate = (tuple(x+y for x, y in zip(cost, delta)), path+(room,))
                    signature = path_signature(candidate[1])
                    if signature not in options or candidate < options[signature]:
                        options[signature] = candidate
            updated[room] = sorted(options.values())[:limit]
        states = updated
    best = sorted(item for paths in states.values() for item in paths)[:limit]
    routes = []
    for cost, path in best:
        segments, transfers = compress_path(path, a)
        routes.append({'segments': segments, 'transfers': transfers, 'moves': cost[0], 'cost': list(cost)})
    return routes, []


def recommendation_reason(item, label):
    kind = item['kind']
    reasons = []
    if kind == 'full':
        reasons.append(f"第{item['start']}—{item['end']}节整段空闲，无需换教室")
        if label == '下午':
            reasons.append({'B': '第5节有课，可在下课后进入；建议12:15下课后尽早去占座',
                            'F': '第5节也空闲，属于下午整段可用的备选',
                            '?': '第5节未识别清楚，按下午整段可用备选处理'}[item['period5']])
        elif label == '晚上':
            reasons.append('覆盖19:00开始的完整晚上，也覆盖你常用的第12—14节')
    elif kind == 'evening':
        reasons.append('第12—14节连续空闲，覆盖你通常19:50—22:15的自习习惯，无需换教室')
        reasons.append('第11节有课，等19:45下课后再进入' if item['period11'] == 'B' else '第11节未识别清楚，从19:50开始使用')
    elif kind == 'route':
        reasons.append(f"各段均为空闲且衔接无空档，连续覆盖第{item['start']}—{item['end']}节，只需换{item['moves']}次教室")
        distances = [distance(t['from'], t['to']) for t in item['transfers']]
        if all(d == 1 for d in distances):
            reasons.append('换房均在同层相邻教室之间，符合优先就近换房的偏好')
        elif any(d == 4 for d in distances):
            reasons.append('部分位置关系待确认，实际步行路线需核对')
        elif any(d == 3 for d in distances):
            reasons.append('可补足整段单间方案的数量，但需跨楼层换房')
        else:
            reasons.append('换房均在同层，其中有较远教室，排在相邻路线之后')
        small_periods = sum(s['end']-s['start']+1 for s in item['segments'] if s['room'] in SMALL)
        if small_periods:
            reasons.append(f'其中{small_periods}节在你偏好的小教室')
    else:
        reasons.append('这是该教室在目标时段内最长的连续空闲区间，供完整方案不足时短时自习')
        reasons.append('不能覆盖整个目标时段，不能当作整段方案')
    if kind != 'route':
        reasons.append('属于你优先选择的小教室' if item['room'] in SMALL else '普通教室，作为同档小教室之后的备选')
    return '；'.join(reasons) + '。'


def analyze(data):
    rooms, conflicts, missing, dropped = load_observations(data)
    sessions = {}
    for label, (a, b) in RULES['sessions'].items():
        full = sorted((r for r, s in rooms.items() if full_free(s, a, b)),
                      key=lambda r: preference(r, rooms[r], label))
        ranked = []
        for room in full:
            info = {'room': room, 'small': room in SMALL, 'start': a, 'end': b}
            if label == '下午':
                info['period5'] = rooms[room][4]
                info['arrive_early'] = rooms[room][4] == 'B'
            if label == '晚上':
                info['period10'] = rooms[room][9]
            ranked.append(info)
        alternatives = []
        if label == '晚上':
            for room in sorted(rooms, key=lambda r: (r not in SMALL, int(r))):
                if full_free(rooms[room], 12, 14) and room not in full:
                    alternatives.append({'room': room, 'small': room in SMALL, 'start': 12, 'end': 14,
                                         'period11': rooms[room][10]})
        gaps = [n for n in range(a, b+1) if not any(s[n-1] == 'F' for s in rooms.values())]
        recommendations = []
        keys = set()

        def append(item):
            if item['kind'] == 'route':
                key = ('route', tuple(s['room'] for s in item['segments']))
            else:
                key = ('single', item['room'])
            if len(recommendations) < MIN_RECOMMENDATIONS and key not in keys:
                item['reason'] = recommendation_reason(item, label)
                recommendations.append(item)
                keys.add(key)

        singles = [{'kind': 'full', **item} for item in ranked] + [{'kind': 'evening', **item} for item in alternatives]
        # Rank before truncation; only afternoon considers period 5 occupancy.
        # Within a tier, retain complete evening coverage before 12-14 only.
        singles.sort(key=lambda item: (recommendation_tier(item, rooms), item['room'] not in SMALL, item['kind'] != 'full', label == '下午' and rooms[item['room']][4] != 'B', int(item['room'])))
        for item in singles:
            append(item)
        routes = []
        usual_routes = []
        # For evening the user's usual 12-14 window takes precedence among
        # transfer alternatives. Offer 11-14 routes too when more options help.
        windows = [(12, 14), (11, 14)] if label == '晚上' else [(a, b)]
        for start, end in windows:
            if len(recommendations) >= MIN_RECOMMENDATIONS:
                break
            pool = {r: s for r, s in rooms.items() if not full_free(s, start, end)}
            found, _ = find_routes(pool, start, end, limit=MIN_RECOMMENDATIONS)
            if label == '晚上' and start == 12:
                usual_routes = found
            else:
                routes = found
            for route in found:
                if route['moves']:
                    append({'kind': 'route', 'start': start, 'end': end, **route})
        # Last resort: longest confirmed contiguous interval per room, clearly
        # labelled as partial rather than claiming it covers the whole session.
        partial = []
        partial_start = 12 if label == '晚上' else a
        for room, slots in rooms.items():
            intervals = runs(n for n in range(partial_start, b+1) if slots[n-1] == 'F')
            if intervals and not full_free(slots, partial_start, b):
                start, end = min(intervals, key=lambda span: (-(span[1]-span[0]+1), span[0]))
                partial.append({'room': room, 'start': start, 'end': end})
        partial.sort(key=lambda x: (-(x['end']-x['start']+1), x['room'] not in SMALL, int(x['room']), x['start']))
        for item in partial:
            append({'kind': 'partial', **item})
        sessions[label] = {'full': ranked, 'evening_alternatives': alternatives,
                           'routes': routes, 'uncovered_periods': gaps,
                           'partial_options': [x for x in recommendations if x['kind'] == 'partial'],
                           'recommendations': recommendations,
                           'complete_count': sum(x['kind'] != 'partial' for x in recommendations),
                           'shortfall': max(0, MIN_RECOMMENDATIONS-len(recommendations))}
        if label == '晚上':
            sessions[label]['usual_routes'] = usual_routes
            sessions[label]['usual_uncovered_periods'] = [n for n in range(12, 15) if not any(s[n-1] == 'F' for s in rooms.values())]
    return {'date': data.get('date'), 'suggested_title': task_title(data.get('date')),
            'date_note': data.get('date_note', ''), 'building': '三号楼',
            'rooms': rooms, 'sessions': sessions, 'conflicts': conflicts, 'missing_small_rooms': missing,
            'excluded_seen': dropped, 'unmapped_rooms': sorted(set(rooms)-KNOWN, key=int),
            'notes': data.get('notes', []), 'sources': sorted({str(r.get('source','未标注截图来源')) for r in data['rows']})}


def render_route(route):
    path = ' → '.join(f"{s['room']}：{window_text(s['start'], s['end'])}" for s in route['segments'])
    transfers = '；'.join(f"{t['leave_after']}—{t['arrive_by']} 换到{t['to']}（{t['distance']}）" for t in route['transfers'])
    return f'{path}。换{route["moves"]}次；{transfers}。'


def render_markdown(result):
    lines = [f"# {result['suggested_title'] or '三号楼自习安排｜查询日期未提供'}", '']
    if result['date_note']:
        lines += [result['date_note'], '']
    lines += ['本次截图均为同一天；绿色为空闲，白色为有课。空闲不保证到场时有座位。已排除204、205、211、213、303、304、310、311。',
              f"以下完整列出截图中已识别且未排除的{len(result['rooms'])}间教室，小教室在前；表内列出各时段的全部空闲课节。", '',
              '| 教室（三号楼） | 上午：第1—5节 | 下午：第6—10节 | 晚上：第11—14节 |',
              '|---|---|---|---|']
    for room in sorted(result['rooms'], key=lambda r: (r not in SMALL, int(r))):
        cells = [availability(result['rooms'][room], *bounds) for bounds in RULES['sessions'].values()]
        cells = ['**全空闲**' if c == '全空闲' else c for c in cells]
        lines.append('| ' + ' | '.join([room + ('（小）' if room in SMALL else ''), *cells]) + ' |')
    if result['missing_small_rooms']:
        lines += ['', '截图未覆盖的小教室：' + '、'.join(result['missing_small_rooms']) + '，状态未提供。']
    if result['conflicts']:
        details = '、'.join(f"{c['room']}第{c['period']}节" for c in result['conflicts'])
        lines += ['', '重叠截图存在冲突，以下单元格暂不用于规划：' + details + '。']
    if result['unmapped_rooms']:
        lines += ['', '以下房间未收录于布局图，相邻关系待确认：' + '、'.join(result['unmapped_rooms']) + '。']
    for label, session in result['sessions'].items():
        a, b = RULES['sessions'][label]
        lines += ['', f'## {label}建议', '']
        if label == '晚上':
            lines += ['按你通常自习的第12—14节（19:50—22:15）安排；第11—14节全空闲的教室优先。', '']
        recommendations = session['recommendations']
        if session['shortfall']:
            lines += [f"已确认仅{len(recommendations)}条不同方案，不足5条（还差{session['shortfall']}条）；不以重复路线、未知课节或排除教室凑数。", '']
        if session['partial_options']:
            lines += [f"其中覆盖目标时段的方案{session['complete_count']}条，局部可用方案{len(session['partial_options'])}条；局部方案不能覆盖整个自习时段。", '']
        for index, item in enumerate(recommendations, 1):
            prefix = f'- **方案{index}**'
            if item['kind'] == 'full':
                room = item['room']
                lines.append(f"{prefix}｜{'首选' if index == 1 else '备选'} **{room}**：{window_text(a,b)}全空闲。")
            elif item['kind'] == 'evening':
                lines.append(f"{prefix}｜晚间次选 **{item['room']}**：第12—14节（19:50—22:15）连续空闲。")
            elif item['kind'] == 'route':
                window = window_text(item['start'], item['end'])
                lines.append(f"{prefix}｜换教室，覆盖{window}：{render_route(item)}")
            else:
                lines.append(f"{prefix}｜**局部可用，非整段**：{item['room']}，{window_text(item['start'], item['end'])}。")
            lines[-1] += ' **推荐原因：**' + item['reason']
        if not session['full']:
            lines += ['', f'现有截图中，未找到已确认{window_text(a,b)}全空闲的单间教室。']
        if label == '下午' and session['full'] and not any(i['arrive_early'] for i in session['full']):
            lines += ['', '未找到已确认“下午全空闲且第5节有课”的教室；上述整段空闲教室仍可作为备选。']
        shown_full = {x['room'] for x in recommendations if x['kind'] == 'full'}
        other_full = [x['room'] for x in session['full'] if x['room'] not in shown_full]
        if other_full:
            lines += ['', '其他全空闲教室：' + '、'.join(other_full) + '。']
        if session['uncovered_periods']:
            lines += ['', '无法拼成整个时段的连续方案；' + period_text(session['uncovered_periods']) + '未找到已确认空闲的可用教室。', '']
        if session.get('usual_uncovered_periods'):
            lines.append('第12—14节仍有缺口：' + period_text(session['usual_uncovered_periods']) + '。')
    if result['notes']:
        lines += ['', '补充：' + '；'.join(result['notes'])]
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--format', choices=['markdown', 'json'], default='markdown')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        result = analyze(json.loads(args.input.read_text(encoding='utf-8-sig')))
    except (KeyError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    text = json.dumps(result, ensure_ascii=False, indent=2) if args.format == 'json' else render_markdown(result)
    if args.output:
        args.output.write_text(text, encoding='utf-8')
    else:
        print(text)


if __name__ == '__main__':
    main()
