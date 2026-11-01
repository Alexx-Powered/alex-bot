"""Read only fixed official status feeds; no model credentials or arbitrary URLs."""
import json
import re
import time
from datetime import datetime, timezone, timedelta
from urllib.request import Request, build_opener, HTTPRedirectHandler

ORIGIN = 'https://status.openai.com'
_cache = None

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('STATUS_REDIRECT_DENIED')

def _fetch(path):
    with build_opener(NoRedirect()).open(Request(ORIGIN+path, headers={'User-Agent':'AlexQQ-status/1.0','Accept':'application/json'}), timeout=6) as response:
        raw=response.read(1048577)
        if len(raw)>1048576: raise ValueError('STATUS_TOO_LARGE')
        return json.loads(raw)

def _text(value, limit=700):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', str(value or ''))[:limit]

def read_status(scope='all', query='', fetch=_fetch, now=None, include_recent=False):
    global _cache
    if scope not in {'all','codex','chatgpt','api'}: raise ValueError('INVALID_SCOPE')
    instant=now or datetime.now(timezone.utc)
    checked=instant.astimezone(timezone(timedelta(hours=8))).isoformat(timespec='seconds')
    try:
        if fetch is _fetch and _cache and 0<=time.monotonic()-_cache[0]<60:
            summary, feed, checked=_cache[1:]
        else:
            summary,feed=fetch('/api/v2/summary.json'),fetch('/api/v2/incidents.json')
            if not isinstance(summary.get('components'),list) or not isinstance(summary.get('status'),dict) or not isinstance(feed.get('incidents'),list):raise ValueError('INVALID_FEED')
            if fetch is _fetch:_cache=(time.monotonic(),summary,feed,checked)
        components=[{'name':_text(c.get('name'),100),'status':_text(c.get('status'),50)} for c in summary['components'][:100] if isinstance(c,dict)]
        selected=[c for c in components if scope=='all' or scope in c['name'].lower() or (scope=='api' and c['name'] in {'Responses','Chat Completions','Login'})]
        key=re.sub(r'[\W_]+','',query.casefold())[:100]
        active,recent=[],[]
        for item in feed['incidents'][:100]:
            if not isinstance(item,dict):continue
            record={k:_text(item.get(k),200) for k in ['name','status','updated_at','resolved_at']}
            record['updates']=[{'status':_text(u.get('status'),50),'body':_text(u.get('body')),'at':_text(u.get('display_at') or u.get('created_at'),60)} for u in item.get('incident_updates',[])[:2] if isinstance(u,dict)]
            record['url']=ORIGIN
            if record['status'] not in {'resolved','completed'}:active.append(record)
            else:
                try: age=(instant-datetime.fromisoformat((record['resolved_at'] or record['updated_at']).replace('Z','+00:00'))).total_seconds()
                except (ValueError,TypeError):continue
                if 0<=age<=7*86400:recent.append(record)
        if key:
            recent=[e for e in recent if key in re.sub(r'[\W_]+','',e['name'].casefold())]
        elif not include_recent:
            recent=[]
        return {'available':True,'checked_at':checked,'source':ORIGIN,'scope':scope,'global_status':summary['status'],
                'components':selected[:30],'scope_component_found':bool(selected),'active_incidents':active[:8],
                'recent_resolved_incidents':recent[:5], 'limits':'全局聚合状态，不验证个人账号、额度、网络或特定模型权限；recent_resolved不是当前故障；checked_at是实际检查时间，page更新时间可能很早。'}
    except Exception as error:
        from timeout_errors import is_timeout
        return {'available':False,'checked_at':checked,'source':ORIGIN,'error':'OFFICIAL_STATUS_TIMEOUT' if is_timeout(error) else 'OFFICIAL_STATUS_UNAVAILABLE','instruction':'OpenAI官方状态接口响应超时（单次6秒时限），请稍后重试。' if is_timeout(error) else '本次无法核实官方状态，不得推断正常或故障；请稍后重试或打开官方状态页。'}
