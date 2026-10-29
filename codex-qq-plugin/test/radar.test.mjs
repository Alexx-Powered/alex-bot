import test from 'node:test';
import assert from 'node:assert/strict';
import { RadarError, RadarService, RADAR_LIMITS } from '../src/radar.mjs';

const NOW = Date.parse('2026-10-28T10:30:00Z');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNq0AAAAASUVORK5CYII=', 'base64');
const url = (stamp = '20261028101800', station = 'AZ9010') => `https://image.nmc.cn/product/2026/10/28/RDCP/SEVP_AOC_RDCP_SLDAS3_ECREF_${station}_L88_PI_${stamp}000.PNG?v=123`;
const frame = ({ stamp, station, time = '10/28 18:18', imageUrl } = {}) => `<div class="col-xs-12 time actived" data-index=0 data-img="${imageUrl ?? url(stamp, station)}" data-time="${time}"></div>`;
const htmlResponse = (body) => new Response(body, { headers: { 'content-type': 'text/html;charset=utf-8' } });
const imageResponse = () => new Response(PNG, { headers: { 'content-type': 'image/png' } });

function fixture({ html = frame(), image = imageResponse, now = NOW, fetch: customFetch } = {}) {
  const calls = [];
  const clock = { now };
  const service = new RadarService({ now: () => clock.now, fetchImpl: async (requestUrl, options) => {
    calls.push({ url: requestUrl, options });
    if (customFetch) return customFetch(requestUrl, options, calls.length);
    return requestUrl.startsWith('https://www.nmc.cn/') ? htmlResponse(html) : image();
  } });
  return { service, calls, clock };
}

const hasCode = (code) => (error) => error instanceof RadarError && error.code === code;

test('downloads the newest Beijing frame, keeps bytes and original source attribution', async () => {
  const f = fixture({ html: frame({ stamp: '20261028101200', time: '10/28 18:12' }) + frame() });
  const result = await f.service.get('北京市');
  assert.equal(result.kind, 'image');
  assert.equal(result.city, '北京');
  assert.equal(result.issuedAt, '2026-10-28T10:18:00.000Z');
  assert.deepEqual(result.buffer, PNG);
  assert.equal(result.sourceUrl, url());
  assert.match(result.caption, /中央气象台/);
  assert.match(result.caption, /2026-10-28 18:18/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, 'https://www.nmc.cn/publish/radar/bei-jing/da-xing.htm');
  assert.ok(f.calls.every(({ options }) => options.redirect === 'manual' && options.signal instanceof AbortSignal));
});

test('Tianjin selects its own station rather than reusing Beijing', async () => {
  const f = fixture({ html: frame({ station: 'AZ9220' }) });
  const result = await f.service.get('天津');
  assert.match(f.calls[0].url, /tian-jin\/tian-jin\.htm$/);
  assert.equal(result.city, '天津');
  assert.match(result.sourceUrl, /AZ9220/);
  await assert.rejects(f.service.get('北京'), hasCode('RADAR_SOURCE_CHANGED'));
});

test('invalid names and caller URLs never initiate a fetch', async () => {
  const f = fixture();
  for (const city of ['', 'https://example.com/', '../北京', null, {}]) {
    await assert.rejects(f.service.get(city), hasCode('NOT_FOUND'));
  }
  assert.equal(f.calls.length, 0);
});

test('five-minute cache deduplicates in-flight calls and protects cached image bytes', async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.service.get('北京'), f.service.get('北京')]);
  assert.equal(f.calls.length, 2);
  first.buffer[0] = 0;
  assert.deepEqual(second.buffer, PNG);
  assert.deepEqual((await f.service.get('北京')).buffer, PNG);
  assert.equal(f.calls.length, 2);
  f.clock.now += RADAR_LIMITS.cacheMs;
  await f.service.get('北京');
  assert.equal(f.calls.length, 4);
});

test('stale upstream image is never downloaded or relabeled current', async () => {
  const f = fixture({ html: frame({ stamp: '20261027093000', time: '10/27 17:30' }) });
  await assert.rejects(f.service.get('北京'), (error) => hasCode('RADAR_STALE')(error) && /2026-10-27 17:30/.test(error.message));
  assert.equal(f.calls.length, 1);
});

