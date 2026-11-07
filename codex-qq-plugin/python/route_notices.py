"""Dated, curated route notices; informational only, never a weather gate.

This reads bundled research, not model-supplied URLs or a live access registry.
An official announcement and its applicability are retained separately from a
claim that a route is currently open. Weather permissions remain with the host.
"""
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
import re
import time
import unicodedata
from urllib.parse import urlsplit

FILES = ('route-notices-west-20261106.json', 'route-notices-plateau-20261106.json',
         'route-notices-east-20261106.json')
STATUSES = {'prohibited', 'restricted', 'seasonal_closure', 'open', 'unknown'}
TZ = timezone(timedelta(hours=8))


def clean(value, maximum, *, empty=False):
    if not isinstance(value, str) or len(value)>maximum or (not empty and not value.strip()):
        raise ValueError('ROUTE_NOTICE_INVALID')
    if any(unicodedata.category(c) in {'Cc','Cf','Cs'} for c in value):
        raise ValueError('ROUTE_NOTICE_INVALID')
    return value.strip()


def day(value, *, nullable=False):
    if value is None and nullable: return None
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',value):
        raise ValueError('ROUTE_NOTICE_INVALID_DATE')
    return date.fromisoformat(value)


def safe_source(value):
    value=clean(value,240)
    parsed=urlsplit(value)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or any(c.isspace() for c in value):
        raise ValueError('ROUTE_NOTICE_INVALID_SOURCE')
    return value


def normalized(value):
    return re.sub(r'[\s·（）()\-_/]', '', unicodedata.normalize('NFKC',value)).lower()


class RouteNoticeCatalog:
    def __init__(self, rows=(), *, clock=time.time):
        if not isinstance(rows,(list,tuple)) or len(rows)>128:
            raise ValueError('ROUTE_NOTICE_CAPACITY')
        self.clock=clock
        self.rows=[]
        for original in rows:
            if not isinstance(original,dict): raise ValueError('ROUTE_NOTICE_INVALID')
            row={key:clean(original.get(key),limit) for key,limit in (
                ('route_id',80),('route_name',80),('statement',260),('scope',320),
                ('issuer',120),('publisher',120))}
            if not re.fullmatch(r'[a-z0-9_-]+',row['route_id']): raise ValueError('ROUTE_NOTICE_INVALID_ID')
            row['family_id']=clean(original.get('family_id',row['route_id']),80)
            if not re.fullmatch(r'[a-z0-9_-]+',row['family_id']): raise ValueError('ROUTE_NOTICE_INVALID_ID')
            row['status']=original.get('status')
            if row['status'] not in STATUSES: raise ValueError('ROUTE_NOTICE_INVALID_STATUS')
            aliases=original.get('aliases',[])
            if not isinstance(aliases,list) or len(aliases)>24: raise ValueError('ROUTE_NOTICE_INVALID')
            row['aliases']=[clean(value,80) for value in aliases]
            family_aliases=original.get('family_aliases',[])
            if not isinstance(family_aliases,list) or len(family_aliases)>24: raise ValueError('ROUTE_NOTICE_INVALID')
            row['family_aliases']=[clean(value,80) for value in family_aliases]
            for key in ('published_at','checked_at'):
                row[key]=day(original.get(key)).isoformat()
            for key in ('effective_from','effective_until'):
                stamp=day(original.get(key),nullable=True)
                row[key]=stamp.isoformat() if stamp else None
            if row['effective_from'] and row['effective_until'] and row['effective_from']>row['effective_until']:
                raise ValueError('ROUTE_NOTICE_INVALID_DATE')
            if row['published_at']>row['checked_at']: raise ValueError('ROUTE_NOTICE_INVALID_DATE')
            row['source_url']=safe_source(original.get('source_url'))
            if type(original.get('primary_source')) is not bool: raise ValueError('ROUTE_NOTICE_INVALID')
            row['primary_source']=original['primary_source']
            row['confidence_notes']=clean(original.get('confidence_notes',''),1200,empty=True)
            self.rows.append(row)

    def lookup(self,destination_id,label,*,start_date,end_date,route_variant=None):
        """Return one dated notice, not a verdict or a tool execution decision."""
        start,end=day(start_date),day(end_date)
        today=datetime.fromtimestamp(self.clock(),TZ).date()
        label=normalized(label).removesuffix('代表点').removesuffix('景区代表坐标')
        available=[row for row in self.rows if day(row['checked_at'])<=today]
        def named(row,name):
            return any(name==normalized(alias) for alias in [row['route_name'],*row['aliases']])
        bound=[row for row in available if destination_id in {row['route_id'],row['family_id']} or
               named(row,label) or any(label==normalized(alias) for alias in row['family_aliases'])]
        families={row['family_id'] for row in bound}
        specific=[row for row in available if route_variant and row['family_id'] in families and
                  named(row,normalized(route_variant))]
        exact_scope=[row for row in bound if row['route_id']==destination_id and row['route_id']!=row['family_id']]
        # A named branch is more specific than a newer notice for the whole area.
        # Family membership is curated, never guessed from a text substring.
        candidates=specific or exact_scope or [row for row in bound if row['route_id']==destination_id or named(row,label)]
        if not candidates: return None
        # Pick the newest published record; never infer an opening from absence.
        # Older records remain in the searchable corpus for historical questions.
        row=max(candidates,key=lambda value:(value['published_at'],value['checked_at']))
        began=day(row['effective_from'],nullable=True)
        ended=day(row['effective_until'],nullable=True)
        relation='reported_notice'
        if ended and start>ended: relation='historical'
        elif began and end<began: relation='future'
        elif ended and end>ended: relation='partial_period'
        elif began and start<began: relation='partial_period'
        elif began: relation='within_reported_period'
        return {**row,'period_relation':relation,
                'review_due':(today-day(row['checked_at'])).days>7,
                'current_access_verified':False,'blocks_weather':False}


def bundled_route_notices(*,clock=time.time):
    rows=[]
    root=Path(__file__).resolve().parents[1]/'data'
    for filename in FILES:
        path=root/filename
        if not path.exists(): continue
        if path.stat().st_size>300000: raise ValueError('ROUTE_NOTICE_CAPACITY')
        payload=json.loads(path.read_text(encoding='utf-8'))
        if payload.get('schema_version')!='outdoor.notices.research.v1' or not isinstance(payload.get('notices'),list):
            raise ValueError('ROUTE_NOTICE_INVALID')
        rows.extend(payload['notices'])
    return RouteNoticeCatalog(rows,clock=clock)


def notice_sentence(notice):
    """One short attributed sentence; no refusal, moralizing or inferred status."""
    if not notice: return '官方开放信息暂未核实。'
    statement=notice['statement'].rstrip('。；; ').replace('。','；').removeprefix('官方提示')
    notes=[notice['published_at']]
    if not notice['primary_source']: notes.append('转载/转述')
    if notice['period_relation']=='historical' and '已结束' not in statement: notes.append('所列时段已结束')
    if notice['period_relation']=='future': notes.append('行程早于生效日')
    if notice['period_relation']=='partial_period': notes.append('只涉及部分行程日期')
    if notice.get('review_due'): notes.append('待复核更新')
    return f"官方提示：{statement}（{'，'.join(notes)}）。"
