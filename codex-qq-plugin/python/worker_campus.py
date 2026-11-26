"""Run the selected classroom tool and return its finished reply to the gateway."""
import io
import json
import re
from datetime import datetime, timedelta
from pathlib import Path

from PIL import Image

from campus_cache import snapshots
from campus_classrooms import CampusError, TZ, campus_stage, envelope, query_day
from campus_evidence import classroom_evidence
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

    def evidence_reply(snapshot, now):
        return {'evidence': classroom_evidence(snapshot, args, now), 'still_allowed': performance.campus_allowed}

    lookup = {'type': 'campus', 'mode': 'recommend', 'args': args}
    try:
        if evidence or name == 'buaa_classroom_query':
            compact = args.get('view') == 'compact'
            stage = 'campus-fetch-current' if compact else 'campus-fetch'
            if not (performance.campus_allowed() if evidence else performance.campus_progress(stage)):
                return {'text': '', 'cancelled': True}
            if evidence:
                now = timestamp(packet['now'])
                day = query_day(args.get('date', ''), now)
                cached = snapshots(Path.cwd()/'.private').get(day)
                if cached and timedelta(0) <= now - timestamp(cached['fetched_at']) <= timedelta(minutes=30):
                    return evidence_reply(cached, now)
            region = {'building': args.get('building', '三号楼'), 'regions': args.get('regions', [])}
            result = process({
                'type': 'campus', 'mode': 'query' if compact or evidence else 'report', 'cache_snapshot': True,
                'args': {'date': day if evidence else args.get('date', '')}, 'credentials': grant.get('credentials', {}),
                'session_state': grant.get('session_state'), **region,
            }, on_stage=trace, authorized=performance.campus_allowed)
            if result.get('cancelled'):
                return {'text': '', 'cancelled': True}
            data = result['data']
            if not data['ok']:
                if evidence:
                    return {'text': '未能取得所查日期的校园课表，暂时无法核实。'}
                return _failure(data)
            # A large cookie jar can still serve this request; it is optional on the 64 KiB gateway.
            state = result.get('session_state')
            if state is not None and len(json.dumps(state, ensure_ascii=False).encode()) <= 60_000:
                performance.save_campus_session(state)
            if evidence:
                return evidence_reply(data, now)
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