test('exact UTC and Beijing page labels preserve the same filename UTC issue time', async () => {
  for (const time of ['10/28 10:18', '10/28 18:18']) {
    const f = fixture({ html: frame({ time }) });
    const result = await f.service.get('北京');
    assert.equal(result.issuedAt, '2026-10-28T10:18:00.000Z');
    assert.match(result.caption, /2026-10-28 18:18/);
    assert.deepEqual(result.buffer, PNG);
    assert.equal(f.calls.length, 2);
  }
});

test('UTC page labels cannot make stale or future filename times current', async () => {
  for (const [stamp, time, code] of [
    ['20261027093000', '10/27 09:30', 'RADAR_STALE'],
    ['20261028110000', '10/28 11:00', 'RADAR_TIME_INVALID'],
  ]) {
    const f = fixture({ html: frame({ stamp, time }) });
    await assert.rejects(f.service.get('北京'), hasCode(code));
    assert.equal(f.calls.length, 1, 'invalid times never reach image download');
  }
});

test('arbitrary offsets or minute and date mismatches remain rejected', async () => {
  for (const time of ['10/28 02:18', '10/28 11:18', '10/28 18:19', '10/28 10:17', '10/27 10:18']) {
    const f = fixture({ html: frame({ time }) });
    await assert.rejects(f.service.get('北京'), hasCode('RADAR_SOURCE_CHANGED'));
    assert.equal(f.calls.length, 1);
  }
});

test('cached image crossing freshness threshold is not sent', async () => {
  const f = fixture({ now: Date.parse('2026-10-28T11:17:00Z') });
  await f.service.get('北京');
  f.clock.now += 2 * 60_000;
  await assert.rejects(f.service.get('北京'), hasCode('RADAR_STALE'));
  assert.equal(f.calls.length, 2);
});

test('future dates, invalid calendar dates, and mismatched displayed time fail closed', async () => {
  for (const [html, code] of [
    [frame({ stamp: '20261028110000', time: '10/28 19:00' }), 'RADAR_TIME_INVALID'],
    [frame({ stamp: '20260230101800', time: '03/02 18:18' }), 'RADAR_SOURCE_CHANGED'],
    [frame({ time: '10/28 11:18' }), 'RADAR_SOURCE_CHANGED'],
  ]) {
    const f = fixture({ html });
    await assert.rejects(f.service.get('北京'), hasCode(code));
    assert.equal(f.calls.length, 1);
  }
});

test('UTC filename and Beijing page label remain correct across midnight and year change', async () => {
  for (const time of ['01/01 00:18', '12/31 16:18']) {
    const f = fixture({ html: frame({ stamp: '20251231161800', time }), now: Date.parse('2025-12-31T16:30:00Z') });
    const result = await f.service.get('北京');
    assert.equal(result.issuedAt, '2025-12-31T16:18:00.000Z');
    assert.match(result.caption, /2026-01-01 00:18/);
  }
});

test('nodata placeholders, changed product names and wrong station are not radar images', async () => {
  for (const html of ['<img src="https://image.nmc.cn/assets/img/nodata.jpg">', frame({ imageUrl: 'https://image.nmc.cn/assets/img/default.jpg' }), frame({ station: 'AZ9220' })]) {
    const f = fixture({ html });
    await assert.rejects(f.service.get('北京'), hasCode('RADAR_SOURCE_CHANGED'));
    assert.equal(f.calls.length, 1);
  }
});

test('unofficial domains, credentials, ports and insecure image links are rejected before fetch', async () => {
  for (const imageUrl of [url().replace('image.nmc.cn', 'evil.example'), url().replace('image.nmc.cn', 'image.nmc.cn.evil.example'), url().replace('https:', 'http:'), url().replace('image.nmc.cn', 'user:password@image.nmc.cn'), url().replace('image.nmc.cn', 'image.nmc.cn:8443')]) {
    const f = fixture({ html: frame({ imageUrl }) });
    await assert.rejects(f.service.get('北京'), hasCode('RADAR_SOURCE_REJECTED'));
    assert.equal(f.calls.length, 1);
  }
});

