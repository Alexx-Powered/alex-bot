import io
import json
import socket
import unittest
from unittest.mock import Mock, patch

import research_transport as transport


PUBLIC = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443))


class FakeResponse:
    def __init__(self, body=b'fine', status=200, headers=None):
        self.status = status
        self.headers = headers or {'Content-Type':'text/html; charset=utf-8'}
        self.stream = io.BytesIO(body)
        self.read_count = 0

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read1(self, size):
        self.read_count += 1
        return self.stream.read(size)

    def close(self):
        self.stream.close()


class FakeConnection:
    def __init__(self, response):
        self.response = response
        self.sock = Mock()
        self.requests = []
        self.bodies = []
        self.closed = False

    def request(self, method, target, headers, body=None):
        self.requests.append((method, target, headers))
        self.bodies.append(body)

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class URLSafetyTests(unittest.TestCase):
    def test_unsafe_urls_are_rejected_before_dns(self):
        bad = ['http://www.gov.cn/', 'https://localhost/', 'https://127.0.0.1/',
               'https://2130706433/', 'https://0177.0.0.1/', 'https://0x7f.0.0.1/',
               'https://[::1]/', 'https://[::ffff:8.8.8.8]/', 'https://user:pass@www.gov.cn/',
               'https://www.gov.cn/#x', 'https://www.gov.cn/#', 'https://www.gov.cn:444/',
               'https://www.gov.cn./', 'https://www.gov.cn%2f.evil.com/',
               'https://www.gov.cn\\@evil.com/', 'https://www.gov.cn/\r\nx:x']
        with patch.object(socket, 'getaddrinfo') as dns:
            for url in bad:
                with self.subTest(url=url), self.assertRaises(transport.ResearchTransportError):
                    transport._get(url, timeout=1, max_bytes=transport.PAGE_MAX_BYTES)
            dns.assert_not_called()

    def test_full_dns_answer_must_be_public(self):
        for value in ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254',
                      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1',
                      'fc00::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1', '2002:0808:0808::']:
            family = socket.AF_INET6 if ':' in value else socket.AF_INET
            row = (family, socket.SOCK_STREAM, 6, '', (value, 443))
            with self.subTest(value=value), patch.object(socket, 'getaddrinfo', return_value=[PUBLIC, row]):
                with self.assertRaisesRegex(transport.ResearchTransportError, 'DNS_NOT_PUBLIC'):
                    transport._public_addresses('www.gov.cn')

    def test_dns_failure_is_bounded_error(self):
        with patch.object(socket, 'getaddrinfo', side_effect=socket.gaierror('sensitive resolver info')):
            with self.assertRaises(transport.ResearchTransportError) as error:
                transport._public_addresses('www.gov.cn')
        self.assertEqual(error.exception.code, 'DNS_FAILED')
        self.assertNotIn('sensitive', str(error.exception))

    def test_tls_connect_uses_vetted_address_and_original_sni(self):
        raw = Mock()
        context = Mock()
        with patch.object(transport.ssl, 'create_default_context', return_value=context), \
             patch.object(socket, 'socket', return_value=raw), \
             patch.object(socket, 'getaddrinfo') as dns:
            connection = transport._PinnedHTTPSConnection('www.gov.cn', PUBLIC, 2)
            connection.connect()
        raw.connect.assert_called_once_with(('93.184.216.34', 443))
        context.wrap_socket.assert_called_once_with(raw, server_hostname='www.gov.cn')
        dns.assert_not_called()

    def test_allowlist_is_suffix_boundary_and_never_follows_unknown_host(self):
        provider = transport.PublicBingRSSProvider(allowed_domains=['outdoor.example.com'])
        with patch.object(socket, 'getaddrinfo') as dns:
            self.assertTrue(provider.can_fetch('https://www.gov.cn/a'))
            self.assertFalse(provider.can_fetch('https://gov.cn.evil.com/a'))
            dns.assert_not_called()
        for url in ['https://www.gov.cn/a', 'https://news.people.com.cn/a', 'https://www.sohu.com/a',
                    'https://outdoor.example.com/a', 'https://a.outdoor.example.com/a']:
            self.assertTrue(provider.permits(url), url)
        for url in ['https://gov.cn.evil.com/a', 'https://evilgov.cn/a',
                    'https://evilsohu.com/a', 'https://example.com/a', 'https://www.sohu.com:444/a']:
            self.assertFalse(provider.permits(url), url)
            with patch.object(transport, '_get') as fetch:
                with self.assertRaisesRegex(transport.ResearchTransportError, 'SOURCE_HOST_NOT_ALLOWED'):
                    provider.fetch(transport.SearchHit(url, 'title'), 1)
                fetch.assert_not_called()


