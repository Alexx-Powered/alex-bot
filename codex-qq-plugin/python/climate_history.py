"""Bounded ERA5 historical climate cache, separate from semantic knowledge.

Source: ECMWF/Copernicus ERA5 via Open-Meteo Archive API, not CMA station
observations. Queries read cached monthly statistics; only an operator worker
fetches history. Neither weather forecasts nor route-safety decisions live here.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta, timezone
import calendar
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Literal
from urllib.parse import urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
import uuid

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field

ARCHIVE='https://archive-api.open-meteo.com/v1/archive'
SOURCE={'provider':'Open-Meteo','model':'ERA5','kind':'reanalysis','upstream':'ECMWF/Copernicus',
        'url':'https://open-meteo.com/en/docs/historical-weather-api',
        'dataset':'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels',
        'reference_period_convention_url':'https://www.cma.gov.cn/zfxxgk/gknr/qxbg/202503/W020250302606211127018.pdf',
        'is_cma_station_observation':False,'availability_lag_days':5,'query_safety_lag_days':7,
        'preliminary_release_may_be_revised_months':3}
FIELDS=('temperature_2m_mean','precipitation_sum','wind_speed_10m_max')
TZ=timezone(timedelta(hours=8))
MAX_DATABASE_BYTES=32*1024*1024
TTL_SECONDS=30*86400
LEASE_SECONDS=90
BACKOFF_SECONDS=3600
MAX_REFRESH_ATTEMPTS=3


class ClimateError(ValueError):pass


def finite(value,minimum,maximum):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not minimum<=value<=maximum:
        raise ClimateError('CLIMATE_INVALID_NUMBER')
    return float(value)


@dataclass(frozen=True)
class ClimateLocation:
    place_id:str
    latitude:float
    longitude:float
    timezone:str='Asia/Shanghai'

    def __post_init__(self):
        if not isinstance(self.place_id,str) or re.fullmatch(r'[A-Za-z0-9_.:-]{1,100}',self.place_id) is None:
            raise ClimateError('CLIMATE_INVALID_PLACE')
        object.__setattr__(self,'latitude',finite(self.latitude,-90,90))
        object.__setattr__(self,'longitude',finite(self.longitude,-180,180))
        if self.timezone not in ('Asia/Shanghai','UTC'):raise ClimateError('CLIMATE_INVALID_TIMEZONE')


def iso(value):
    return datetime.fromtimestamp(value,TZ).isoformat(timespec='seconds') if value is not None else None


def validate_period(start_year,end_year,now):
    latest=latest_available_year(now)
    if any(isinstance(y,bool) or not isinstance(y,int) for y in (start_year,end_year)) or not 1940<=start_year<=end_year<=latest or end_year-start_year>=40:
        raise ClimateError('CLIMATE_INVALID_PERIOD')


def latest_available_year(now):
    cutoff=(datetime.fromtimestamp(now,timezone.utc)-timedelta(days=7)).date()
    return cutoff.year if (cutoff.month,cutoff.day)==(12,31) else cutoff.year-1


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ClimateError('CLIMATE_REDIRECT_DENIED')


def fetch_archive_year(location,year):
    """Fixed-host, single-year download; caller has already checked complete years."""
    query={'latitude':location.latitude,'longitude':location.longitude,'start_date':f'{year}-01-01',
        'end_date':f'{year}-12-31','daily':','.join(FIELDS),'models':'era5',
        'timezone':location.timezone,'temperature_unit':'celsius','wind_speed_unit':'ms',
        'precipitation_unit':'mm','cell_selection':'nearest','elevation':'nan'}
    url=ARCHIVE+'?'+urlencode(query)
    request=Request(url,headers={'User-Agent':'AlexBot-Climate/1.0','Accept-Encoding':'identity'})
    with build_opener(NoRedirect()).open(request,timeout=20) as response:
        raw=response.read(1024*1024+1)
    if len(raw)>1024*1024:raise ClimateError('CLIMATE_RESPONSE_TOO_LARGE')
    try:return json.loads(raw)
    except (ValueError,UnicodeError):raise ClimateError('CLIMATE_INVALID_RESPONSE') from None


def aggregate_year(payload,location,year):
    if not isinstance(payload,dict) or payload.get('error'):raise ClimateError('CLIMATE_INVALID_RESPONSE')
    lat=finite(payload.get('latitude'),-90,90);lon=finite(payload.get('longitude'),-180,180)
    if abs(lat-location.latitude)>1 or min(abs(lon-location.longitude),360-abs(lon-location.longitude))>1:
        raise ClimateError('CLIMATE_WRONG_LOCATION')
    expected_offset=28800 if location.timezone=='Asia/Shanghai' else 0
    if payload.get('utc_offset_seconds')!=expected_offset:raise ClimateError('CLIMATE_WRONG_TIMEZONE')
    units=payload.get('daily_units',{})
    if any(units.get(key)!=unit for key,unit in zip(FIELDS,('°C','mm','m/s'))):
        raise ClimateError('CLIMATE_UNEXPECTED_UNITS')
    daily=payload.get('daily')
    if not isinstance(daily,dict):raise ClimateError('CLIMATE_INVALID_RESPONSE')
    expected=[(date(year,1,1)+timedelta(days=i)).isoformat() for i in range(366 if calendar.isleap(year) else 365)]
    if daily.get('time')!=expected:raise ClimateError('CLIMATE_INCOMPLETE_DATES')
    bounds=((-100,70),(0,3000),(0,150))
    values={}
    for key,(minimum,maximum) in zip(FIELDS,bounds):
        seq=daily.get(key)
        if not isinstance(seq,list) or len(seq)!=len(expected):raise ClimateError('CLIMATE_INVALID_RESPONSE')
        values[key]=[None if v is None else finite(v,minimum,maximum) for v in seq]
    result=[]
    for month in range(1,13):
        indices=[i for i,stamp in enumerate(expected) if int(stamp[5:7])==month]
        count=len(indices)
        sequences={key:[values[key][i] for i in indices if values[key][i] is not None] for key in FIELDS}
        t,p,w=(sequences[key] for key in FIELDS)
        result.append({'year':year,'month':month,'expected_days':count,
            'valid_days':{key:len(sequences[key]) for key in FIELDS},
            'temperature_mean_c':sum(t)/len(t) if len(t)>=math.ceil(count*.9) else None,
            # Never scale a partial precipitation total to a whole month.
            'precipitation_mm':sum(p) if len(p)==count else None,
            'wet_days_ge_1mm':sum(v>=1 for v in p) if len(p)==count else None,
            'wind_daily_max_mean_ms':sum(w)/len(w) if len(w)>=math.ceil(count*.9) else None})
    if not any(row['temperature_mean_c'] is not None for row in result):raise ClimateError('CLIMATE_NO_VALID_DATA')
    return result,{'latitude':lat,'longitude':lon,'elevation':payload.get('elevation'),'elevation_downscaling':False}


def trend(rows,field):
    pairs=[(row['year'],row[field]) for row in rows if row[field] is not None]
    if len(pairs)<10:return None
    xm=sum(x for x,y in pairs)/len(pairs);ym=sum(y for x,y in pairs)/len(pairs)
    denominator=sum((x-xm)**2 for x,y in pairs)
    if denominator==0:return None
    return {'per_decade':round(10*sum((x-xm)*(y-ym) for x,y in pairs)/denominator,4),
        'sample_years':len(pairs),'method':'ordinary_least_squares_descriptive_only','first_year':min(x for x,y in pairs),
        'last_year':max(x for x,y in pairs),'is_forecast':False,'significance_tested':False}


class ClimateHistory:
    def __init__(self,path,clock=time.time,fetcher=None,*,ttl=TTL_SECONDS):
        self.path=Path(path).absolute();self.clock=clock;self.fetcher=fetcher or fetch_archive_year
        self.ttl=finite(ttl,3600,366*86400)

    @contextmanager
    def _db(self,write=False):
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        if self.path.is_symlink() or self.path.parent.is_symlink():raise ClimateError('CLIMATE_UNSAFE_PATH')
        if self.path.exists() and (not self.path.is_file() or self.path.stat().st_size>MAX_DATABASE_BYTES):
            raise ClimateError('CLIMATE_STORE_CAPACITY')
        if not self.path.exists():
            try:
                fd=os.open(self.path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
            except FileExistsError:pass
        c=sqlite3.connect(self.path,timeout=1);c.row_factory=sqlite3.Row
        try:
            c.execute('PRAGMA journal_mode=DELETE');c.execute('PRAGMA busy_timeout=1000')
            size=c.execute('PRAGMA page_size').fetchone()[0]
            c.execute('PRAGMA max_page_count='+str(MAX_DATABASE_BYTES//size))
            version=c.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0,1):raise ClimateError('CLIMATE_SCHEMA_VERSION')
            c.executescript('''CREATE TABLE IF NOT EXISTS climate_places(place_id TEXT PRIMARY KEY,definition TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS climate_years(place_id TEXT NOT NULL,year INTEGER NOT NULL,
                    payload TEXT NOT NULL,grid TEXT NOT NULL,fetched_at REAL NOT NULL,error_code TEXT,
                    PRIMARY KEY(place_id,year));
                CREATE TABLE IF NOT EXISTS climate_refresh(place_id TEXT PRIMARY KEY,lease_id TEXT,
                    lease_until REAL NOT NULL,next_attempt REAL NOT NULL,last_error TEXT);
                CREATE TABLE IF NOT EXISTS climate_failures(place_id TEXT NOT NULL,year INTEGER NOT NULL,
                    attempts INTEGER NOT NULL,next_attempt REAL NOT NULL,error_code TEXT NOT NULL,
                    PRIMARY KEY(place_id,year));
                PRAGMA user_version=1;''')
            if write:c.execute('BEGIN IMMEDIATE')
            yield c
            if write:c.commit()
        except Exception:c.rollback();raise
        finally:c.close()

    def _place(self,c,location):
        definition=json.dumps(asdict(location),sort_keys=True)
        row=c.execute('SELECT definition FROM climate_places WHERE place_id=?',(location.place_id,)).fetchone()
        if row and row[0]!=definition:raise ClimateError('CLIMATE_PLACE_CHANGED')
        if not row:
            if c.execute('SELECT COUNT(*) FROM climate_places').fetchone()[0]>=64:raise ClimateError('CLIMATE_PLACE_CAPACITY')
            c.execute('INSERT INTO climate_places VALUES(?,?)',(location.place_id,definition))

    def refresh(self,location,start_year=1991,end_year=2020,max_years=2):
        now=finite(self.clock(),0,9e12);validate_period(start_year,end_year,now)
        if isinstance(max_years,bool) or not isinstance(max_years,int) or not 1<=max_years<=3:
            raise ClimateError('CLIMATE_BACKFILL_LIMIT')
        lease=uuid.uuid4().hex
        with self._db(True) as c:
            self._place(c,location)
            previous=c.execute('SELECT * FROM climate_refresh WHERE place_id=?',(location.place_id,)).fetchone()
            if previous and previous['lease_until']>now:return {'status':'busy','refreshed_years':[]}
            if previous and previous['next_attempt']>now:return {'status':'backoff','refreshed_years':[],'error_code':previous['last_error']}
            stored={r['year']:dict(r) for r in c.execute('SELECT * FROM climate_years WHERE place_id=?',(location.place_id,))}
            failures={r['year']:dict(r) for r in c.execute('SELECT * FROM climate_failures WHERE place_id=?',(location.place_id,))}
            needed=[year for year in range(start_year,end_year+1) if year not in stored or stored[year]['error_code'] or
                stored[year]['fetched_at']>now or now-stored[year]['fetched_at']>=self.ttl]
            blocked=[year for year in needed if failures.get(year,{}).get('attempts',0)>=MAX_REFRESH_ATTEMPTS]
            todo=[year for year in needed if year not in blocked and failures.get(year,{}).get('next_attempt',0)<=now]
            # Untested years progress even if one historical slice is unavailable.
            todo.sort(key=lambda year:(failures.get(year,{}).get('attempts',0)>0,
                year in stored,stored.get(year,{}).get('fetched_at',0),year))
            if not todo:return {'status':'cached' if not needed else 'needs_attention' if blocked else 'backoff',
                'refreshed_years':[],'remaining_years':len(needed),'blocked_years':blocked}
            c.execute('INSERT OR REPLACE INTO climate_refresh VALUES(?,?,?,?,NULL)',(location.place_id,lease,now+LEASE_SECONDS,0))
        completed=[];error=None
        try:
            for year in todo[:max_years]:
                payload,grid=aggregate_year(self.fetcher(location,year),location,year)
                if stored:
                    reference_grid=json.loads(next(iter(stored.values()))['grid'])
                    if any(abs(grid[key]-reference_grid[key])>1e-6 for key in ('latitude','longitude')):
                        raise ClimateError('CLIMATE_GRID_CHANGED')
                timestamp=finite(self.clock(),0,9e12)
                with self._db(True) as c:
                    current=c.execute('SELECT * FROM climate_refresh WHERE place_id=?',(location.place_id,)).fetchone()
                    if not current or current['lease_id']!=lease or current['lease_until']<=timestamp:raise ClimateError('CLIMATE_LEASE_LOST')
                    old=stored.get(year)
                    if old:
                        old_months={row['month']:row for row in json.loads(old['payload'])}
                        if any(row['valid_days'][field]<old_months[row['month']]['valid_days'][field]
                               for row in payload for field in FIELDS):
                            raise ClimateError('CLIMATE_COVERAGE_REGRESSION')
                    c.execute('INSERT OR REPLACE INTO climate_years VALUES(?,?,?,?,?,NULL)',
                        (location.place_id,year,json.dumps(payload),json.dumps(grid),timestamp))
                    c.execute('DELETE FROM climate_failures WHERE place_id=? AND year=?',(location.place_id,year))
                completed.append(year)
                stored[year]={'year':year,'payload':json.dumps(payload),'grid':json.dumps(grid),
                    'fetched_at':timestamp,'error_code':None}
        except Exception as exc:
            error=str(exc) if isinstance(exc,ClimateError) else 'CLIMATE_SOURCE_UNAVAILABLE'
            with self._db(True) as c:
                owned=c.execute('SELECT 1 FROM climate_refresh WHERE place_id=? AND lease_id=?',(location.place_id,lease)).fetchone()
                if owned:
                    c.execute('UPDATE climate_years SET error_code=? WHERE place_id=? AND year=?',(error,location.place_id,year))
                    old_failure=c.execute('SELECT attempts FROM climate_failures WHERE place_id=? AND year=?',(location.place_id,year)).fetchone()
                    attempts=min((old_failure['attempts'] if old_failure else 0)+1,MAX_REFRESH_ATTEMPTS)
                    c.execute('INSERT OR REPLACE INTO climate_failures VALUES(?,?,?,?,?)',
                        (location.place_id,year,attempts,finite(self.clock(),0,9e12)+BACKOFF_SECONDS*2**(attempts-1),error))
        finally:
            with self._db(True) as c:
                c.execute('''UPDATE climate_refresh SET lease_id=NULL,lease_until=0,next_attempt=?,last_error=?
                    WHERE place_id=? AND lease_id=?''',
                    (finite(self.clock(),0,9e12)+BACKOFF_SECONDS if error else 0,error,location.place_id,lease))
        return {'status':'partial' if (error or blocked) and completed else 'failed' if error else 'needs_attention' if blocked else 'ok',
            'refreshed_years':completed,'remaining_years':len(needed)-len(completed),'error_code':error,'blocked_years':blocked}

    def retry_failed(self,location,start_year=1991,end_year=2020):
        """Explicit operator action after examining errors; never called per watch tick."""
        now=finite(self.clock(),0,9e12);validate_period(start_year,end_year,now)
        with self._db(True) as c:
            self._place(c,location)
            lease=c.execute('SELECT lease_until FROM climate_refresh WHERE place_id=?',(location.place_id,)).fetchone()
            if lease and lease['lease_until']>now:raise ClimateError('CLIMATE_REFRESH_BUSY')
            count=c.execute('DELETE FROM climate_failures WHERE place_id=? AND year BETWEEN ? AND ?',
                (location.place_id,start_year,end_year)).rowcount
            c.execute('UPDATE climate_refresh SET next_attempt=0,last_error=NULL WHERE place_id=?',(location.place_id,))
            return count

    def normals(self,location,month=None,start_year=1991,end_year=2020):
        now=finite(self.clock(),0,9e12);validate_period(start_year,end_year,now)
        if month is not None and (isinstance(month,bool) or not isinstance(month,int) or not 1<=month<=12):
            raise ClimateError('CLIMATE_INVALID_MONTH')
        with self._db(True) as c:
            self._place(c,location)
            years=[dict(r) for r in c.execute('SELECT * FROM climate_years WHERE place_id=? AND year BETWEEN ? AND ? ORDER BY year',(location.place_id,start_year,end_year))]
            cached=c.execute('SELECT year,payload FROM climate_years WHERE place_id=?',(location.place_id,)).fetchall()
            latest_cached=max((r['year'] for r in cached),default=None)
            latest_complete_cached=max((r['year'] for r in cached if all(all(days==m['expected_days']
                for days in m['valid_days'].values()) for m in json.loads(r['payload']))),default=None)
            refresh=c.execute('SELECT last_error FROM climate_refresh WHERE place_id=?',(location.place_id,)).fetchone()
            blocked=[r['year'] for r in c.execute('SELECT year FROM climate_failures WHERE place_id=? AND year BETWEEN ? AND ? AND attempts>=? ORDER BY year',
                (location.place_id,start_year,end_year,MAX_REFRESH_ATTEMPTS))]
        expected=end_year-start_year+1;results=[]
        for selected in ([month] if month is not None else range(1,13)):
            samples=[row for year in years for row in json.loads(year['payload']) if row['month']==selected]
            metrics=('temperature_mean_c','precipitation_mm','wet_days_ge_1mm','wind_daily_max_mean_ms')
            valid={metric:[row[metric] for row in samples if row[metric] is not None] for metric in metrics}
            count=sum(all(row[metric] is not None for metric in metrics) for row in samples)
            expected_days=sum(calendar.monthrange(year,selected)[1] for year in range(start_year,end_year+1))
            coverage={field:round(sum(r['valid_days'][field] for r in samples)/expected_days,4) for field in FIELDS}
            row={'month':selected,'expected_years':expected,'valid_years':count,'coverage':round(count/expected,4),
                'metric_years':{metric:len(values) for metric,values in valid.items()},
                'sample_coverage':coverage,
                'complete':count==expected and all(value==1 for value in coverage.values()),
                **{metric:round(sum(values)/len(values),3) if values else None for metric,values in valid.items()},
                'trend':{'temperature_c':trend(samples,'temperature_mean_c'),'precipitation_mm':trend(samples,'precipitation_mm')},
                'years_present':[row['year'] for row in samples]}
            results.append(row)
        complete=all(row['complete'] for row in results)
        stale=any(year['error_code'] or now-year['fetched_at']>=self.ttl or year['fetched_at']>now for year in years)
        error=refresh['last_error'] if refresh else None
        return {'schema_version':'climate.normals.v1','status':'ok' if complete and not stale else 'partial' if years else 'unavailable',
            'place':asdict(location),'period':{'start_year':start_year,'end_year':end_year,'expected_years':expected,
                'available_years':len(years),'complete':complete,
                'kind':'standard_reference' if (start_year,end_year)==(1991,2020) else 'custom_history',
                'baseline_kind':('complete_reference_period' if complete else 'incomplete_sample')
                    if (start_year,end_year)==(1991,2020) else 'custom_history_sample'},
            'source':dict(SOURCE),'months':results,
            'freshness':{'state':'missing' if not years else 'stale' if stale else 'fresh',
                'fetched_at':iso(min(year['fetched_at'] for year in years)) if years else None,'refresh_error':error,
                'latest_complete_calendar_year':datetime.fromtimestamp(now,TZ).year-1,
                'latest_available_source_year':latest_available_year(now),'latest_cached_year':latest_cached,
                'latest_complete_cached_year':latest_complete_cached,
                'latest_year_present':latest_complete_cached is not None and latest_complete_cached>=latest_available_year(now),
                'blocked_years':blocked},
            'grid_points':[json.loads(year['grid']) for year in years[:1]],
            'missing_fields':(['reference_period_incomplete'] if not complete else [])+(['refresh_required'] if stale else [])+
                (['refresh_requires_operator_retry'] if blocked else []),
            'limitations':['历史再分析统计，不是出行日期天气预报，也不是中国气象站实测。',
                '代表网格平均条件，未按山峰或路线海拔降尺度，不能据此判断高山路线安全。',
                '趋势为样本期描述性拟合，未做显著性检验，不用于外推未来天气。']}

    def reference_and_recent(self,location,month=None):
        """Keep the standard baseline and post-2020 history as separate samples."""
        latest=latest_available_year(self.clock())
        return {'schema_version':'climate.comparison.v1','source':dict(SOURCE),
            'reference':self.normals(location,month,1991,2020),
            'recent':self.normals(location,month,2021,latest) if latest>=2021 else None}


class ClimateNormalsArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    place_id:str=Field(min_length=1,max_length=100)
    month:int|None=Field(default=None,ge=1,le=12)
    period:Literal['1991-2020','recent10','since2021']='1991-2020'


def build_climate_normals_tool(service,locations):
    trusted=dict(locations)
    if any(key!=value.place_id or not isinstance(value,ClimateLocation) for key,value in trusted.items()):
        raise ClimateError('CLIMATE_INVALID_CATALOG')
    @tool('climate_normals',args_schema=ClimateNormalsArgs)
    def climate_normals(place_id:str,month:int|None=None,period:str='1991-2020')->dict:
        """读取已导入地点的历史月气候与样本趋势；不预测周末天气，不下载数据。"""
        location=trusted.get(place_id)
        if location is None:return {'schema_version':'climate.normals.v1','status':'unavailable','missing_fields':['trusted_location'],'source':dict(SOURCE)}
        latest=latest_available_year(service.clock())
        start,end=(1991,2020) if period=='1991-2020' else (2021,latest) if period=='since2021' else (latest-9,latest)
        return service.normals(location,month,start,end)
    return climate_normals


def run_refresh_loop(service,location,*,start_year=1991,end_year=2020,max_years=1,
                     interval_seconds=3600,max_runs=24,stop_event=None,on_result=None):
    """Operator lifecycle: bounded work per tick; interruptible waits, no thread per job.

    max_runs=0 explicitly requests continuous operation. No production timer is
    installed. A service supervisor may call this function or the CLI --watch.
    """
    finite(interval_seconds,60,7*86400)
    if isinstance(max_runs,bool) or not isinstance(max_runs,int) or not 0<=max_runs<=10000:
        raise ClimateError('CLIMATE_INVALID_WATCH_LIMIT')
    stop_event=stop_event or threading.Event()
    runs=0
    while not stop_event.is_set() and (max_runs==0 or runs<max_runs):
        target_end=latest_available_year(service.clock()) if end_year=='latest' else end_year
        result=service.refresh(location,start_year,target_end,max_years)
        runs+=1
        if on_result:on_result(result)
        if max_runs and runs>=max_runs:break
        if stop_event.wait(interval_seconds):break
    return runs