test('redirects to nonofficial hosts are blocked without contacting their targets', async () => {
  const f = fixture({ fetch: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:19327/api/status' } }) });
  await assert.rejects(f.service.get('北京'), hasCode('RADAR_SOURCE_REJECTED'));
  assert.equal(f.calls.length, 1);
});

test('image redirect cannot silently substitute an older product or a nodata placeholder', async () => {
  for (const location of [url('20261027093000'), 'https://image.nmc.cn/assets/img/nodata.jpg', 'https://evil.example/image.png']) {
    const f = fixture({ fetch: (requestUrl) => requestUrl.startsWith('https://www.nmc.cn/')
      ? htmlResponse(frame()) : new Response(null, { status: 302, headers: { location } }) });
    await assert.rejects(f.service.get('北京'), hasCode('RADAR_SOURCE_REJECTED'));
    assert.equal(f.calls.length, 2);
  }
});

test('an official redirect is supported but redirect loops are bounded', async () => {
  const good = fixture({ fetch: (requestUrl, options, count) => {
    if (count === 1) return new Response(null, { status: 302, headers: { location: '/publish/radar/bei-jing/da-xing.htm?refresh=1' } });
    return requestUrl.startsWith('https://www.nmc.cn/') ? htmlResponse(frame()) : imageResponse();
  } });
  assert.equal((await good.service.get('北京')).kind, 'image');
  assert.equal(good.calls.length, 3);
  const loop = fixture({ fetch: () => new Response(null, { status: 302, headers: { location: '/loop' } }) });
  await assert.rejects(loop.service.get('北京'), hasCode('RADAR_SOURCE_REJECTED'));
  assert.equal(loop.calls.length, RADAR_LIMITS.redirects + 1);
});

test('HTML masquerading as an image and mismatched image MIME are rejected', async () => {
  for (const image of [
    () => new Response('<html>error</html>', { headers: { 'content-type': 'image/png' } }),
    () => new Response(PNG, { headers: { 'content-type': 'text/html' } }),
    () => new Response(PNG, { headers: { 'content-type': 'image/jpeg' } }),
    () => new Response(PNG.subarray(0, 33), { headers: { 'content-type': 'image/png' } }),
  ]) await assert.rejects(fixture({ image }).service.get('北京'), hasCode('RADAR_SOURCE_CHANGED'));
});

test('declared and streamed oversized responses are bounded', async () => {
  const declared = fixture({ image: () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(RADAR_LIMITS.imageBytes + 1) } }) });
  await assert.rejects(declared.service.get('北京'), hasCode('RADAR_TOO_LARGE'));
  const streamed = fixture({ fetch: () => htmlResponse('x'.repeat(RADAR_LIMITS.pageBytes + 1)) });
  await assert.rejects(streamed.service.get('北京'), hasCode('RADAR_TOO_LARGE'));
});

test('network and timeout errors are friendly and do not expose upstream exception text', async () => {
  for (const [error, code] of [[new Error('secret-network-text'), 'RADAR_UNAVAILABLE'], [new DOMException('secret-network-text', 'TimeoutError'), 'RADAR_TIMEOUT']]) {
    const f = fixture({ fetch: () => { throw error; } });
    await assert.rejects(f.service.get('北京'), (result) => hasCode(code)(result) && !result.message.includes('secret-network-text'));
    await assert.rejects(f.service.get('北京'), hasCode(code));
    assert.equal(f.calls.length, 2, 'failures are not cached');
  }
});

test('a stalled request is aborted at the configured timeout', async () => {
  const keepAlive = setTimeout(() => {}, 200);
  try {
    const service = new RadarService({ timeoutMs: 10, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) });
    await assert.rejects(service.get('北京'), hasCode('RADAR_TIMEOUT'));
  } finally {
    clearTimeout(keepAlive);
  }
});

