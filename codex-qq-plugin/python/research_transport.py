"""Small public-web transport for bounded research jobs, never a general browser.

There are no redirects, proxy discovery, retries, script execution or link crawling.
HTTPS connects to a vetted DNS address while retaining the original TLS/SNI name.
The supervising job still needs a process deadline: OS DNS resolution itself is
not cancellable by Python's socket timeout.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from email.message import Message
from html import unescape
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import math
import re
import socket
import ssl
import time
from urllib.parse import urlencode, urlsplit
import xml.etree.ElementTree as ET


USER_AGENT = 'AlexBotResearch/1.0 (bounded public knowledge retrieval)'
PAGE_MAX_BYTES = 128 * 1024
SEARCH_MAX_BYTES = 256 * 1024
IMAGE_MAX_BYTES = 512 * 1024
DEFAULT_SOURCE_DOMAINS = frozenset({
    'sohu.com', 'ifeng.com', 'xinhuanet.com', 'people.com.cn', 'news.cn',
    'thepaper.cn', 'gmw.cn', 'ycwb.com',
    '8264.com', '2bulu.com', 'travelnews.qunar.com', 'hwtao.com',
    'mafengwo.cn', '360jlb.cn', 'outdoors.com.cn',
    'bbs.youxiake.com', 'columbiasports.cn',
})
_BAD_URL = re.compile(r'[\x00-\x20\x7f\\]')
_HOST_LABEL = re.compile(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z')


class ResearchTransportError(ValueError):
    """Only a bounded stable error code, never a response body or credential."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SearchHit:
    url: str
    title: str
    snippet: str = ''
    published_at: str | None = None


@dataclass(frozen=True)
class Page:
    url: str
    title: str
    text: str
    published_at: str | None = None


@dataclass(frozen=True)
class _Response:
    body: bytes
    content_type: str


def _url_target(url, *, allow_http=False):
    if not isinstance(url, str) or not 1 <= len(url) <= 2048 or _BAD_URL.search(url):
        raise ResearchTransportError('URL_NOT_ALLOWED')
    try:
        parsed = urlsplit(url)
        allowed_schemes = {'https', 'http'} if allow_http else {'https'}
        default_port = 80 if parsed.scheme == 'http' else 443
        if (parsed.scheme not in allowed_schemes or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.fragment or '#' in url
                or parsed.port not in {None, default_port} or '%' in parsed.netloc):
            raise ValueError()
        host = parsed.hostname.encode('idna').decode('ascii').lower()
        if len(host) > 253 or host.endswith('.') or '.' not in host:
            raise ValueError()
        if any(not _HOST_LABEL.fullmatch(label) for label in host.split('.')):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        # Reject legacy numeric IP syntax as well as ordinary IPv4/IPv6 literals.
        if all(re.fullmatch(r'(?:[0-9]+|0x[0-9a-f]+)', x) for x in host.split('.')):
            raise ValueError()
        target = parsed.path or '/'
        if not target.startswith('/'):
            raise ValueError()
        if parsed.query:
            target += '?' + parsed.query
        target.encode('ascii')  # callers must percent-encode non-ASCII paths
        return host, target, default_port
    except (ValueError, UnicodeError):
        raise ResearchTransportError('URL_NOT_ALLOWED') from None


def _url_parts(url):
    host, target, _ = _url_target(url)
    return host, target


def _public_addresses(host, *, port=443):
    if port not in {80, 443} or isinstance(port, bool):
        raise ResearchTransportError('URL_NOT_ALLOWED')
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ResearchTransportError('DNS_FAILED') from None
    if not addresses or len(addresses) > 64:
        raise ResearchTransportError('DNS_NOT_PUBLIC')
    for family, socktype, proto, _, sockaddr in addresses:
        try:
            address = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            raise ResearchTransportError('DNS_NOT_PUBLIC') from None
        if (family not in {socket.AF_INET, socket.AF_INET6} or socktype != socket.SOCK_STREAM
                or not address.is_global or address.is_multicast or address.is_unspecified
                or (isinstance(address, ipaddress.IPv6Address) and
                    (address.ipv4_mapped is not None or address.sixtofour is not None or address.teredo is not None))):
            raise ResearchTransportError('DNS_NOT_PUBLIC')
    # Validate the complete answer before choosing a single destination. No retry.
    return sorted(addresses, key=lambda row: row[0] != socket.AF_INET)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self._address = address
        self._connect_deadline = time.monotonic() + timeout

    def connect(self):
        family, socktype, proto, _, sockaddr = self._address
        raw = socket.socket(family, socktype, proto)
        try:
            raw.settimeout(_remaining(self._connect_deadline))
            raw.connect(sockaddr)  # Never resolve the hostname a second time.
            raw.settimeout(_remaining(self._connect_deadline))
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ResearchTransportError('HTTP_TIMEOUT')
    return remaining


