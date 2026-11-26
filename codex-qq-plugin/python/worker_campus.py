"""Run the selected classroom tool and return its finished reply to the gateway."""
import io
import json
import re
from threading import Lock
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image
from langchain.tools import tool

from campus_cache import snapshots
from campus_classrooms import CampusError, TZ, campus_stage, envelope, query_day
from campus_evidence import ClassroomLookupArgs, classroom_evidence
from campus_recommendations import timestamp
from campus_worker import process
from worker_artifacts import publish


_TIMEOUTS = {
    'CAMPUS_NAVIGATION_TIMEOUT': ('校园网页加载', 25),
    'CAMPUS_LOGIN_TIMEOUT': ('校园登录响应', 40),
    'CAMPUS_SEARCH_TIMEOUT': ('校园教室接口响应', 20),
    'CAMPUS_LOGIN_ACCOUNT_TIMEOUT': ('填写校园账号', 8),
    'CAMPUS_LOGIN_PASSWORD_TIMEOUT': ('填写校园密码', 8),
    'CAMPUS_LOGIN_SUBMIT_TIMEOUT': ('点击校园登录按钮', 8),
}


def _failure(data):
    timeout = _TIMEOUTS.get(data['code'])
    if timeout:
        label, seconds = timeout
        data = {**data, 'message': f'{label}超时（{seconds}秒时限），请稍后重试。'}
    return {'text': json.dumps(data, ensure_ascii=False, separators=(',', ':'))}


def _media(request_id, artifact):
    if not isinstance(artifact, str) or not re.fullmatch(r'[a-f0-9]{32}', artifact):
        raise CampusError('CAMPUS_RENDER_FAILED')
    path = Path.cwd() / '.private' / 'campus-output' / (artifact + '.png')
    try:
        with path.open('rb') as handle:
            raw = handle.read(1_500_001)
        if not 45 <= len(raw) <= 1_500_000:
            raise CampusError('CAMPUS_RENDER_FAILED')
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != 'PNG' or image.width not in {1080, 1800} or not 200 <= image.height <= 16000:
                raise CampusError('CAMPUS_RENDER_FAILED')
            image.verify()
        return {'text': '', **publish(request_id, 'png', raw)}
    finally:
        path.unlink(missing_ok=True)


def _collect(mode, day, grant, performance, trace, **scope):
    result = process({
        'type': 'campus', 'mode': mode, 'cache_snapshot': True, 'args': {'date': day},
        'credentials': grant.get('credentials', {}), 'session_state': grant.get('session_state'), **scope,
    }, on_stage=trace, authorized=performance.campus_allowed)
    state = result.get('session_state')
    if result.get('data', {}).get('ok') and state is not None and len(json.dumps(state, ensure_ascii=False).encode()) <= 60_000:
        performance.save_campus_session(state)
    return result


def _classroom_source(args, packet, performance, grant, trace):
    now = timestamp(packet['now'])
    allowed = performance.campus_allowed
    requested_day = query_day(args.get('date', ''), now)
    if not allowed():
        return {'text': '', 'cancelled': True}

    def read(filters):
        day = query_day(filters.get('date') or requested_day, now)
        cached = snapshots(Path.cwd()/'.private').get(day)
        if not cached or not timedelta(0) <= now - timestamp(cached['fetched_at']) <= timedelta(minutes=30):
            result = _collect('query', day, grant, performance, trace)
            if result.get('cancelled'):
                return {'text': '', 'cancelled': True}
            cached = result['data']
            if not cached['ok']:
                return {'text': '未能取得所查日期的校园课表，暂时无法核实。'}
        return {'evidence': classroom_evidence(cached, filters, now)}

    # Only the reader selects the actual query. Router hints are never timetable facts.
    reply = {'evidence': {'query_required': True, 'campus': '学院路校区', 'now': now.isoformat(),
                          'query_hints': {**args, 'date': requested_day}}}

    lock = Lock()
    remaining = 2

    @tool(args_schema=ClassroomLookupArgs)
    def lookup_classroom_schedule(**filters) -> dict:
        """查询学院路课表。rooms 查点名的教室，near_room 找参照教室周边的其他空教室（保留楼名前缀）。层数单独填 floor。给出时段时传 start_time 和 end_time。省略 date 沿用本轮查询日。"""
        nonlocal remaining
        # LangChain may issue parallel calls. The gateway uses serial request/reply I/O.
        with lock:
            if remaining <= 0:
                return {'error': '本轮查询次数已用完。'}
            remaining -= 1
            if not allowed():
                return {'error': '本轮查询授权已结束。'}
            with performance.span('fuzzy_source_lookup'):
                try:
                    found = read(filters)
                except (ValueError, CampusError, OSError):
                    return {'error': '未能取得该日期可核实的课表，仅支持今天至未来七天。'}
                if found.get('cancelled') or not allowed():
                    return {'error': '本轮查询授权已结束。'}
                return found['evidence'] if 'evidence' in found else {'error': found['text']}

    return {**reply, 'source_tool': lookup_classroom_schedule, 'still_allowed': allowed}