function catalogFixture({ failProvince, externalLink = false } = {}) {
  const base = 'https://www.nmc.cn';
  const provinces = [
    { name: '北京', slug: 'beijing', names: ['大兴', '海坨山'] },
    { name: '天津', slug: 'tianjin', names: ['塘沽', '宝坻'] },
    { name: '广东', slug: 'guangdong', names: ['广州', ...Array.from({ length: 12 }, (_, i) => `测试站${i + 1}`)] },
    { name: '新疆', slug: 'xinjiang', names: Array.from({ length: 23 }, (_, i) => `新疆站${i + 1}`) },
    { name: '辽宁', slug: 'liaoning', names: ['朝阳'] },
    { name: '陕西', slug: 'shanxi', names: ['朝阳'] },
  ];
  let code = 1000;
  for (const province of provinces) province.stations = province.names.map((name, i) => ({
    name, province: province.name, code: province.name === '北京' && i === 0 ? 'AZ9010' : province.name === '天津' && i === 0 ? 'AZ9220' : `AZ${code++}`,
    pageUrl: province.name === '北京' && i === 0 ? `${base}/publish/radar/bei-jing/da-xing.htm`
      : province.name === '天津' && i === 0 ? `${base}/publish/radar/tian-jin/tian-jin.htm`
        : `${base}/publish/tianqishikuang/leidatu/danzhanleida/${province.slug}/station-${i}/index.html`,
  }));
  const regions = [['全国', 'chinaall', 'ACHN'], ['华北', 'huabei', 'ANCN'], ['东北', 'dongbei', 'ANEC'], ['华东', 'huadong', 'AECN'], ['华中', 'huazhong', 'ACCN'], ['华南', 'huanan', 'ASCN'], ['西南', 'xinan', 'ASWC'], ['西北', 'xibei', 'ANWC']]
    .map(([name, slug, code]) => ({ name, code, pageUrl: `${base}/publish/radar/${slug}.html` }));
  const navigation = (level, entries) => `<div class="p-wrap"><div class="p-nav nav${level}"><div class=sl-key>目录</div><ul>${entries.map((entry) => `<li><a href="${entry.pageUrl}">${entry.name}</a></li>`).join('')}</ul><div class=morelist>更多</div></div></div>`;
  const provinceMenu = navigation(2, provinces.map((province) => ({ name: province.name, pageUrl: externalLink && province.name === '广东' ? 'https://evil.example/page.html' : province.stations[0].pageUrl })));
  const pages = new Map();
  for (const province of provinces) for (const station of province.stations) {
    pages.set(station.pageUrl, `<title>天气实况_雷达图_单站雷达_${province.name}_${station.name}</title>${provinceMenu}${navigation(3, province.stations)}${frame({ station: station.code })}`);
  }
  for (const region of regions) {
    const imageUrl = region.name === '全国' ? url(undefined, region.code).replace('/RDCP/', '/RDCP/medium/') : url(undefined, region.code);
    pages.set(region.pageUrl, `<title>天气实况_雷达图_雷达拼图_${region.name}</title>${navigation(2, regions)}${frame({ imageUrl })}`);
  }
  const calls = [];
  const clock = { now: NOW };
  let active = 0;
  let maxActive = 0;
  const service = new RadarService({ now: () => clock.now, fetchImpl: async (requestUrl) => {
    calls.push(requestUrl);
    active += 1;
    maxActive = Math.max(active, maxActive);
    await Promise.resolve();
    active -= 1;
    if (requestUrl.startsWith('https://image.nmc.cn/')) return imageResponse();
    if (failProvince && requestUrl === provinces.find((province) => province.name === failProvince).stations[0].pageUrl) return new Response('', { status: 503 });
    if (!pages.has(requestUrl)) throw new Error(`Unexpected mock request: ${requestUrl}`);
    return htmlResponse(pages.get(requestUrl));
  } });
  return { service, calls, clock, pages, provinces, regions, maxActive: () => maxActive };
}

test('catalog discovers every province menu and all regions without downloading images', async () => {
  const f = catalogFixture();
  const summary = await f.service.list();
  assert.equal(summary.stationCount, 42);
  assert.equal(summary.regionCount, 8);
  assert.equal(summary.provinces.length, 6);
  assert.equal(summary.total, 50);
  assert.match(summary.text, /全国、华北、东北、华东、华中、华南、西南、西北/);
  assert.ok(summary.text.length <= 1300);
  assert.equal(f.calls.length, f.provinces.length + 1, 'one page per province plus the regional menu');
  assert.ok(f.calls.every((requestUrl) => requestUrl.startsWith('https://www.nmc.cn/')));
  assert.ok(f.maxActive() <= RADAR_LIMITS.catalogConcurrency);
});

test('catalog coalesces concurrent initialization and refreshes only after 24 hours', async () => {
  const f = catalogFixture();
  await Promise.all([f.service.list(), f.service.list('广东'), f.service.list('新疆')]);
  const initialCalls = f.calls.length;
  assert.equal(initialCalls, f.provinces.length + 1);
  f.clock.now += RADAR_LIMITS.catalogMs - 1;
  await f.service.list();
  assert.equal(f.calls.length, initialCalls);
  f.clock.now += 1;
  await f.service.list();
  assert.equal(f.calls.length, initialCalls * 2);
});

