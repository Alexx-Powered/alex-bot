"""Bounded BUAA query tool. Only classroom facts leave this process."""
from __future__ import annotations
import json
import re
import time
import hashlib
import sys
from datetime import date as Date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from typing import Annotated
from pydantic import BaseModel, ConfigDict, Field
from langchain_core.tools import tool

TZ=timezone(timedelta(hours=8))
PAGE='https://app.buaa.edu.cn/site/classRoomQuery/index'
INDEX_SUFFIX='/buaafreeclass/wap/default/index1'
SCHEMA='buaa-classrooms.v1'
NAME=re.compile(r'^[\w\u3400-\u9fff（）()· .-]{1,64}$')
CODES=frozenset({'OK','CAMPUS_NOT_CONFIGURED','CAMPUS_DISABLED','CAMPUS_CONFIG_UNAVAILABLE','CAMPUS_BUSY',
    'CAMPUS_INVALID_DATE','CAMPUS_AUTH_FAILED','CAMPUS_INTERACTION_REQUIRED','CAMPUS_NETWORK_ERROR',
    'CAMPUS_SCHEMA_CHANGED','CAMPUS_BROWSER_UNAVAILABLE','CAMPUS_QUERY_FAILED','CAMPUS_RENDER_FAILED',
    'CAMPUS_NAVIGATION_TIMEOUT','CAMPUS_LOGIN_TIMEOUT','CAMPUS_SEARCH_TIMEOUT','CAMPUS_INTERACTIVE_LOGIN_TIMEOUT','CAMPUS_LOGIN_ACTION_TIMEOUT'})

class CampusError(Exception):
    def __init__(self,code):self.code=code;super().__init__(code)

class CampusQueryArgs(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)
    date: Annotated[str,Field(max_length=10,pattern=r'^(?:\d{4}-\d{2}-\d{2})?$')]=''

def now():return datetime.now(TZ)

def query_day(value,clock=None):
    today=(clock or now()).date()
    if value=='':return today.isoformat()
    try:
        day=Date.fromisoformat(value)
        if day.isoformat()!=value or not today<=day<=today+timedelta(days=7):raise ValueError()
        return value
    except (ValueError,TypeError):raise CampusError('CAMPUS_INVALID_DATE') from None

def envelope(day='',code='OK',rooms=None,clock=None):
    records=rooms or []
    return {'schema_version':SCHEMA,'ok':code=='OK','code':code if code in CODES else 'CAMPUS_QUERY_FAILED',
        'campus':'学院路校区','date':day,'fetched_at':(clock or now()).isoformat(),
        'source':PAGE,'semantics':'接口标空闲则为空闲，其余课节为有课；保留接口给出的节次。',
        'buildings':list(dict.fromkeys(r['building'] for r in records)),'rooms':records}

def normalize(payload,day,clock=None):
    if not isinstance(payload,dict) or payload.get('e')!=0:raise CampusError('CAMPUS_AUTH_FAILED')
    data=payload.get('d')
    if not isinstance(data,dict) or 'list' not in data:raise CampusError('CAMPUS_SCHEMA_CHANGED')
    groups=data['list']
    if groups==[]:groups={}
    if not isinstance(groups,dict) or len(groups)>30:raise CampusError('CAMPUS_SCHEMA_CHANGED')
    rows=[];seen=set()
    for building,items in groups.items():
        if not isinstance(building,str) or not NAME.fullmatch(building):raise CampusError('CAMPUS_SCHEMA_CHANGED')
        if isinstance(items,dict):items=list(items.values())
        if not isinstance(items,list):raise CampusError('CAMPUS_SCHEMA_CHANGED')
        for row in items:
            if not isinstance(row,dict) or not isinstance(row.get('name'),str) or not NAME.fullmatch(row['name']) or not isinstance(row.get('kxsds'),str):raise CampusError('CAMPUS_SCHEMA_CHANGED')
            parts=row['kxsds'].split(',')
            if any(p.strip() and not re.fullmatch(r'(?:[1-9]|1[0-4])',p.strip()) for p in parts):raise CampusError('CAMPUS_SCHEMA_CHANGED')
            free=sorted({int(p) for p in parts if p.strip()})
            key=(building,row['name'])
            if key in seen or len(rows)>=600:raise CampusError('CAMPUS_SCHEMA_CHANGED')
            seen.add(key)
            rows.append({'building':building,'room':row['name'],'free_periods':free,
                'busy_periods':[p for p in range(1,15) if p not in free]})
    return envelope(day,rooms=rows,clock=clock)