def execute(name, args, packet, performance, grant):
    """Only the gateway supplies the account and can renew chat authorization."""
    evidence = name == 'buaa_classroom_data'
    if not evidence and name not in {'buaa_classroom_query', 'buaa_classroom_recommend'}:
        raise ValueError('UNKNOWN_TOOL')
    code = grant.get('code', 'CAMPUS_CONFIG_UNAVAILABLE')
    if code == 'CAMPUS_OWNER_ONLY':
        return {'text': '', 'cancelled': True}
    if code != 'OK':
        if evidence:
            return {'text': '校园课表数据源暂不可用，无法核实教室安排。'}
        if name == 'buaa_classroom_recommend':
            return {'text': '校园查询未启用，请先在本机设置页启用。'}
        return _failure(envelope(code=code))

    def trace(stage, phase, **fields):
        performance.campus_event({'stage': stage, 'phase': phase, **fields})

    lookup = {'type': 'campus', 'mode': 'recommend', 'args': args}
    try:
        if evidence:
            return _classroom_source(args, packet, performance, grant, trace)
        if name == 'buaa_classroom_query':
            compact = args.get('view') == 'compact'
            stage = 'campus-fetch-current' if compact else 'campus-fetch'
            if not performance.campus_progress(stage):
                return {'text': '', 'cancelled': True}
            region = {'building': args.get('building', '三号楼'), 'regions': args.get('regions', [])}
            result = _collect('query' if compact else 'report', args.get('date', ''), grant, performance, trace, **region)
            if result.get('cancelled'):
                return {'text': '', 'cancelled': True}
            data = result['data']
            if not data['ok']:
                return _failure(data)
            if not compact:
                return _media(packet['id'], result.get('artifact_id'))
            # Use this collection even if a scheduled job immediately refreshes the shared snapshot.
            lookup.update(snapshot=data, args={'date': data['date'], 'session': args.get('session', 'now'), **region})

        lookup['now'] = datetime.now(TZ).isoformat()
        report = process(lookup)['recommendation']
        if not report['ok']:
            return {'text': report['message']}
        if not performance.campus_allowed():
            return {'text': '', 'cancelled': True}
        try:
            advice = performance.campus_advice(report)
        except Exception:
            advice = ''
        with campus_stage(trace, 'campus_render', error_code='CAMPUS_RENDER_FAILED'):
            result = process({'type': 'campus', 'mode': 'recommend_render', 'report': report, 'explanation': advice})
            return _media(packet['id'], result['artifact_id'])
    except (OSError, ValueError, CampusError) as error:
        code = error.code if isinstance(error, CampusError) else 'CAMPUS_QUERY_FAILED'
        if evidence:
            return {'text': '校园接口只提供今天到未来七天的课表。' if code == 'CAMPUS_INVALID_DATE' else '未能取得可核实的校园课表。'}
        return _failure(envelope(code=code))