test('province pagination covers every station and accepts QQ-style suffix or explicit page', async () => {
  const f = catalogFixture();
  const first = await f.service.list('新疆');
  const second = await f.service.list('新疆 2');
  const explicit = await f.service.list('新疆', { page: 2 });
  assert.equal(first.total, 23);
  assert.equal(first.pages, 2);
  assert.equal(first.items.length, 12);
  assert.equal(second.items.length, 11);
  assert.deepEqual(second.items, explicit.items);
  assert.equal(new Set([...first.items, ...second.items].map((entry) => entry.label)).size, 23);
  assert.match(first.text, /雷达目录 新疆 2/);
  assert.ok([first, second].every((result) => result.text.length <= 1300));
  await assert.rejects(f.service.list('新疆 3'), hasCode('NOT_FOUND'));
  await assert.rejects(f.service.list('新疆 0'), hasCode('NOT_FOUND'));
});

test('new-path stations can be resolved by complete province and station name', async () => {
  const f = catalogFixture();
  const result = await f.service.get('北京海坨山');
  assert.equal(result.target, '北京·海坨山');
  assert.equal(result.targetKind, 'station');
  assert.match(result.pageUrl, /tianqishikuang\/leidatu\/danzhanleida/);
  assert.deepEqual(result.buffer, PNG);
  const callCount = f.calls.length;
  await f.service.get('北京·海坨山');
  assert.equal(f.calls.length, callCount);
  const directory = await f.service.list('海坨山');
  assert.equal(directory.total, 1);
  assert.equal(directory.items[0].label, '北京·海坨山');
});

test('all regional products including national medium original can be downloaded on demand', async () => {
  const f = catalogFixture();
  await f.service.list();
  for (const region of f.regions) {
    const before = f.calls.length;
    const result = await f.service.get(region.name);
    assert.equal(result.targetKind, 'region');
    assert.equal(result.target, region.name);
    assert.match(result.caption, /区域雷达拼图/);
    assert.ok(result.sourceUrl.includes(region.code));
    if (region.name === '全国') assert.match(result.sourceUrl, /\/RDCP\/medium\//);
    assert.equal(f.calls.length, before + 2);
  }
});

test('duplicate station names and province-wide requests report complete suggestions', async () => {
  const f = catalogFixture();
  await assert.rejects(f.service.get('朝阳'), (error) => hasCode('AMBIGUOUS_TARGET')(error)
    && error.suggestions.includes('辽宁·朝阳') && error.suggestions.includes('陕西·朝阳'));
  await assert.rejects(f.service.get('广东'), (error) => hasCode('AMBIGUOUS_TARGET')(error) && error.suggestions.length === 13);
  const result = await f.service.get('辽宁朝阳');
  assert.equal(result.target, '辽宁·朝阳');
});

test('unknown valid names return NOT_FOUND with a directory hint, never a guessed source', async () => {
  const f = catalogFixture();
  await f.service.list();
  const before = f.calls.length;
  for (const action of [() => f.service.get('不存在的站'), () => f.service.list('不存在的省')]) {
    await assert.rejects(action(), (error) => hasCode('NOT_FOUND')(error) && /雷达目录/.test(error.message));
  }
  assert.equal(f.calls.length, before);
});

test('a failed province cannot silently publish a partial catalog, and failures have cooldown', async () => {
  const f = catalogFixture({ failProvince: '广东' });
  await assert.rejects(f.service.list(), hasCode('RADAR_CATALOG_UNAVAILABLE'));
  await Promise.resolve();
  const before = f.calls.length;
  await assert.rejects(f.service.list(), hasCode('RADAR_CATALOG_UNAVAILABLE'));
  assert.equal(f.calls.length, before);
});

test('unofficial catalog entries are rejected before their links are fetched', async () => {
  const f = catalogFixture({ externalLink: true });
  await assert.rejects(f.service.list(), hasCode('RADAR_CATALOG_UNAVAILABLE'));
  assert.ok(f.calls.every((requestUrl) => requestUrl.startsWith('https://www.nmc.cn/')));
});

test('a mismatched target page title does not deliver another station image', async () => {
  const f = catalogFixture();
  await f.service.list();
  const station = f.provinces.find((province) => province.name === '广东').stations[0];
  f.pages.set(station.pageUrl, f.pages.get(station.pageUrl).replace('单站雷达_广东_广州', '单站雷达_北京_大兴'));
  const before = f.calls.filter((requestUrl) => requestUrl.startsWith('https://image.nmc.cn/')).length;
  await assert.rejects(f.service.get('广东广州'), hasCode('RADAR_SOURCE_CHANGED'));
  assert.equal(f.calls.filter((requestUrl) => requestUrl.startsWith('https://image.nmc.cn/')).length, before);
});