class HTTPBoundsTests(unittest.TestCase):
    def call(self, response, **options):
        connection = FakeConnection(response)
        with patch.object(socket, 'getaddrinfo', return_value=[PUBLIC]) as dns, \
             patch.object(transport, '_PinnedHTTPSConnection', return_value=connection) as create:
            result = transport._get('https://www.gov.cn/page?x=1', timeout=2,
                                    max_bytes=transport.PAGE_MAX_BYTES, **options)
            dns.assert_called_once()
            create.assert_called_once()
        return result, connection

    def test_success_disables_compression_and_uses_fixed_user_agent(self):
        result, connection = self.call(FakeResponse(b'hello'))
        self.assertEqual(result.body, b'hello')
        self.assertTrue(connection.closed)
        self.assertEqual(connection.requests[0][0:2], ('GET', '/page?x=1'))
        self.assertEqual(connection.requests[0][2]['Accept-Encoding'], 'identity')
        self.assertEqual(connection.requests[0][2]['User-Agent'], transport.USER_AGENT)

    def test_redirects_are_not_followed_or_read(self):
        for status in [301, 302, 303, 307, 308]:
            response = FakeResponse(status=status, headers={'Location':'http://169.254.169.254/'})
            with self.subTest(status=status), self.assertRaisesRegex(transport.ResearchTransportError, 'HTTP_REDIRECT_DENIED'):
                self.call(response)
            self.assertEqual(response.read_count, 0)

    def test_auth_and_rate_status_are_not_retried(self):
        for status in [401, 402, 403, 404, 429]:
            connection = FakeConnection(FakeResponse(status=status))
            with self.subTest(status=status), patch.object(socket, 'getaddrinfo', return_value=[PUBLIC]), \
                 patch.object(transport, '_PinnedHTTPSConnection', return_value=connection) as create:
                with self.assertRaisesRegex(transport.ResearchTransportError, 'HTTP_' + str(status)):
                    transport._get('https://www.gov.cn/', timeout=1, max_bytes=transport.PAGE_MAX_BYTES)
                self.assertEqual(len(connection.requests), 1)
                create.assert_called_once()
                self.assertTrue(connection.closed)

    def test_declared_and_streaming_size_limits(self):
        too_long = transport.PAGE_MAX_BYTES + 1
        for response in [FakeResponse(headers={'Content-Length':str(too_long)}),
                         FakeResponse(b'x' * too_long)]:
            with self.assertRaisesRegex(transport.ResearchTransportError, 'RESPONSE_TOO_LARGE'):
                self.call(response)
        result, _ = self.call(FakeResponse(b'x' * transport.PAGE_MAX_BYTES))
        self.assertEqual(len(result.body), transport.PAGE_MAX_BYTES)

    def test_compressed_responses_are_rejected_without_decompression(self):
        response = FakeResponse(b'not expanded', headers={'Content-Encoding':'gzip'})
        with self.assertRaisesRegex(transport.ResearchTransportError, 'HTTP_ENCODING_DENIED'):
            self.call(response)
        self.assertEqual(response.read_count, 0)

    def test_bad_timeout_and_deadline_exhaustion(self):
        for timeout in [0, -1, float('nan'), float('inf'), True, 31]:
            with self.assertRaisesRegex(transport.ResearchTransportError, 'INVALID_TIMEOUT'):
                transport._get('https://www.gov.cn/', timeout=timeout, max_bytes=transport.PAGE_MAX_BYTES)
        with patch.object(transport.time, 'monotonic', return_value=2):
            with self.assertRaisesRegex(transport.ResearchTransportError, 'HTTP_TIMEOUT'):
                transport._remaining(1)


