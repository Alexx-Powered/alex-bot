"""Use the existing OS proxy just as the read-only urllib tools do."""
from urllib.request import getproxies, proxy_bypass
from urllib.parse import urlsplit
import httpx

_client = None
_proxy_key = None

def get_model_http_client():
    global _client, _proxy_key
    settings=getproxies()
    proxy=None if proxy_bypass('api.deepseek.com') else settings.get('https') or settings.get('http')
    if proxy and '://' not in proxy:proxy='http://'+proxy
    if proxy and (urlsplit(proxy).scheme not in {'http','https'} or not urlsplit(proxy).hostname):
        raise ValueError('MODEL_PROXY_CONFIG_UNSUPPORTED')
    if _client is None or _client.is_closed or proxy!=_proxy_key:
        if _client is not None:_client.close()
        _client=httpx.Client(proxy=proxy,trust_env=False,timeout=20)
        _proxy_key=proxy
    return _client