def _deadline(timeout):
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= 30:
        raise ResearchTransportError('INVALID_TIMEOUT')
    return time.monotonic() + timeout


def _read(url, *, timeout, max_bytes, headers=None, method='GET', payload=None):
    deadline = _deadline(timeout)
    if max_bytes not in {PAGE_MAX_BYTES, SEARCH_MAX_BYTES} and not (method=='GET' and max_bytes==IMAGE_MAX_BYTES):
        raise ResearchTransportError('INVALID_RESPONSE_LIMIT')
    if method not in {'GET', 'POST'} or (method == 'GET' and payload is not None):
        raise ResearchTransportError('HTTP_METHOD_DENIED')
    if method == 'POST' and (not isinstance(payload, bytes) or not 1 <= len(payload) <= 4096):
        raise ResearchTransportError('HTTP_PAYLOAD_INVALID')
    host, target = _url_parts(url)
    address = _public_addresses(host)[0]
    connection = _PinnedHTTPSConnection(host, address, _remaining(deadline))
    request_headers = {'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', 'Connection': 'close',
                       'Accept': 'application/json, application/rss+xml, application/xml, text/html, text/plain'}
    request_headers.update(headers or {})
    response = None
    try:
        if method == 'GET':
            connection.request(method, target, headers=request_headers)
        else:
            connection.request(method, target, body=payload, headers=request_headers)
        if connection.sock is not None:
            connection.sock.settimeout(_remaining(deadline))
        response = connection.getresponse()
        if 300 <= response.status <= 399:
            raise ResearchTransportError('HTTP_REDIRECT_DENIED')
        if response.status != 200:
            code = f'HTTP_{response.status}' if response.status in {400, 401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504} else 'HTTP_FAILED'
            raise ResearchTransportError(code)
        if response.getheader('Content-Encoding', 'identity').strip().lower() not in {'', 'identity'}:
            raise ResearchTransportError('HTTP_ENCODING_DENIED')
        length = response.getheader('Content-Length')
        if length is not None:
            if not re.fullmatch(r'[0-9]{1,12}', length) or int(length) > max_bytes:
                raise ResearchTransportError('RESPONSE_TOO_LARGE')
        chunks, total = [], 0
        while True:
            if connection.sock is not None:
                connection.sock.settimeout(_remaining(deadline))
            else:
                _remaining(deadline)
            block = response.read1(min(16384, max_bytes + 1 - total))
            if not block:
                break
            total += len(block)
            if total > max_bytes:
                raise ResearchTransportError('RESPONSE_TOO_LARGE')
            chunks.append(block)
        _remaining(deadline)
        return _Response(b''.join(chunks), response.getheader('Content-Type', ''))
    except ResearchTransportError:
        raise
    except (TimeoutError, socket.timeout):
        raise ResearchTransportError('HTTP_TIMEOUT') from None
    except (OSError, http.client.HTTPException, ValueError):
        raise ResearchTransportError('HTTP_FAILED') from None
    finally:
        if response is not None:
            response.close()
        connection.close()


def _get(url, *, timeout, max_bytes, headers=None):
    return _read(url, timeout=timeout, max_bytes=max_bytes, headers=headers)


def _post_json(url, body, *, timeout, api_key):
    # Only these two operator-selected raw APIs can receive a bearer key.
    schemas = {
        'https://api.deepseek.com/v1/tools/search': {'query', 'count', 'need_content'},
        'https://api.deepseek.com/v1/tools/fetch': {'url'},
    }
    if url not in schemas or not isinstance(body, dict) or set(body) != schemas[url]:
        raise ResearchTransportError('SEARCH_API_REQUEST_DENIED')
    payload = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
    return _read(url, timeout=timeout, max_bytes=SEARCH_MAX_BYTES, method='POST', payload=payload,
                 headers={'Authorization':'Bearer ' + api_key, 'Content-Type':'application/json', 'Accept':'application/json'})