class ParseTests(unittest.TestCase):
    def test_utf8_and_gb18030_decoding_and_failure(self):
        value = '哈巴西坡，海拔与路线资料'
        for codec, content_type in [('utf-8', 'text/html; charset=utf-8'), ('gb18030', 'text/html; charset=gb2312')]:
            response = transport._Response(value.encode(codec), content_type)
            self.assertEqual(transport._decode(response), value)
        with self.assertRaisesRegex(transport.ResearchTransportError, 'TEXT_DECODE_FAILED'):
            transport._decode(transport._Response(b'\xff\xfe', 'text/plain; charset=utf-8'))
        with self.assertRaisesRegex(transport.ResearchTransportError, 'TEXT_ENCODING_UNSUPPORTED'):
            transport._decode(transport._Response(b'x', 'text/plain; charset=utf-7'))

    def test_html_is_text_only_and_skips_navigation_forms_and_scripts(self):
        html = '''<html><head><title>哈巴西坡</title><meta property="article:published_time" content="2026-11-06T09:00:00+08:00"></head>
        <body><nav>不收导航</nav><p>一段 &amp; 正文</p><script>steal()</script><style>hidden</style>
        <form>password</form><footer>广告</footer><p>第二段<a href="https://evil.example/">文本链接</a></p></body></html>'''
        hit = transport.SearchHit('https://www.gov.cn/a', 'fallback')
        page = transport._parse_page(hit, transport._Response(html.encode(), 'text/html'))
        self.assertEqual(page.title, '哈巴西坡')
        self.assertEqual(page.text, '一段 & 正文\n第二段文本链接')
        self.assertEqual(page.published_at, '2026-11-06T09:00:00+08:00')
        self.assertNotIn('steal', page.text)

    def test_non_html_and_empty_document_rejected(self):
        hit = transport.SearchHit('https://www.gov.cn/a', 'fallback')
        with self.assertRaisesRegex(transport.ResearchTransportError, 'PAGE_TYPE_UNSUPPORTED'):
            transport._parse_page(hit, transport._Response(b'PDF', 'application/pdf'))
        with self.assertRaisesRegex(transport.ResearchTransportError, 'PAGE_EMPTY'):
            transport._parse_page(hit, transport._Response(b'<script>only script</script>', 'text/html'))

    def test_bing_rss_parses_filters_unsafe_urls_and_deduplicates(self):
        xml = '''<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>
        <item><title>哈巴西坡</title><link>https://www.gov.cn/a</link><description>公开资料</description></item>
        <item><title>重复</title><link>https://www.gov.cn/a</link></item>
        <item><title>非TLS</title><link>http://www.gov.cn/a</link></item>
        <item><title>内网</title><link>https://127.0.0.1/a</link></item>
        <item><title>仅线索</title><link>https://unknown.example.com/a</link></item>
        </channel></rss>'''
        rows = transport._parse_bing_rss(transport._Response(xml.encode(), 'text/xml'))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], transport.SearchHit('https://www.gov.cn/a', '哈巴西坡', '公开资料'))
        self.assertFalse(transport.PublicBingRSSProvider().permits(rows[1].url))

    def test_rss_entities_and_captcha_html_are_rejected(self):
        for raw, code in [(b'<!DOCTYPE rss [<!ENTITY x "value">]><rss/>', 'XML_ENTITY_DENIED'),
                          (b'<html>verify</html>', 'SEARCH_PARSE_FAILED'), (b'broken', 'SEARCH_PARSE_FAILED')]:
            with self.subTest(code=code), self.assertRaisesRegex(transport.ResearchTransportError, code):
                transport._parse_bing_rss(transport._Response(raw, 'text/xml'))

    def test_bing_endpoint_and_query_encoding_are_fixed(self):
        response = transport._Response(b'<rss><channel/></rss>', 'application/xml')
        with patch.object(transport, '_get', return_value=response) as get:
            self.assertEqual(transport.PublicBingRSSProvider().search('哈巴西坡', 2), [])
            url = get.call_args.args[0]
            self.assertTrue(url.startswith('https://cn.bing.com/search?format=rss&q='))
            self.assertIn('%E5%93%88', url)
        for limit in [0, 5, True]:
            with self.assertRaisesRegex(transport.ResearchTransportError, 'SEARCH_INPUT_INVALID'):
                transport.PublicBingRSSProvider().search('哈巴西坡', 2, limit)

    def test_brave_fixed_endpoint_and_explicit_key(self):
        rows = {'web':{'results':[{'url':'https://www.gov.cn/a', 'title':'哈巴', 'description':'资料'}]}}
        response = transport._Response(json.dumps(rows).encode(), 'application/json')
        with patch.object(transport, '_get', return_value=response) as get:
            result = transport.BraveApiProvider('test-only-key').search('哈巴西坡', 2, 1)
            self.assertEqual(len(result), 1)
            self.assertTrue(get.call_args.args[0].startswith('https://api.search.brave.com/res/v1/web/search?'))
            self.assertEqual(get.call_args.kwargs['headers'], {'X-Subscription-Token':'test-only-key'})
            self.assertNotIn('test-only-key', get.call_args.args[0])
        with self.assertRaisesRegex(transport.ResearchTransportError, 'SEARCH_KEY_INVALID'):
            transport.BraveApiProvider('key\r\nInjected: value')


