"""CMA public warning feed: deterministic, bounded LangChain tool, no model calls.

The feed lacks expiry/cancellation fields. Disappearance is NEVER a cancellation.
An ancestor bulletin retains its original territorial wording on every card.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Literal
from urllib.request import Request, urlopen

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

SOURCE = 'https://weather.cma.cn/api/alarm'
TZ = timezone(timedelta(hours=8))
COLORS = {'白色': 0, '蓝色': 1, '黄色': 2, '橙色': 3, '红色': 4}
MAX_BYTES = 5_000_000


def compact(value):
    return re.sub(r'[\s·•,，/]+', '', value).casefold()


@lru_cache(maxsize=1)
def catalogue_places():
    return json.loads((Path(__file__).resolve().parent.parent / 'data/weather-locations.json').read_text('utf-8'))['places']


@lru_cache(maxsize=1)
def areas():
    result = {}
    for place in catalogue_places():
        code = place.get('administrativeCode', '')
        if place.get('countryCode') != 'CN' or not re.fullmatch(r'[1-6]\d{5}', code):
            continue
        province = place['admin1']
        name = place['name']
        row = result.setdefault(code, {'code': code, 'name': name, 'province': province,
                                      'level': 'province' if code.endswith('0000') else 'city' if code.endswith('00') else 'district',
                                      'aliases': set()})
        row['aliases'].update(compact(a) for a in [name, *place.get('aliases', [])])
        # Published catalogue names sometimes omit the administrative suffix.
        row['aliases'].update(compact(a + suffix) for a in [name, *place.get('aliases', [])]
                              for suffix in ['区', '县', '市'] if a and '\u4e00' <= a[-1] <= '\u9fff')
        parent = code[:2] + '0000'
        p = result.setdefault(parent, {'code': parent, 'name': province, 'province': province,
                                      'level': 'province', 'aliases': set()})
        p['aliases'].add(compact(province))
        p['aliases'].add(compact(re.sub(r'(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '', province)))
    return result


def public_area(row):
    return {k: row[k] for k in ['code', 'name', 'province', 'level']}


def resolve(query, search=False):
    key = compact(query)
    if not key or len(key) > 48 or not re.fullmatch(r'[\u3400-\u9fffa-z0-9（）()\-]+', key):
        return {'ok': False, 'code': 'ALERT_AREA_INVALID', 'suggestions': []}
    rows = list(areas().values())
    exact = [r for r in rows if key == r['code'] or key in r['aliases']]
    if len(exact) == 1 and not search:
        return {'ok': True, 'area': public_area(exact[0])}
    candidates = exact or [r for r in rows if any(key in alias for alias in r['aliases'])]
    candidates.sort(key=lambda r: (r['code'] not in {x['code'] for x in exact}, len(r['name']), r['code']))
    return {'ok': search, 'code': 'ALERT_AREA_AMBIGUOUS' if candidates else 'ALERT_AREA_NOT_FOUND',
            'suggestions': [public_area(r) for r in candidates[:12]]}


def parse_command(text):
    if re.fullmatch(r'\s*/?实时预警\s*', text):
        return {'ok': True, 'operation': 'list'}
    match = re.fullmatch(r'\s*/?(开启|关闭)\s*实时预警\s+(.{1,48})\s*', text)
    if not match:
        return {'ok': False, 'code': 'ALERT_COMMAND_INVALID'}
    resolved = resolve(match[2].strip())
    return {**resolved, 'operation': 'enable' if match[1] == '开启' else 'disable'}


def relation(area, alert_code):
    code = area['code']
    if code == alert_code:
        return '本地'
    if alert_code == code[:2] + '0000':
        return '省级'
    if not code.endswith('0000') and alert_code == code[:4] + '00':
        return '市级'
    if code.endswith('00') and not code.endswith('0000') and alert_code.startswith(code[:4]):
        return '辖区'
    # A province subscription follows provincial issuers, not thousands of
    # unrelated county notices. The console states that scope explicitly.
    return None


def clean(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('ALERT_SOURCE_SCHEMA')
    return html.unescape(re.sub(r'<[^>]*>', '', value)).strip()


def normalize(row, now):
    identifier = row.get('id', '')
    match = re.fullmatch(r'(\d{6}[A-Z0-9]{7,8})_(\d{14})', identifier)
    if not match:
        raise ValueError('ALERT_SOURCE_SCHEMA')
    # The ID timestamp can be later than the actual issue time in the bulletin.
    # effective can be in the future; it is not an expiry.
    issued = datetime.strptime(match[2], '%Y%m%d%H%M%S').replace(tzinfo=TZ)
    if issued > now + timedelta(minutes=15) or issued < now - timedelta(hours=72):
        return None
    headline = clean(row.get('headline'), 500)
    description = clean(row.get('description'), 9000)
    title = clean(row.get('title'), 500)
    signal = str(row.get('type', ''))
    if not re.fullmatch(r'p\d{7}', signal):
        raise ValueError('ALERT_SOURCE_SCHEMA')
    color_match = re.search(r'(白色|蓝色|黄色|橙色|红色)(?:灾害)?预警|预警(?:信号)?[（(【：:]\s*(白色|蓝色|黄色|橙色|红色)', headline+' '+title)
    color = next((group for group in color_match.groups() if group),'未分色') if color_match else '未分色'
    hazard = re.search(r'(?:发布|继续发布|变更|升级为|升级|更新)([^\[：。]{1,30}?)(?:白色|蓝色|黄色|橙色|红色)预警', headline)
    hazard_name = hazard[1].strip() if hazard else re.sub(r'^.*?(?:发布|解除|取消|终止)', '', title).split('预警')[0]
    for c in COLORS:
        hazard_name = hazard_name.replace(c, '')
    transition = re.search(r'(?:变更|调整|升级|降级|下调|上调)(?:为|至)([\u3400-\u9fff]{0,24}?)(白色|蓝色|黄色|橙色|红色)(?:预警|信号|$)', headline)
    if transition:
        color = transition[2]
        before = re.search(r'(?:发布|解除|将)([\u3400-\u9fff]{1,24}?)(?:白色|蓝色|黄色|橙色|红色)预警',headline)
        hazard_name = transition[1] or (before[1] if before else hazard_name)
    cancelled = bool(re.search(r'(?:解除|取消|终止).{0,35}预警', headline))
    issuer = re.split(r'发布|解除|取消|升级|变更|继续', headline)[0]
    issuer = re.sub(r'\d{4}年.*$', '', issuer).strip()
    published = issued
    issued_match = re.search(r'(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日\s*(\d{1,2})时(?:(\d{1,2})分)?(?:继续)?发布', description[:200])
    if issued_match:
        year, month, day, hour, minute = issued_match.groups()
        try:
            candidate = datetime(int(year or issued.year), int(month or issued.month), int(day), int(hour), int(minute or 0), tzinfo=TZ)
            if abs((candidate-issued).total_seconds()) <= 86400:
                published = candidate
        except ValueError:
            pass
    code = match[1][:6]
    series = match[1] + ':' + signal[:-3]
    fingerprint = hashlib.sha256((identifier + headline + description + str(row.get('effective'))).encode()).hexdigest()
    return {'id': identifier, 'series': series, 'fingerprint': fingerprint, 'code': code,
            'province': areas().get(code[:2] + '0000', {}).get('name', code[:2]),
            'issuer': issuer, 'headline': headline, 'description': description, 'title': title,
            'hazard': hazard_name, 'color': color, 'severity': COLORS.get(color, 0), 'cancelled': cancelled,
            'publishedAt': published.isoformat(), 'effective': clean(row.get('effective'), 80),
            'url': 'https://weather.cma.cn/web/alarm/' + identifier + '.html', 'source': '中国气象局',
            'level': '省级' if code.endswith('0000') else '市级' if code.endswith('00') else '区县级'}


def parse_feed(payload, codes, previous=None, now=None, *, timeline=False):
    now = now or datetime.now(TZ)
    if not isinstance(payload, dict) or payload.get('code') != 0 or not isinstance(payload.get('data'), list) or len(payload['data']) > 12000:
        raise ValueError('ALERT_SOURCE_SCHEMA')
    requested = [areas()[c] for c in codes]
    latest = {}
    for row in payload['data']:
        if not isinstance(row, dict):
            raise ValueError('ALERT_SOURCE_SCHEMA')
        # Validate the whole snapshot; never convert a malformed page into "no warnings".
        alert = normalize(row, now)
        if alert and any(relation(a, alert['code']) for a in requested):
            key = (alert['id'],alert['series'],alert['hazard']) if timeline else alert['series']
            if key not in latest or alert['id'] > latest[key]['id']:
                latest[key] = alert
    values = list(latest.values())
    if timeline:
        return {'alerts':values,'sourceCount':len(payload['data'])}
    values=decorate(values,codes,previous)
    return {'ok': True, 'schema': 'weather.alerts.v1', 'source': SOURCE, 'checkedAt': now.isoformat(),
            'sourceCount': len(payload['data']), 'alerts': values}


def decorate(values,codes,previous=None):
    requested=[areas()[c] for c in codes]
    previous = {r['series']: r for r in (previous or []) if isinstance(r, dict) and 'series' in r}
    for a in values:
        prior = previous.get(a['series'])
        a['change'] = ('解除' if a['cancelled'] else '新增' if not prior else
                       '未变' if a['fingerprint'] == prior.get('fingerprint') else
                       '升级' if a['severity'] > prior.get('severity', 0) else
                       '降级' if a['severity'] < prior.get('severity', 0) else '更新')
        a['previousColor'] = prior.get('color') if prior else None
        a['matches'] = [{'area': public_area(r), 'relation': relation(r, a['code'])}
                        for r in requested if relation(r, a['code'])]
        a['provinceContext'] = [{'headline': p['headline'], 'publishedAt': p['publishedAt']}
                               for p in values if p['code'] == a['code'][:2] + '0000' and p['id'] != a['id'] and not p['cancelled']][:8]
    values.sort(key=lambda a: (-a['severity'], a['publishedAt'], a['id']))
    return values


def fetch_feed():
    req = Request(SOURCE, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Cache-Control': 'no-cache'})
    with urlopen(req, timeout=10) as response:
        if response.url.split('?')[0] != SOURCE:
            raise ValueError('ALERT_SOURCE_REDIRECT')
        body = response.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError('ALERT_SOURCE_SIZE')
    return json.loads(body)


class AlertArgs(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['search', 'command', 'poll', 'outdoor']
    date: str = Field(default='', max_length=10)
    query: str = Field(default='', max_length=100)
    codes: list[str] = Field(default_factory=list, max_length=105)
    previous: list[dict] = Field(default_factory=list, max_length=3000)


@tool(args_schema=AlertArgs)
def weather_alerts(action: str, query: str = '', codes: list[str] | None = None, previous: list[dict] | None = None, date: str = '') -> dict:
    """Resolve administrative areas or read official CMA warnings. No recipients, URLs or model access."""
    if action == 'command':
        return parse_command(query)
    if action == 'search':
        return resolve(query, search=True)
    if action == 'outdoor' and query:
        fixed={'beijing':'110000','tianjin':'120000','guangzhou':'440100'}
        code=fixed.get(query) or next((p.get('administrativeCode') for p in catalogue_places()
                                      if p['id']==query and p.get('countryCode')=='CN'),None)
        codes=[code] if code else []
    if not codes or any(c not in areas() for c in codes) or len(set(codes)) != len(codes):
        return {'ok': False, 'code': 'ALERT_AREA_INVALID'}
    try:
        from concurrent.futures import ThreadPoolExecutor
        from regional_air_alerts import sources,coverage
        regional=sources(codes)
        with ThreadPoolExecutor(max_workers=3) as pool:
            cma=pool.submit(fetch_feed);pending=[(key,pool.submit(fetch,timeline=True) if action=='outdoor' else pool.submit(fetch)) for key,fetch in regional]
            failures=[];alerts=[];count=0
            try:
                result=parse_feed(cma.result(),codes,previous,timeline=action=='outdoor');alerts=result['alerts'];count=result['sourceCount']
            except Exception:failures.append('cma')
            for key,future in pending:
                try:
                    extra=future.result()
                    for a in extra:a['sourceKey']=key
                    alerts+=extra;count+=len(extra)
                except Exception:failures.append(key)
        if len(failures)==len(regional)+1:return {'ok':False,'code':'ALERT_SOURCE_UNAVAILABLE'}
        if action=='outdoor':
            from outdoor_warnings import report_red_hazards
            now=datetime.now(TZ)
            return {'ok':True,'date':date,'placeId':query,'code':codes[0],'checkedAt':now.isoformat(),
                    'hazards':report_red_hazards(alerts,areas()[codes[0]],date,now),
                    'partial':bool(failures) or coverage(codes)[0]['heavyPollution']=='source_not_verified'}
        return {'ok':True,'schema':'weather.alerts.v1','source':SOURCE,'checkedAt':datetime.now(TZ).isoformat(),
                'sourceCount':count,'alerts':decorate(alerts,codes,previous),'sourceFailures':failures,'coverage':coverage(codes)}
    except Exception as error:
        return {'ok': False, 'code': str(error) if isinstance(error, ValueError) and str(error).startswith('ALERT_SOURCE_') else 'ALERT_SOURCE_UNAVAILABLE'}


if __name__ == '__main__':
    import sys
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        packet = json.loads(sys.stdin.read(1_500_001))
        value = weather_alerts.invoke(packet)
    except Exception:
        value = {'ok': False, 'code': 'ALERT_INPUT_INVALID'}
    print(json.dumps(value, ensure_ascii=False, separators=(',', ':')))