def _decode(response):
    message = Message()
    message['content-type'] = response.content_type
    charset = (message.get_content_charset() or '').lower()
    aliases = {'utf8':'utf-8', 'utf-8':'utf-8', 'utf-8-sig':'utf-8-sig',
               'gb2312':'gb18030', 'gbk':'gb18030', 'gb18030':'gb18030', 'ascii':'ascii'}
    if not charset:
        meta = re.search(br'<meta[^>]{0,512}charset\s*=\s*[\x22\x27]?([A-Za-z0-9_-]+)', response.body[:4096], re.I)
        charset = meta.group(1).decode('ascii').lower() if meta else 'utf-8-sig'
    if charset not in aliases:
        raise ResearchTransportError('TEXT_ENCODING_UNSUPPORTED')
    try:
        return response.body.decode(aliases[charset], errors='strict')
    except UnicodeError:
        raise ResearchTransportError('TEXT_DECODE_FAILED') from None


def _clean(text, limit):
    return re.sub(r'\s+', ' ', unescape(str(text))).strip()[:limit]


class _HTMLText(HTMLParser):
    SKIP = {'script', 'style', 'nav', 'footer', 'form', 'noscript', 'svg', 'iframe', 'template'}
    BLOCK = {'p', 'div', 'article', 'section', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'tr'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skipped = []
        self.in_title = False
        self.title = []
        self.parts = []
        self.published_at = None

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipped.append(tag)
        if self.skipped:
            return
        if tag == 'title':
            self.in_title = True
        if tag in self.BLOCK:
            self.parts.append('\n')
        if tag == 'meta':
            values = dict(attrs)
            kind = (values.get('property') or values.get('name') or '').lower()
            if kind in {'article:published_time', 'date', 'pubdate', 'publishdate'}:
                candidate = _clean(values.get('content') or '', 64)
                if re.match(r'^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s].*)?$', candidate):
                    self.published_at = self.published_at or candidate

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.skipped:
            if tag in self.skipped:
                reverse_index = len(self.skipped) - 1 - self.skipped[::-1].index(tag)
                self.skipped = self.skipped[:reverse_index]
            return
        if tag == 'title':
            self.in_title = False
        if tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if self.skipped:
            return
        if self.in_title:
            self.title.append(data)
        else:
            self.parts.append(data)

    def result(self):
        lines = [_clean(line, PAGE_MAX_BYTES) for line in ''.join(self.parts).splitlines()]
        return _clean(''.join(self.title), 240), '\n'.join(line for line in lines if line), self.published_at


def _parse_page(hit, response):
    media_type = response.content_type.split(';', 1)[0].strip().lower()
    if media_type not in {'text/html', 'application/xhtml+xml', 'text/plain'}:
        raise ResearchTransportError('PAGE_TYPE_UNSUPPORTED')
    text = _decode(response)
    if media_type == 'text/plain':
        return Page(hit.url, hit.title, text.strip())
    parser = _HTMLText()
    try:
        parser.feed(text)
        parser.close()
    except Exception:
        raise ResearchTransportError('HTML_PARSE_FAILED') from None
    title, body, published = parser.result()
    if not body:
        raise ResearchTransportError('PAGE_EMPTY')
    return Page(hit.url, title or hit.title, body, published)


def _search_input(query, limit):
    if (not isinstance(query, str) or not 1 <= len(query.strip()) <= 200
            or any(ord(c) < 32 for c in query) or isinstance(limit, bool)
            or not isinstance(limit, int) or not 1 <= limit <= 4):
        raise ResearchTransportError('SEARCH_INPUT_INVALID')
    return query.strip()


def _hit(url, title, snippet=''):
    try:
        _url_parts(url)
    except ResearchTransportError:
        return None
    return SearchHit(url, _clean(title, 240), _clean(snippet, 600))


def _proxy_hit(url, title, snippet=''):
    """HTTP may be submitted only to the fixed HTTPS Fetch API, never _get()."""
    try:
        # Search providers append fragment IDs to ordinary article links. The
        # fragment never participates in an HTTP request; discard only that
        # component, then apply the complete original authority validation.
        if not isinstance(url,str) or len(url)>2048 or _BAD_URL.search(url):return None
        url=url.split('#',1)[0]
        _url_target(url, allow_http=True)
    except ResearchTransportError:
        return None
    return SearchHit(url, _clean(title, 240), _clean(snippet, 600))


def _parse_bing_rss(response, limit=4):
    raw = response.body
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', raw, re.I):
        raise ResearchTransportError('XML_ENTITY_DENIED')
    try:
        root = ET.fromstring(raw)
    except (ET.ParseError, ValueError):
        raise ResearchTransportError('SEARCH_PARSE_FAILED') from None
    if root.tag.lower() != 'rss':
        raise ResearchTransportError('SEARCH_PARSE_FAILED')
    result, seen = [], set()
    for item in root.findall('./channel/item')[:20]:
        hit = _hit(item.findtext('link', ''), item.findtext('title', ''), item.findtext('description', ''))
        if hit is not None and hit.url not in seen:
            result.append(hit)
            seen.add(hit.url)
            if len(result) >= limit:
                break
    return result


class _SourceFetcher:
    def __init__(self, *, allowed_domains=()):
        domains = set(DEFAULT_SOURCE_DOMAINS)
        if not isinstance(allowed_domains, (tuple, list, set, frozenset)) or len(allowed_domains) > 64:
            raise ResearchTransportError('SOURCE_ALLOWLIST_INVALID')
        for domain in allowed_domains:
            host, target = _url_parts('https://' + str(domain) + '/')
            if target != '/' or host != domain:
                raise ResearchTransportError('SOURCE_ALLOWLIST_INVALID')
            domains.add(host)
        self.allowed_domains = frozenset(domains)

    def permits(self, url):
        try:
            host, _ = _url_parts(url)
        except ResearchTransportError:
            return False
        return self._allowed_host(host)

    def _allowed_host(self, host):
        return host.endswith('.gov.cn') or any(host == d or host.endswith('.' + d) for d in self.allowed_domains)

    def can_fetch(self, url):
        """Pure allowlist check; DNS and network checks happen only in fetch()."""
        return self.permits(url)

    def fetch(self, hit, timeout):
        if not isinstance(hit, SearchHit) or not self.permits(hit.url):
            raise ResearchTransportError('SOURCE_HOST_NOT_ALLOWED')
        return _parse_page(hit, _get(hit.url, timeout=timeout, max_bytes=PAGE_MAX_BYTES))


class PublicBingRSSProvider(_SourceFetcher):
    """No-key experimental RSS adapter; may be unavailable or return no results."""
    def search(self, query, timeout, limit=4):
        query = _search_input(query, limit)
        url = 'https://cn.bing.com/search?' + urlencode({'format':'rss', 'q':query})
        return _parse_bing_rss(_get(url, timeout=timeout, max_bytes=SEARCH_MAX_BYTES), limit)


class BraveApiProvider(_SourceFetcher):
    """Optional explicitly configured key. Only Brave's fixed search endpoint."""
    def __init__(self, api_key, *, allowed_domains=()):
        super().__init__(allowed_domains=allowed_domains)
        if not isinstance(api_key, str) or not 1 <= len(api_key) <= 512 or _BAD_URL.search(api_key):
            raise ResearchTransportError('SEARCH_KEY_INVALID')
        self._api_key = api_key

    def search(self, query, timeout, limit=4):
        query = _search_input(query, limit)
        url = 'https://api.search.brave.com/res/v1/web/search?' + urlencode({'q':query, 'count':limit})
        response = _get(url, timeout=timeout, max_bytes=SEARCH_MAX_BYTES,
                        headers={'X-Subscription-Token':self._api_key})
        try:
            value = json.loads(_decode(response))
            rows = value.get('web', {}).get('results', [])
            if not isinstance(rows, list):
                raise ValueError()
            result, seen = [], set()
            for row in rows[:20]:
                if not isinstance(row, dict):
                    continue
                hit = _hit(row.get('url'), row.get('title', ''), row.get('description', ''))
                if hit is not None and hit.url not in seen:
                    result.append(hit)
                    seen.add(hit.url)
                    if len(result) >= limit:
                        break
            return result
        except (ValueError, TypeError, AttributeError):
            raise ResearchTransportError('SEARCH_PARSE_FAILED') from None


def _published_date(value):
    """Optional source-reported RFC 3339 value, never a claim of verification."""
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.isoformat() if parsed.tzinfo is not None else None
    except ValueError:
        return None


def _discovery_hosts(rows):
    """Bounded diagnostic domains only; omit paths, queries, credentials and IPs.

    Include HTTP result domains to explain why strict HTTPS hit validation may
    have rejected all discoveries. This does not authorize fetching those URLs.
    """
    hosts = []
    for row in rows[:50]:
        value = row.get('url') if isinstance(row, dict) else None
        if not isinstance(value, str) or not 1 <= len(value) <= 2048 or _BAD_URL.search(value):
            continue
        try:
            parsed = urlsplit(value)
            if parsed.scheme not in {'http', 'https'} or parsed.username is not None or parsed.password is not None:
                continue
            host, _ = _url_parts('https://' + (parsed.hostname or '') + '/')
            if len(host) <= 100 and host not in hosts:
                hosts.append(host)
                if len(hosts) == 4:
                    break
        except (ValueError, UnicodeError):
            continue
    return hosts


class DeepSeekSearchProvider(_SourceFetcher):
    """DeepSeek's raw Search/Fetch APIs, without LLM or server-side tool loops.

    Fetch is an explicit provider operation, not a fallback after a denied direct
    crawl. Local target checks precede it; provider-side DNS, redirects and target
    access checks remain DeepSeek's responsibility. HTTP/80 sources are supported
    only through that HTTPS API; this process never connects to them in cleartext.
    No rejected call is retried.
    """
    def __init__(self, api_key, *, allowed_domains=()):
        super().__init__(allowed_domains=allowed_domains)
        if (not isinstance(api_key, str) or not 1 <= len(api_key) <= 512
                or _BAD_URL.search(api_key) or not api_key.isascii()):
            raise ResearchTransportError('SEARCH_KEY_INVALID')
        self._api_key = api_key
        self.last_search_stats = {'raw_count':0, 'accepted_count':0, 'hosts':[]}

    def permits(self, url):
        try:
            host, _, _ = _url_target(url, allow_http=True)
        except ResearchTransportError:
            return False
        return self._allowed_host(host)

    def search(self, query, timeout, limit=4):
        self.last_search_stats = {'raw_count':0, 'accepted_count':0, 'hosts':[]}
        query = _search_input(query, limit)
        if len(query) > 128:
            raise ResearchTransportError('SEARCH_INPUT_INVALID')
        response = _post_json('https://api.deepseek.com/v1/tools/search',
                              {'query':query, 'count':limit, 'need_content':False},
                              timeout=timeout, api_key=self._api_key)
        try:
            value = json.loads(_decode(response))
            rows = value['results']
            if not isinstance(rows, list):
                raise ValueError()
            self.last_search_stats = {'raw_count':len(rows), 'accepted_count':0,
                                      'hosts':_discovery_hosts(rows)}
            result, seen = [], set()
            for row in rows[:50]:
                if not isinstance(row, dict) or not isinstance(row.get('url'), str):
                    continue
                # A discoverable URL does not require optional display metadata.
                # Some raw Search results omit snippet or return null when
                # need_content=false. Never fill it from generated summary or
                # content, and never stringify an unexpected object as text.
                title = row.get('title') if isinstance(row.get('title'), str) else ''
                snippet = row.get('snippet') if isinstance(row.get('snippet'), str) else ''
                hit = _proxy_hit(row['url'], title, snippet)
                if hit is not None and hit.url not in seen:
                    # summary, content, scores and authority never become source
                    # evidence here. Only a separate successful Fetch gets text.
                    result.append(SearchHit(hit.url, hit.title, hit.snippet, _published_date(row.get('date'))))
                    seen.add(hit.url)
                    if len(result) >= limit:
                        break
            self.last_search_stats['accepted_count'] = len(result)
            return result
        except (KeyError, ValueError, TypeError, AttributeError):
            raise ResearchTransportError('SEARCH_PARSE_FAILED') from None

    def fetch(self, hit, timeout):
        if not isinstance(hit, SearchHit) or not self.can_fetch(hit.url):
            raise ResearchTransportError('SOURCE_HOST_NOT_ALLOWED')
        deadline = _deadline(timeout)
        host, _, port = _url_target(hit.url, allow_http=True)
        _public_addresses(host, port=port)  # Validate target before asking any fetch proxy.
        response = _post_json('https://api.deepseek.com/v1/tools/fetch', {'url':hit.url},
                              timeout=_remaining(deadline), api_key=self._api_key)
        try:
            value = json.loads(_decode(response))
            title, content = value['title'], value['content']
            if not isinstance(title, str) or not isinstance(content, str):
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise ResearchTransportError('FETCH_PARSE_FAILED') from None
        if len(content.encode('utf-8')) > PAGE_MAX_BYTES:
            raise ResearchTransportError('RESPONSE_TOO_LARGE')
        if not content.strip():
            raise ResearchTransportError('PAGE_EMPTY')
        # Markdown remains untrusted text: no rendering, script execution,
        # embedded images, or following links in the fetched content.
        return Page(hit.url, _clean(title, 240) or hit.title or host, content.strip(), _published_date(hit.published_at))