class DeepSeekProviderTests(unittest.TestCase):
    def response(self, value):
        return transport._Response(json.dumps(value, ensure_ascii=False).encode(), 'application/json')

    def test_search_raw_api_shape_never_exposes_summary_or_content(self):
        data = {'results':[{'url':'https://www.gov.cn/haba', 'title':'哈巴西坡',
            'snippet':'供展示的检索线索', 'summary':'不能当作页面正文', 'content':'即使返回也必须忽略',
            'date':'2026-10-08T00:00:00Z', 'authority':4, 'rerank_score':2.8},
            {'url':'https://unknown.example.com/a', 'title':'只作线索', 'snippet':'',
             'summary':'不能回填snippet', 'date':None}]}
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_post_json', return_value=self.response(data)) as post:
            rows = provider.search('哈巴西坡', 4)
        self.assertEqual(post.call_args.args, ('https://api.deepseek.com/v1/tools/search',
            {'query':'哈巴西坡', 'count':4, 'need_content':False}))
        self.assertEqual(set(post.call_args.args[1]), {'query', 'count', 'need_content'})
        self.assertEqual(rows[0], transport.SearchHit('https://www.gov.cn/haba', '哈巴西坡',
            '供展示的检索线索', '2026-10-08T00:00:00+00:00'))
        self.assertEqual(rows[1].snippet, '')
        self.assertNotIn('不能当作', repr(rows))
        self.assertNotIn('必须忽略', repr(rows))
        self.assertNotIn('test-only-key', repr(rows))
        self.assertFalse(provider.can_fetch(rows[1].url))

    def test_search_stats_are_bounded_domains_and_counts_only(self):
        urls = ['http://www.gov.cn/a?secret=must-not-log', 'https://one.example.com/path',
                'https://two.example.com/a', 'https://three.example.com/b',
                'https://four.example.com/c', 'https://five.example.com/d',
                'https://127.0.0.1/private', 'https://user:password@hidden.example.com/a']
        data = {'results':[{'url':u, 'title':'private-title-must-not-log',
                            'snippet':'private-snippet-must-not-log'} for u in urls]}
        provider = transport.DeepSeekSearchProvider('key-must-not-log')
        with patch.object(transport, '_post_json', return_value=self.response(data)):
            rows = provider.search('哈巴西坡', 4)
        self.assertEqual(len(rows), 4)
        self.assertEqual(provider.last_search_stats, {'raw_count':8, 'accepted_count':4,
            'hosts':['www.gov.cn', 'one.example.com', 'two.example.com', 'three.example.com']})
        encoded = json.dumps(provider.last_search_stats)
        self.assertNotIn('must-not-log', encoded)
        self.assertNotIn('password', encoded)
        self.assertNotIn('127.0.0.1', encoded)

    def test_optional_discovery_metadata_does_not_discard_valid_government_urls(self):
        data = {'results':[
            {'url':'https://fj.gov.cn/a', 'title':'福道介绍', 'summary':'NEVER USE SUMMARY'},
            {'url':'http://ylj.fuzhou.gov.cn/b', 'title':'福道公告', 'snippet':None},
            {'url':'https://zjt.fujian.gov.cn/c', 'title':None, 'snippet':''},
            {'url':'https://www.fj.gov.cn/d', 'snippet':{'unexpected':'NEVER STRINGIFY'}}]}
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_post_json', return_value=self.response(data)):
            rows = provider.search('福州福道', 4)
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(provider.can_fetch(hit.url) for hit in rows))
        self.assertTrue(all(hit.snippet == '' for hit in rows))
        self.assertEqual(rows[2].title, '')
        self.assertNotIn('NEVER', repr(rows))
        self.assertEqual(provider.last_search_stats['accepted_count'], 4)

    def test_metadata_compatibility_does_not_relax_url_authority_validation(self):
        urls = ['https://user:key@www.gov.cn/a', 'http://www.gov.cn:8080/a',
                'https://user:key@www.gov.cn/a#section', 'http://127.0.0.1/a#1']
        data = {'results':[{'url':url, 'snippet':None} for url in urls]}
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_post_json', return_value=self.response(data)):
            self.assertEqual(provider.search('福州福道', 4), [])

    def test_article_fragments_are_removed_before_deduplication_and_fetch(self):
        data={'results':[{'url':'https://www.8264.com/youji/5745357.html#'+n,'title':'长穿毕'} for n in ['1','2']]}
        provider=transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport,'_post_json',return_value=self.response(data)):
            rows=provider.search('长穿毕',4)
        self.assertEqual(rows,[transport.SearchHit('https://www.8264.com/youji/5745357.html','长穿毕')])
        self.assertTrue(provider.can_fetch(rows[0].url))

    def test_search_stats_include_proxy_http_hits_and_reset_after_failure(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        data = {'results':[{'url':'http://www.gov.cn/a', 'title':'x', 'snippet':''}]}
        with patch.object(transport, '_post_json', return_value=self.response(data)):
            rows = provider.search('哈巴西坡', 4)
            self.assertEqual(rows, [transport.SearchHit('http://www.gov.cn/a', 'x')])
        self.assertEqual(provider.last_search_stats,
                         {'raw_count':1, 'accepted_count':1, 'hosts':['www.gov.cn']})
        with patch.object(transport, '_post_json', side_effect=transport.ResearchTransportError('HTTP_429')):
            with self.assertRaisesRegex(transport.ResearchTransportError, 'HTTP_429'):
                provider.search('哈巴西坡', 4)
        self.assertEqual(provider.last_search_stats, {'raw_count':0, 'accepted_count':0, 'hosts':[]})

    def test_discovery_stats_do_not_resolve_any_returned_domain(self):
        long_host = 'a' * 60 + '.' + 'b' * 45 + '.com'
        self.assertEqual(transport._discovery_hosts([{'url':'https://' + long_host + '/'}]), [])
        data = {'results':[{'url':'https://one.example.com/a', 'title':'x', 'snippet':''},
                           {'url':'https://one.example.com/b', 'title':'x', 'snippet':''},
                           {'url':'https://user:key@secret.example.com/a', 'title':'x', 'snippet':''}]}
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_post_json', return_value=self.response(data)), \
             patch.object(socket, 'getaddrinfo') as dns:
            provider.search('哈巴西坡', 4)
            dns.assert_not_called()
        self.assertEqual(provider.last_search_stats,
                         {'raw_count':3, 'accepted_count':2, 'hosts':['one.example.com']})

    def test_post_has_fixed_endpoint_headers_and_utf8_json_body(self):
        connection = FakeConnection(FakeResponse(b'{"results":[]}', headers={'Content-Type':'application/json'}))
        with patch.object(socket, 'getaddrinfo', return_value=[PUBLIC]) as dns, \
             patch.object(transport, '_PinnedHTTPSConnection', return_value=connection) as create:
            self.assertEqual(transport.DeepSeekSearchProvider('test-only-key').search('哈巴西坡', 4), [])
        method, path, headers = connection.requests[0]
        self.assertEqual((method, path), ('POST', '/v1/tools/search'))
        self.assertEqual(create.call_args.args[0], 'api.deepseek.com')
        self.assertEqual(dns.call_args.args[0], 'api.deepseek.com')
        self.assertEqual(headers['Authorization'], 'Bearer test-only-key')
        self.assertEqual(headers['Content-Type'], 'application/json')
        self.assertEqual(headers['Accept-Encoding'], 'identity')
        body = json.loads(connection.bodies[0])
        self.assertEqual(body, {'query':'哈巴西坡', 'count':4, 'need_content':False})
        self.assertNotIn(b'test-only-key', connection.bodies[0])

    def test_key_cannot_be_forwarded_to_another_endpoint(self):
        with patch.object(transport, '_read') as read:
            for url, body in [('https://evil.example.com/v1/tools/search', {'query':'test'}),
                              ('https://api.deepseek.com/v1/tools/search', {'query':'test', 'ori_question':'private'})]:
                with self.assertRaisesRegex(transport.ResearchTransportError, 'SEARCH_API_REQUEST_DENIED'):
                    transport._post_json(url, body, timeout=1, api_key='secret-test-key')
            read.assert_not_called()

    def test_search_rejects_long_query_and_malformed_result(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_post_json') as post:
            with self.assertRaisesRegex(transport.ResearchTransportError, 'SEARCH_INPUT_INVALID'):
                provider.search('字' * 129, 4)
            post.assert_not_called()
        for value in [{'results':None}, {}, []]:
            with patch.object(transport, '_post_json', return_value=self.response(value)):
                with self.assertRaisesRegex(transport.ResearchTransportError, 'SEARCH_PARSE_FAILED'):
                    provider.search('哈巴西坡', 4)

    def test_fetch_uses_only_fetched_markdown_and_preserves_source_date(self):
        hit = transport.SearchHit('https://www.gov.cn/haba', '回退标题', '不能替代正文', '2026-10-08T00:00:00Z')
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_public_addresses', return_value=[PUBLIC]) as dns, \
             patch.object(transport, '_post_json', return_value=self.response({'title':'真实标题', 'content':'# 哈巴西坡\n\n已抓取的正文。'})) as post, \
             patch.object(transport, '_get') as direct:
            page = provider.fetch(hit, 4)
        dns.assert_called_once_with('www.gov.cn', port=443)
        self.assertEqual(post.call_args.args, ('https://api.deepseek.com/v1/tools/fetch', {'url':hit.url}))
        self.assertEqual(page.text, '# 哈巴西坡\n\n已抓取的正文。')
        self.assertEqual(page.title, '真实标题')
        self.assertEqual(page.published_at, '2026-10-08T00:00:00+00:00')
        direct.assert_not_called()

    def test_fetch_rejects_non_allowed_or_private_target_before_api(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_post_json') as post, patch.object(transport, '_public_addresses') as dns:
            for url in ['https://evil.example.com/a', 'http://www.gov.cn:443/a', 'https://127.0.0.1/a']:
                with self.assertRaisesRegex(transport.ResearchTransportError, 'SOURCE_HOST_NOT_ALLOWED'):
                    provider.fetch(transport.SearchHit(url, 'title'), 4)
            dns.assert_not_called()
            post.assert_not_called()
        with patch.object(transport, '_public_addresses', side_effect=transport.ResearchTransportError('DNS_NOT_PUBLIC')), \
             patch.object(transport, '_post_json') as post:
            with self.assertRaisesRegex(transport.ResearchTransportError, 'DNS_NOT_PUBLIC'):
                provider.fetch(transport.SearchHit('https://www.gov.cn/a', 'title'), 4)
            post.assert_not_called()

    def test_http_source_only_uses_fixed_https_fetch_api_and_default_port(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        for url in ['http://m.gmw.cn/a', 'http://news.ycwb.com:80/a']:
            hit = transport.SearchHit(url, '哈巴西坡')
            self.assertTrue(provider.can_fetch(url))
            with patch.object(transport, '_public_addresses', return_value=[PUBLIC]) as dns, \
                 patch.object(transport, '_post_json', return_value=self.response({'title':'哈巴西坡', 'content':'已抓取正文'})) as post, \
                 patch.object(transport, '_get') as direct:
                page = provider.fetch(hit, 4)
            self.assertEqual(page.url, url)
            dns.assert_called_once_with(transport.urlsplit(url).hostname, port=80)
            self.assertEqual(post.call_args.args, ('https://api.deepseek.com/v1/tools/fetch', {'url':url}))
            direct.assert_not_called()

    def test_proxy_http_preserves_all_url_and_dns_safety_checks(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        bad = ['http://www.gov.cn:443/a', 'http://www.gov.cn:8080/a', 'https://www.gov.cn:80/a',
               'http://user:pass@www.gov.cn/a', 'http://@www.gov.cn/a', 'http://www.gov.cn/a#',
               'http://www.gov.cn/a#x', 'http://127.0.0.1/a', 'http://8.8.8.8/a',
               'http://[::ffff:8.8.8.8]/a', 'http://2130706433/a', 'http://www.gov.cn/a\r\nx:x',
               'http://www.gov.cn\\@evil.com/a', 'http://evilgmw.cn/a', 'http://ycwb.com.evil.com/a']
        with patch.object(transport, '_post_json') as post, patch.object(transport, '_public_addresses') as dns:
            for url in bad:
                with self.subTest(url=url):
                    self.assertFalse(provider.can_fetch(url))
                    with self.assertRaisesRegex(transport.ResearchTransportError, 'SOURCE_HOST_NOT_ALLOWED'):
                        provider.fetch(transport.SearchHit(url, 'title'), 4)
            post.assert_not_called()
            dns.assert_not_called()
        private = (socket.AF_INET, socket.SOCK_STREAM, 6, '', ('10.0.0.1', 80))
        with patch.object(socket, 'getaddrinfo', return_value=[PUBLIC, private]) as dns, \
             patch.object(transport, '_post_json') as post:
            with self.assertRaisesRegex(transport.ResearchTransportError, 'DNS_NOT_PUBLIC'):
                provider.fetch(transport.SearchHit('http://www.gov.cn/a', 'title'), 4)
            dns.assert_called_once_with('www.gov.cn', 80, type=socket.SOCK_STREAM)
            post.assert_not_called()

    def test_direct_providers_still_refuse_http_sources_and_discovery(self):
        for provider in [transport.PublicBingRSSProvider(), transport.BraveApiProvider('test-only-key')]:
            url = 'http://news.ycwb.com:80/a'
            self.assertFalse(provider.can_fetch(url))
            with patch.object(transport, '_get') as direct:
                with self.assertRaisesRegex(transport.ResearchTransportError, 'SOURCE_HOST_NOT_ALLOWED'):
                    provider.fetch(transport.SearchHit(url, 'title'), 4)
                direct.assert_not_called()
        self.assertIsNone(transport._hit('http://www.gov.cn/a', 'title'))
        self.assertEqual(transport._proxy_hit('http://www.gov.cn/a', 'title'),
                         transport.SearchHit('http://www.gov.cn/a', 'title'))

    def test_fetch_denial_never_uses_direct_fallback_or_retries(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        for code in ['HTTP_402', 'HTTP_403', 'HTTP_404', 'HTTP_429']:
            with patch.object(transport, '_public_addresses', return_value=[PUBLIC]), \
                 patch.object(transport, '_post_json', side_effect=transport.ResearchTransportError(code)) as post, \
                 patch.object(transport, '_get') as direct:
                with self.assertRaisesRegex(transport.ResearchTransportError, code):
                    provider.fetch(transport.SearchHit('https://www.gov.cn/a', 'title'), 4)
                post.assert_called_once()
                direct.assert_not_called()

    def test_fetch_content_byte_limit_and_missing_body(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        for value, code in [({'title':'x', 'content':'字' * (transport.PAGE_MAX_BYTES // 3 + 1)}, 'RESPONSE_TOO_LARGE'),
                            ({'title':'x', 'summary':'摘要不能当正文'}, 'FETCH_PARSE_FAILED'),
                            ({'title':'x', 'content':''}, 'PAGE_EMPTY')]:
            with patch.object(transport, '_public_addresses', return_value=[PUBLIC]), \
                 patch.object(transport, '_post_json', return_value=self.response(value)):
                with self.assertRaisesRegex(transport.ResearchTransportError, code):
                    provider.fetch(transport.SearchHit('https://www.gov.cn/a', 'title'), 4)

    def test_fetch_empty_titles_have_non_factual_hostname_fallback(self):
        provider = transport.DeepSeekSearchProvider('test-only-key')
        with patch.object(transport, '_public_addresses', return_value=[PUBLIC]), \
             patch.object(transport, '_post_json', return_value=self.response({'title':'', 'content':'已抓取正文'})):
            page = provider.fetch(transport.SearchHit('https://www.gov.cn/a', ''), 4)
        self.assertEqual(page.title, 'www.gov.cn')

    def test_provider_key_and_error_messages_do_not_leak_secrets(self):
        for key in ['', 'test\nInjected: value', '测试密钥']:
            with self.assertRaisesRegex(transport.ResearchTransportError, '^SEARCH_KEY_INVALID$'):
                transport.DeepSeekSearchProvider(key)
        provider = transport.DeepSeekSearchProvider('never-print-this-test-key')
        connection = FakeConnection(FakeResponse(b'never-print-this-test-key', status=402))
        with patch.object(socket, 'getaddrinfo', return_value=[PUBLIC]), \
             patch.object(transport, '_PinnedHTTPSConnection', return_value=connection):
            with self.assertRaises(transport.ResearchTransportError) as error:
                provider.search('哈巴西坡', 4)
        self.assertEqual(str(error.exception), 'HTTP_402')
        self.assertNotIn('never-print', repr(provider))
        self.assertEqual(connection.response.read_count, 0)


if __name__ == '__main__':
    unittest.main()
