"""Fixed, read-only official AI status sources. No model/account credentials.

Gemini uses the anonymous status page's own public client configuration and
ListIncidentsHistory RPC. That RPC is read-only; no model inference is sent.
Unknown schemas or inaccessible sources never imply healthy service.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from html import unescape
from typing import Literal
from urllib.request import Request, build_opener
import json
import re
import time

from langchain.tools import tool
from pydantic import BaseModel, ConfigDict
from public_status import NoRedirect, FlightParser, parse_deepseek

Provider = Literal['openai', 'deepseek', 'gemini', 'claude', 'kimi']
SOURCES = {
    'openai': 'https://status.openai.com/', 'deepseek': 'https://status.deepseek.com/',
    'gemini': 'https://aistudio.google.com/status', 'claude': 'https://status.claude.com/',
    'kimi': 'https://status.moonshot.cn/',
}
TITLES = dict(openai='OpenAI', deepseek='DeepSeek', gemini='Gemini', claude='Claude', kimi='Kimi')
GEMINI_RPC = ('https://alkalimakersuite-pa.clients6.google.com/$rpc/'
              'google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListIncidentsHistory')
TZ = timezone(timedelta(hours=8))
MAX_BODY = 2_000_000
DONE = {'resolved', 'completed', 'cancelled', 'postmortem'}
STATES = {'operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance', 'unknown'}
STATE_ALIAS = {'degraded': 'degraded_performance', 'full_outage': 'major_outage', 'maintenance': 'under_maintenance'}
STATE_TEXT = {'operational': '正常', 'degraded_performance': '性能下降', 'partial_outage': '部分中断',
              'major_outage': '服务中断', 'under_maintenance': '维护中', 'unknown': '待确认', 'affected': '受影响'}
PHASE_TEXT = {'investigating': '排查中', 'detected': '发现问题', 'identified': '已确认问题',
              'monitoring': '修复后观察', 'mitigated': '已缓解', 'update': '进展更新',
              'in_progress': '维护中', 'verifying': '验证中', 'unknown': '阶段未公布'}
_cache = {}


class ProviderStatusArgs(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    provider: Provider


def text(value, limit=600):
    if not isinstance(value, str):
        return ''
    value = re.sub(r'<[^>]*>', '', unescape(value))
    value = re.sub(r'[\x00-\x20\x7f@<>]+', ' ', value).strip()
    return value if len(value) <= limit else value[:limit-1] + '…'


def state(value):
    value = STATE_ALIAS.get(value, value)
    return value if value in STATES else 'unknown'


def iso(value):
    try:
        date = datetime.fromtimestamp(value, timezone.utc) if isinstance(value, (float, int)) else datetime.fromisoformat(value.replace('Z', '+00:00'))
        if date.tzinfo is None:
            raise ValueError('TIMESTAMP_MISSING_ZONE')
        return date.astimezone(TZ).isoformat(timespec='seconds')
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def request(url, *, data=None, headers=None):
    allowed = {SOURCES['deepseek'], SOURCES['gemini'], GEMINI_RPC}
    allowed.update(SOURCES[p] + path for p in ('openai', 'claude', 'kimi')
                   for path in ('api/v2/summary.json', 'api/v2/incidents.json'))
    if url not in allowed:
        raise ValueError('STATUS_SOURCE_DENIED')
    supplied = {'User-Agent': 'Mozilla/5.0 AlexQQ-Status/2.0', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache'}
    supplied.update(headers or {})
    with build_opener(NoRedirect()).open(Request(url, data=data, headers=supplied), timeout=8) as response:
        raw = response.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError('STATUS_TOO_LARGE')
    return raw.decode('utf-8')


def label(name, provider):
    known = {
        'Chat Completions': 'Chat Completions API', 'Responses': 'Responses API',
        'Conversations': 'ChatGPT 对话', 'Codex in ChatGPT Desktop': 'Codex · ChatGPT 桌面端',
        'Image Generation': 'ChatGPT 图像生成', 'Voice mode': 'ChatGPT 语音',
        'claude.ai': 'Claude 对话', 'Claude Console (platform.claude.com)': '开发者控制台',
        'Claude API (api.anthropic.com)': 'Claude API', 'Claude for Government': 'Claude 政务版',
        'Website': 'Kimi 网页', 'API Service': 'Kimi 应用 API', 'Open API': '开放平台 API',
        'Open Platform Portal': '开放平台控制台', 'File uploads': '文件上传', 'Search': '联网搜索',
        'DeepSeek V4 Pro API服务(API Service)': 'V4 Pro API',
        'DeepSeek V4.1 Flash API服务(API Service)': 'V4.1 Flash API',
        '对话服务(Chatservice)': '对话服务', '上传文件服务(File Upload Service)': '文件上传',
        '搜索服务(Search Service)': '对话搜索', '搜索API服务(Search API Service)': '搜索 API',
        '抓取API服务(Fetch API Service)': '抓取 API',
    }
    return known.get(name, text(name, 100))


def progress(body, phase):
    # Only translate fixed official boilerplate; preserve other notices verbatim.
    if isinstance(body, str) and re.match(r'^\s*[\u4e00-\u9fff]', body):
        # Keep Chinese paragraphs; remove only an explicitly separated English
        # translation, never English product names inside a Chinese sentence.
        return text(re.split(r'\n\s*\n(?=[A-Z])', body, maxsplit=1)[0])
    body = text(body)
    fixed = {
        'A fix has been implemented and we are monitoring the results.': '修复已实施，官方正在观察恢复情况。',
        'A fix has been implemented and the results are being monitored.': '修复已实施，官方正在观察恢复情况。',
        'We are currently investigating this issue.': '官方正在排查问题，尚未确认恢复。',
        'We’ve applied a mitigation and are monitoring the affected services to confirm recovery.': '缓解措施已实施，官方正在观察恢复情况。',
    }
    if body in fixed:
        return fixed[body]
    return body or '官方暂未披露详细处理进展。'


def incident(title, phase, affected, symptom, body, updated):
    return dict(title=text(title, 200) or '官方正在处理的事件', phase=text(phase, 40) or 'unknown',
                affected=text(affected, 500) or '官方暂未列明受影响服务',
                symptom=text(symptom, 600) or '官方暂未说明具体故障表现。',
                progress=progress(body, phase), updatedAt=iso(updated), eta='恢复时间以官方后续通报为准')


def parse_statuspage(provider, data, feed=None):
    if not isinstance(data, dict) or not isinstance(data.get('status'), dict):
        raise ValueError('STATUS_SCHEMA_CHANGED')
    components = data.get('components')
    events = (feed if feed is not None else data).get('incidents')
    if not isinstance(components, list) or not 1 <= len(components) <= 100 or not isinstance(events, list) or len(events) > 100:
        raise ValueError('STATUS_SCHEMA_CHANGED')
    maintenance = data.get('scheduled_maintenances', [])
    if not isinstance(maintenance, list) or len(maintenance) > 50:
        raise ValueError('STATUS_SCHEMA_CHANGED')
    events = [*events, *maintenance]
    rows = []
    for component in components:
        if not isinstance(component, dict) or not text(component.get('name')):
            raise ValueError('STATUS_SCHEMA_CHANGED')
        rows.append(dict(label=label(component['name'], provider), state=state(component.get('status')), sourceName=text(component['name'], 100)))
    active = []
    for event in events:
        if not isinstance(event, dict):
            raise ValueError('STATUS_SCHEMA_CHANGED')
        phase = event.get('status', 'unknown')
        if phase in DONE or phase == 'scheduled':
            continue
        updates = event.get('incident_updates', [])
        if not isinstance(updates, list):
            raise ValueError('STATUS_SCHEMA_CHANGED')
        valid = [u for u in updates if isinstance(u, dict)]
        latest = max(valid, key=lambda u: iso(u.get('display_at') or u.get('created_at')) or '', default={})
        affected = [label(c.get('name', ''), provider) for c in event.get('components', []) if isinstance(c, dict)]
        active.append(incident(event.get('name'), phase, '、'.join(affected), event.get('name'), latest.get('body'),
                               latest.get('display_at') or latest.get('created_at') or event.get('updated_at')))
    # Pick common services but always retain every abnormal component.
    preferred = {
        'openai': {'Chat Completions', 'Responses', 'Conversations', 'Codex in ChatGPT Desktop', 'Image Generation', 'Voice mode'},
        'kimi': {'Website', 'Open API', 'API Service', 'Open Platform Portal', 'Kimi Code', 'File uploads', 'Search'},
    }.get(provider)
    chosen = [r for r in rows if not preferred or r['sourceName'] in preferred or r['state'] != 'operational']
    if not chosen:
        chosen = rows
    indicator = data['status'].get('indicator')
    unknown = indicator not in {'none', 'minor', 'major', 'critical', 'maintenance'} or any(r['state'] == 'unknown' for r in rows)
    abnormal = indicator != 'none' or bool(active) or any(r['state'] != 'operational' for r in rows)
    return dict(rows=chosen, incidents=active, overall='unknown' if unknown else 'incident' if abnormal else 'operational',
                listLabel='常用服务 · 含全部异常' if preferred else '全部服务')


def parse_deepseek_report(html):
    old = parse_deepseek(html)
    parser = FlightParser(); parser.feed(html)
    flight = ''.join(parser.parts)
    match = re.search(r'"initialData":', flight)
    data, _ = json.JSONDecoder().raw_decode(flight[match.end():])
    active = []
    for change in data['active_changes']:
        phase = change.get('status', 'unknown')
        if phase in DONE or phase == 'scheduled':
            continue
        updates = change.get('updates', [])
        if not isinstance(updates, list):
            raise ValueError('STATUS_SCHEMA_CHANGED')
        latest = max((u for u in updates if isinstance(u, dict)), key=lambda u: u.get('at_seconds') or 0, default={})
        affected = '、'.join(label(c.get('name', ''), 'deepseek') for c in change.get('affected_components', []) if isinstance(c, dict))
        title = re.split(r'（DeepSeek|\(DeepSeek', text(change.get('title'), 200))[0].strip()
        active.append(incident(title, phase, affected, title, latest.get('description') or change.get('description'),
                               latest.get('at_seconds') or change.get('start_at_seconds')))
    return dict(rows=[dict(label=label(r['name'], 'deepseek'), sourceName=r['name'], state=state(r['status'])) for r in old['components']],
                incidents=active, overall='operational' if old['overall'] == 'operational' and not active else 'unknown' if old['overall'] == 'unknown' and not active else 'incident', listLabel='全部服务')


def parse_gemini(data):
    # Same protobuf array fields and resolution rule as the official status UI.
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], list) or len(data[0]) != 1 or not isinstance(data[0][0], list):
        raise ValueError('STATUS_SCHEMA_CHANGED')
    names = {1: 'Gemini API', 2: 'Multimodal Live API', 3: 'Google AI Studio'}
    levels = {1: 'partial_outage', 2: 'major_outage'}
    phases = {1: 'detected', 2: 'identified', 3: 'mitigated', 4: 'resolved', 5: 'update'}
    rows = {i: dict(label=n, sourceName=n, state='operational') for i, n in names.items()}
    active = []
    for record in data[0][0]:
        if not isinstance(record, list) or len(record) < 5 or not isinstance(record[3], list) or not record[3]:
            raise ValueError('STATUS_SCHEMA_CHANGED')
        updates = record[3]
        if any(not isinstance(u, list) or len(u) < 4 for u in updates):
            raise ValueError('STATUS_SCHEMA_CHANGED')
        if any(u[0] == 4 for u in updates):
            continue
        services = record[5] if len(record) > 5 and record[5] else [record[4]]
        if not isinstance(services, list) or any(i not in names for i in services):
            raise ValueError('STATUS_SCHEMA_CHANGED')
        def update_time(u):
            return int(u[2][0]) if isinstance(u[2], list) and u[2] else 0
        latest = max(updates, key=update_time)
        for i in services:
            current = levels.get(record[2], 'unknown')
            if rows[i]['state'] != 'major_outage':
                rows[i]['state'] = current
        active.append(incident(record[1], phases.get(latest[0], 'unknown'), '、'.join(names[i] for i in services),
                               record[1], latest[3], update_time(latest)))
    return dict(rows=list(rows.values()), incidents=active, overall='incident' if active else 'operational', listLabel='官方状态页覆盖范围',
                scopeNote='覆盖 AI Studio 与 Gemini API，不含消费端及 Vertex AI。')


def fetch_provider(provider):
    if provider in ('openai', 'claude', 'kimi'):
        data = json.loads(request(SOURCES[provider] + 'api/v2/summary.json'))
        # OpenAI's summary compatibility feed omits some incidents.
        feed = json.loads(request(SOURCES[provider] + 'api/v2/incidents.json')) if provider == 'openai' else None
        return parse_statuspage(provider, data, feed)
    if provider == 'deepseek':
        return parse_deepseek_report(request(SOURCES[provider]))
    if provider == 'gemini':
        page = request(SOURCES[provider])
        key = re.search(r'"WIu0Nc":"(AIza[A-Za-z0-9_-]{30,})"', page)
        if not key:
            raise ValueError('STATUS_SCHEMA_CHANGED')
        # Public website client identifier, read afresh; never stored/logged.
        raw = request(GEMINI_RPC, data=b'[]', headers={
            'Content-Type': 'application/json+protobuf', 'X-Goog-Api-Key': key[1],
            'Origin': 'https://aistudio.google.com', 'Referer': 'https://aistudio.google.com/'})
        return parse_gemini(json.loads(raw))
    raise ValueError('STATUS_PROVIDER_DENIED')


def prepare_report(provider, facts, checked):
    result = dict(facts, provider=provider, title=TITLES[provider], source=SOURCES[provider], checkedAt=checked, mode='snapshot')
    result['incidentCount'] = len(result['incidents'])
    if result['overall'] != 'operational' and not result['incidents'] and not result.get('notice'):
        bad = [r['label'] for r in result['rows'] if r['state'] != 'operational']
        result['notice'] = incident('官方状态信息不完整' if result['overall']=='unknown' else '官方标记服务异常，尚无详细通报',
            'unknown', '、'.join(bad), '部分状态字段未识别，暂不能确认服务是否正常。' if result['overall']=='unknown'
            else '请查看上方服务状态；官方暂未提供对应事件详情。', '', None)
    result.setdefault('statusTitle', '运行正常' if result['overall'] == 'operational' else '状态待确认' if result['overall'] == 'unknown'
                      else '修复后观察' if result['incidents'] and all(i['phase'] == 'monitoring' for i in result['incidents']) else '服务异常')
    result.setdefault('summary', '官方当前未报告服务异常' if result['overall'] == 'operational' else '具体影响与处理进展见下方详情')
    return result


@tool(args_schema=ProviderStatusArgs, return_direct=True)
def ai_service_status(provider: Provider) -> dict:
    """查询五家AI厂商的官方公共服务状态；仅固定provider，无URL/Key/账户/收件人。未知明确标注，不做付费模型探测。"""
    if provider not in SOURCES:
        raise ValueError('STATUS_PROVIDER_DENIED')
    cached = _cache.get(provider)
    if cached and 0 <= time.monotonic() - cached[0] < 45:
        return cached[1]
    try:
        facts = fetch_provider(provider)
    except Exception:
        facts = dict(overall='unknown', rows=[dict(label='官方服务状态',sourceName='官方服务状态',state='unknown')], incidents=[], listLabel='暂不可核实', statusTitle='状态待确认',
                     summary='本次未能读取官方状态信息', notice=incident('官方状态数据暂不可读', 'unknown', TITLES[provider],
                        '可能是状态源连接超时或页面格式变化，不能据此判断模型服务故障。', '请稍后重试，或打开下方官方状态页核对。', None))
    checked = datetime.now(TZ).isoformat(timespec='seconds')
    report = prepare_report(provider, facts, checked)
    caption = TITLES[provider] + '：' + report['statusTitle']
    if report.get('notice'):
        caption += '\n' + report['notice']['symptom']
    elif report['incidents']:
        caption += '\n进行中事件：' + str(report['incidentCount'])
        caption += ''.join('\n' + i['title'] + '（' + PHASE_TEXT.get(i['phase'], '阶段未公布') + '）' for i in report['incidents'])
    caption = text(caption, 3500) + '\n来源：' + SOURCES[provider]
    result = dict(service=provider, source=SOURCES[provider], checked_at=checked, report=report, text=caption)
    if facts['overall'] != 'unknown':
        _cache[provider] = (time.monotonic(), result)
    return result
