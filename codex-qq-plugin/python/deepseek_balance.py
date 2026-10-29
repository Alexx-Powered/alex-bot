"""Owner-only balance data; never pass balances or API keys to a chat model."""
import json
import re
from datetime import datetime, timezone, timedelta
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError
from urllib.error import URLError
import ssl
import time

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('REDIRECT_DENIED')

def _fetch(key):
    req=Request('https://api.deepseek.com/user/balance',headers={'Authorization':'Bearer '+key,'Accept':'application/json'})
    with build_opener(NoRedirect()).open(req,timeout=8) as response:
        raw=response.read(65537)
        if len(raw)>65536:raise ValueError('OVERSIZE')
        return json.loads(raw)

def read_balance(key,fetch=_fetch):
    if not isinstance(key,str) or not re.fullmatch(r'\S{8,512}',key):return '尚未配置 DeepSeek API Key，请在本机配置页保存。'
    try:
        for attempt in range(2):
            try:
                data=fetch(key)
                break
            except HTTPError:
                raise  # Do not retry authentication errors or platform rate limits.
            except (URLError, OSError) as error:
                if attempt or isinstance(getattr(error,'reason',error),ssl.SSLCertVerificationError):raise
                time.sleep(0.2)  # One recovery for this read-only GET, never a QQ send retry.
        if type(data.get('is_available')) is not bool or not isinstance(data.get('balance_infos'),list) or not 1<=len(data['balance_infos'])<=2:raise ValueError('INVALID_DATA')
        lines=['DeepSeek API 账户余额：']
        for row in data['balance_infos']:
            if row.get('currency') not in {'CNY','USD'}:raise ValueError('INVALID_CURRENCY')
            values=[row.get(k) for k in ['total_balance','granted_balance','topped_up_balance']]
            if any(not isinstance(v,str) or not re.fullmatch(r'-?\d{1,16}(?:\.\d{1,8})?',v) for v in values):raise ValueError('INVALID_AMOUNT')
            lines.append(f"可用 {values[0]} {row['currency']}（赠金 {values[1]}，充值余额 {values[2]}）")
        lines.append('可供 API 调用：'+('是' if data['is_available'] else '否'))
        lines.append('查询时间：'+datetime.now(timezone(timedelta(hours=8))).strftime('%m-%d %H:%M')+'（北京时间）')
        return '\n'.join(lines)
    except HTTPError as e:
        return 'DeepSeek 余额查询鉴权失败，请检查本机保存的 Key。' if e.code in {401,403} else 'DeepSeek 余额接口暂不可用，请稍后再试。'
    except Exception:return '暂时无法核实 DeepSeek 余额，请稍后再试。'