def _safe_response(response):
    if not response.ok:raise CampusError('CAMPUS_NETWORK_ERROR')
    if len(response.body())>2_000_000:raise CampusError('CAMPUS_SCHEMA_CHANGED')
    try:return response.json()
    except ValueError:raise CampusError('CAMPUS_AUTH_FAILED') from None

def login_failure(frame):
    """Login redirects can detach/destroy an iframe between these observations."""
    from playwright.sync_api import Error as BrowserError
    try:
        text=frame.locator('body').inner_text(timeout=2000)
        if re.search('密码错误|用户名或密码错误|账号或密码错误|账户被锁定',text):return 'CAMPUS_AUTH_FAILED'
        if frame.locator('#cptPassword').is_visible():return 'CAMPUS_INTERACTION_REQUIRED'
    except BrowserError:
        # A changing document is not an authentication or network failure.
        # The bounded outer loop waits for the actual classroom response.
        return None
    return None

def browser_collect(credentials,private_root,day,*,interactive=False,session_state=None,on_session=None):
    from playwright.sync_api import sync_playwright
    initial={}
    def capture(response):
        u=urlsplit(response.url)
        if u.scheme!='https' or u.hostname!='app.buaa.edu.cn' or not u.path.endswith(INDEX_SUFFIX):return
        try:
            body=_safe_response(response)
            if body.get('e')==0 and isinstance(body.get('d',{}).get('xqs'),list):
                initial.update(payload=body,endpoint=urlunsplit((u.scheme,u.netloc,u.path,'','')))
        except Exception:pass
    def allow_school(route):
        u=urlsplit(route.request.url)
        if u.scheme=='https' and (u.hostname=='buaa.edu.cn' or (u.hostname or '').endswith('.buaa.edu.cn')):route.continue_()
        else:route.abort()
    context=None;browser=None;phase='browser_start'
    try:
        with sync_playwright() as p:
            try:
                identity=hashlib.sha256((credentials['username']+'\0'+credentials['password']).encode()).hexdigest()[:24]
                if sys.platform=='win32':
                    context=p.chromium.launch_persistent_context(str(Path(private_root)/'campus-browser'/identity),
                        headless=not interactive,channel='msedge',accept_downloads=False,
                        args=['--disable-save-password-bubble'])
                else:
                    browser=p.chromium.launch(headless=not interactive,args=['--disable-save-password-bubble'])
                    context=browser.new_context(accept_downloads=False,storage_state=session_state)
            except Exception:raise CampusError('CAMPUS_BROWSER_UNAVAILABLE') from None
            try:
                context.route('**/*',allow_school)
                page=context.new_page();page.on('response',capture)
                phase='navigate'
                page.goto(PAGE,wait_until='domcontentloaded',timeout=25000)
                deadline=time.monotonic()+(150 if interactive else 40)
                submitted=False
                while not initial and time.monotonic()<deadline:
                    phase='login_frame'
                    for frame in page.frames:
                        u=urlsplit(frame.url)
                        if u.scheme!='https' or u.hostname!='sso.buaa.edu.cn':continue
                        account=frame.locator('#unPassword');secret=frame.locator('#pwPassword')
                        if not submitted and account.count()==1 and secret.count()==1 and account.is_visible():
                            captcha=frame.locator('#cptPassword')
                            if captcha.count() and captcha.is_visible():
                                if not interactive:raise CampusError('CAMPUS_INTERACTION_REQUIRED')
                                continue
                            # Values come only from the encrypted local store, never tool arguments.
                            phase='login_fill'
                            account.fill(credentials['username'],timeout=3000)
                            secret.fill(credentials['password'],timeout=3000)
                            submitted=True
                            phase='login_submit'
                            frame.locator('input[onclick="loginPassword()"]').click(timeout=3000)
                        if submitted and not interactive:
                            phase='login_result'
                            failure=login_failure(frame)
                            if failure:raise CampusError(failure)
                    page.wait_for_timeout(250)
                if not initial:raise CampusError('CAMPUS_INTERACTIVE_LOGIN_TIMEOUT' if interactive else 'CAMPUS_LOGIN_TIMEOUT')
                campuses=[x for x in initial['payload']['d']['xqs'] if x.get('name')=='学院路校区']
                if len(campuses)!=1 or 'xqid' not in campuses[0]:raise CampusError('CAMPUS_SCHEMA_CHANGED')
                url=initial['endpoint'].removesuffix('index1')+'search1'
                phase='classroom_search'
                response=context.request.get(url,params={'xqid':campuses[0]['xqid'],'floorid':'','date':day},
                    headers={'Referer':PAGE,'X-Requested-With':'XMLHttpRequest'},timeout=20000,max_redirects=0)
                try:
                    result=_safe_response(response)
                    if on_session and result.get('e')==0:on_session(context.storage_state())
                    return result
                finally:response.dispose()
            finally:
                context.close()
                if browser:browser.close()
    except CampusError:raise
    except Exception as error:
        from timeout_errors import is_timeout
        if is_timeout(error):
            raise CampusError('CAMPUS_SEARCH_TIMEOUT' if phase=='classroom_search' else 'CAMPUS_NAVIGATION_TIMEOUT' if phase=='navigate' else 'CAMPUS_LOGIN_ACTION_TIMEOUT' if phase in {'login_fill','login_submit'} else 'CAMPUS_INTERACTIVE_LOGIN_TIMEOUT' if interactive else 'CAMPUS_LOGIN_TIMEOUT') from None
        # Sanitized local diagnostics only; never serialize SDK error text,
        # input values, requests, headers, page content or full URLs.
        network=re.search(r'net::(ERR_[A-Z_]{1,60})',str(error))
        kind=type(error).__name__
        detail={'phase':phase,'error_type':kind if re.fullmatch(r'[A-Za-z_]{1,50}',kind) else 'Error',
            'network_code':network.group(1) if network else None}
        try:
            output=Path(private_root)/'campus-output';output.mkdir(parents=True,exist_ok=True)
            (output/'diagnostic.json').write_text(json.dumps(detail),encoding='utf-8')
        except OSError:pass
        raise CampusError('CAMPUS_NETWORK_ERROR') from None

def build_query_tool(credentials,private_root,*,collector=browser_collect,clock=now,interactive=False):
    @tool('buaa_classroom_query',args_schema=CampusQueryArgs,return_direct=True)
    def query(date:str='')->dict:
        """仅查询北航学院路校区全部教学楼课节。date为空查今天，或未来7天ISO日期。固定返回buaa-classrooms.v1 JSON；空闲以接口kxsds为准，其余课节为有课。凭据由本机绑定，不接受账号、密码、URL或文件路径。"""
        day=''
        try:
            day=query_day(date,clock())
            if not isinstance(credentials,dict) or not credentials.get('username') or not credentials.get('password'):raise CampusError('CAMPUS_NOT_CONFIGURED')
            if credentials.get('enabled') is not True:raise CampusError('CAMPUS_DISABLED')
            payload=collector(credentials,private_root,day,interactive=interactive)
            return normalize(payload,day,clock())
        except CampusError as e:return envelope(day,e.code,clock=clock())
        except Exception:return envelope(day,'CAMPUS_QUERY_FAILED',clock=clock())
    return query
