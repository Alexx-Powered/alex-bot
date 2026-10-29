const MINUTE = 60_000;

export const RADAR_LIMITS = Object.freeze({
  cacheMs: 5 * MINUTE,
  // A local freshness policy, not a promised NMC publication interval.
  maxAgeMs: 60 * MINUTE,
  futureToleranceMs: 5 * MINUTE,
  timeoutMs: 10_000,
  pageBytes: 512 * 1024,
  imageBytes: 5 * 1024 * 1024,
  redirects: 3,
  catalogMs: 24 * 60 * MINUTE,
  catalogRetryMs: 5 * MINUTE,
  catalogConcurrency: 3,
  catalogPageSize: 12,
  imageCacheEntries: 16,
  imageCacheBytes: 24 * 1024 * 1024,
});

const SOURCES = Object.freeze({
  北京: { kind: 'station', name: '大兴', province: '北京', station: 'AZ9010', label: '北京·大兴', pageUrl: 'https://www.nmc.cn/publish/radar/bei-jing/da-xing.htm' },
  天津: { kind: 'station', name: '塘沽', province: '天津', station: 'AZ9220', label: '天津·塘沽', pageUrl: 'https://www.nmc.cn/publish/radar/tian-jin/tian-jin.htm' },
});
const CATALOG_REGION_URL = 'https://www.nmc.cn/publish/radar/chinaall.html';
const REGION_CODES = Object.freeze({ 全国: 'ACHN', 华北: 'ANCN', 东北: 'ANEC', 华东: 'AECN', 华中: 'ACCN', 华南: 'ASCN', 西南: 'ASWC', 西北: 'ANWC' });

export class RadarError extends Error {
  constructor(code, message, { suggestions = [] } = {}) {
    super(message);
    this.name = 'RadarError';
    this.code = code;
    this.suggestions = suggestions;
  }
}

const fail = (code, message) => { throw new RadarError(code, message); };
const sourceFailure = () => fail('RADAR_SOURCE_CHANGED', '中央气象台雷达页面暂时没有可核验的原图，请稍后重试。');

function queryText(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 64 || (!allowEmpty && !value.trim())
      || (value.trim() && !/^[\p{Script=Han}A-Za-z0-9 ()（）·_-]+$/u.test(value.trim()))) {
    fail('NOT_FOUND', '请输入官方雷达区域或站名；发送“雷达目录”查看可用名称。');
  }
  return value.trim();
}

const normalized = (value) => value.replace(/[\s()（）·_-]/g, '').replace(/(?:壮族|回族|维吾尔)?自治区$|[省市]$/g, '').toLowerCase();

function catalogPageUrl(input) {
  const url = officialUrl(new URL(input, 'https://www.nmc.cn').href, 'page');
  if (!/^\/publish\/(?:radar\/[a-z0-9/-]+\.html?|tianqishikuang\/leidatu\/(?:danzhanleida|leidapintu)\/[a-z0-9/-]+\.html?)$/i.test(url.pathname)
      || url.search) fail('RADAR_SOURCE_REJECTED', '官方雷达目录链接格式发生变化，已停止下载。');
  return url.href;
}

function navigation(html, level) {
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    const classes = (attributes(match[0]).get('class') ?? '').split(/\s+/);
    if (!classes.includes('p-nav') || !classes.includes(`nav${level}`)) continue;
    const end = html.indexOf('</ul>', match.index);
    if (end < 0) sourceFailure();
    const block = html.slice(match.index + match[0].length, end);
    const links = [];
    for (const link of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const href = attributes(link[1]).get('href');
      const name = link[2].replace(/<[^>]*>/g, '').trim();
      if (!href || !name || name.length > 40 || !/^[\p{Script=Han}A-Za-z0-9 ()（）·_-]+$/u.test(name)) sourceFailure();
      links.push({ name, pageUrl: catalogPageUrl(href) });
    }
    return [...new Map(links.map((entry) => [`${entry.name}|${entry.pageUrl}`, entry])).values()];
  }
  sourceFailure();
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

function officialUrl(input, kind) {
  let url;
  try { url = new URL(input); } catch { return sourceFailure(); }
  const host = kind === 'page' ? 'www.nmc.cn' : 'image.nmc.cn';
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || url.hash) {
    fail('RADAR_SOURCE_REJECTED', '雷达来源地址未通过官方域名校验，已停止下载。');
  }
  return url;
}

async function boundedBody(response, maxBytes) {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBytes) {
    await response.body?.cancel();
    fail('RADAR_TOO_LARGE', '官方雷达文件超出本地下载大小限制，请稍后重试。');
  }
  if (!response.body) sourceFailure();
  const reader = response.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        fail('RADAR_TOO_LARGE', '官方雷达文件超出本地下载大小限制，请稍后重试。');
      }
      parts.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!bytes) sourceFailure();
  return Buffer.concat(parts, bytes);
}

async function download(fetchImpl, input, kind, timeoutMs) {
  let url = officialUrl(input, kind);
  const originalPath = url.pathname;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetchImpl(url.href, {
        redirect: 'manual', signal,
        headers: { accept: kind === 'page' ? 'text/html' : 'image/png,image/jpeg' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects >= RADAR_LIMITS.redirects) {
          fail('RADAR_SOURCE_REJECTED', '官方雷达下载重定向异常，请稍后重试。');
        }
        url = officialUrl(new URL(location, url).href, kind);
        if (kind === 'image' && url.pathname !== originalPath) {
          fail('RADAR_SOURCE_REJECTED', '官方雷达原图地址发生变化，无法核验观测时间，已停止下载。');
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail('RADAR_UNAVAILABLE', '中央气象台雷达数据暂时不可用，请稍后重试。');
      }
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (kind === 'page' ? mimeType !== 'text/html' : !['image/png', 'image/jpeg'].includes(mimeType)) {
        await response.body?.cancel();
        sourceFailure();
      }
      const buffer = await boundedBody(response, kind === 'page' ? RADAR_LIMITS.pageBytes : RADAR_LIMITS.imageBytes);
      return { buffer, mimeType, url: url.href };
    }
  } catch (error) {
    if (error instanceof RadarError) throw error;
    if (signal.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      fail('RADAR_TIMEOUT', '下载官方雷达图超时，请稍后重试。');
    }
    // Do not expose request objects, network error details, or arbitrary upstream text.
    fail('RADAR_UNAVAILABLE', '暂时无法连接中央气象台雷达数据源，请稍后重试。');
  }
}

function attributes(tag) {
  const values = new Map();
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    values.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]);
  }
  return values;
}

function beijingTime(issuedAt) {
  return new Date(issuedAt + 8 * 60 * MINUTE).toISOString().slice(0, 16).replace('T', ' ');
}

function latestFrame(html, source) {
  const frames = [];
  if (!source.station) {
    const title = html.match(/<title\b[^>]*>([^<]+)<\/title>/i)?.[1]?.split('_');
    const expected = source.kind === 'region' ? ['雷达拼图', source.name] : [source.province, source.name];
    if (!title || expected.some((name, index) => title[title.length - expected.length + index] !== name)) sourceFailure();
  }
  const pattern = /^\/product\/\d{4}\/\d{2}\/\d{2}\/RDCP\/(?:medium\/)?SEVP_AOC_RDCP_SLDAS3_ECREF_([A-Z0-9]+)_L88_PI_(\d{14})\d{3}\.(?:png|jpe?g)$/i;
  let productCode;
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (!(attrs.get('class') ?? '').split(/\s+/).includes('time') || !attrs.has('data-img')) continue;
    const imageUrl = officialUrl(attrs.get('data-img').replaceAll('&amp;', '&'), 'image');
    const parsed = imageUrl.pathname.match(pattern);
    const code = parsed?.[1];
    const stamp = parsed?.[2];
    const expectedCode = source.station ?? (source.kind === 'region' ? REGION_CODES[source.name] : undefined);
    if (!stamp || (expectedCode && code !== expectedCode)
        || !(source.kind === 'region' ? /^A[A-Z]{3}$/ : /^AZ\d+$/).test(code)
        || (productCode && productCode !== code)) sourceFailure();
    productCode = code;
    const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
    const issuedAt = Date.parse(iso);
    if (!Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== iso) sourceFailure();
    const local = beijingTime(issuedAt);
    const expectedLabel = `${local.slice(5, 7)}/${local.slice(8, 10)} ${local.slice(11, 16)}`;
    const utcLabel = `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
    // NMC's Huludao original labels 20:49 BJT for a 12:49 UTC filename,
    // while its page timeline displays 12:49 directly. Accept only the exact
    // UTC or Beijing label; issuedAt and freshness always use filename UTC.
    if (![expectedLabel, utcLabel].includes(attrs.get('data-time'))) sourceFailure();
    frames.push({ imageUrl: imageUrl.href, issuedAt });
  }
  if (!frames.length) sourceFailure();
  return frames.sort((a, b) => b.issuedAt - a.issuedAt)[0];
}

function checkFreshness(issuedAt, now) {
  if (issuedAt > now + RADAR_LIMITS.futureToleranceMs) {
    fail('RADAR_TIME_INVALID', '官方雷达图时间与本机时间不一致，已停止发送，请稍后重试。');
  }
  if (now - issuedAt > RADAR_LIMITS.maxAgeMs) {
    fail('RADAR_STALE', `官方页最新雷达图为${beijingTime(issuedAt)}（北京时间），已超过60分钟，本次未发送旧图。`);
  }
}

function verifyImage(buffer, mimeType) {
  const png = buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && buffer.subarray(12, 16).toString('ascii') === 'IHDR'
    && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(16) <= 8192
    && buffer.readUInt32BE(20) > 0 && buffer.readUInt32BE(20) <= 8192
    && buffer.subarray(-12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  const jpeg = buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (!(mimeType === 'image/png' ? png : jpeg)) sourceFailure();
}

const copyResult = (result) => ({ ...result, buffer: Buffer.from(result.buffer) });

/** Official menu discovery is independent of on-demand, unmodified image downloads. */
export class RadarService {
  #fetch;
  #now;
  #timeout;
  #cache = new Map();
  #pending = new Map();
  #catalog;
  #catalogPending;
  #catalogRetryAt = 0;

  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = RADAR_LIMITS.timeoutMs } = {}) {
    if (typeof fetchImpl !== 'function' || typeof now !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RADAR_LIMITS.timeoutMs) {
      throw new TypeError('Invalid radar service dependencies');
    }
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#timeout = timeoutMs;
  }

  async get(inputTarget) {
    const target = queryText(inputTarget);
    const key = normalized(target);
    let source = Object.hasOwn(SOURCES, key) ? SOURCES[key] : undefined;
    if (!source) {
      const catalog = await this.#getCatalog();
      const exact = catalog.entries.filter((entry) => [entry.name, entry.label, entry.province ?? ''].some((name) => normalized(name) === key));
      const matches = exact.length ? exact : catalog.entries.filter((entry) => normalized(entry.label).includes(key));
      if (!matches.length) fail('NOT_FOUND', '未找到该雷达区域或站名；发送“雷达目录”或“雷达目录 省名”查看官方目录。');
      if (matches.length > 1) {
        const suggestions = matches.map((entry) => entry.label);
        throw new RadarError('AMBIGUOUS_TARGET', `该名称对应多个雷达目标，请用完整名称：${suggestions.slice(0, 12).join('、')}${suggestions.length > 12 ? '等；发送“雷达目录 省名”查看全部' : ''}。`, { suggestions });
      }
      [source] = matches;
    }
    const cacheKey = source.pageUrl;
    const cached = this.#cache.get(cacheKey);
    const now = this.#now();
    for (const [entryKey, entry] of this.#cache) {
      if (now < entry.fetchedAt || now - entry.fetchedAt >= RADAR_LIMITS.cacheMs) this.#cache.delete(entryKey);
    }
    if (cached && now >= cached.fetchedAt && now - cached.fetchedAt < RADAR_LIMITS.cacheMs) {
      checkFreshness(Date.parse(cached.result.issuedAt), now);
      return copyResult(cached.result);
    }
    this.#cache.delete(cacheKey);
    let pending = this.#pending.get(cacheKey);
    if (!pending) {
      pending = this.#load(source).finally(() => this.#pending.delete(cacheKey));
      this.#pending.set(cacheKey, pending);
    }
    return copyResult(await pending);
  }

  async list(inputQuery = '', { page: explicitPage } = {}) {
    let query = queryText(inputQuery, true);
    const pageMatch = query.match(/^(.*?)\s+(\d+)$/);
    const page = explicitPage ?? (pageMatch ? Number(pageMatch[2]) : 1);
    if (pageMatch) query = pageMatch[1].trim();
    if (!Number.isInteger(page) || page < 1) fail('NOT_FOUND', '目录页码需为正整数，例如“雷达目录 新疆 2”。');
    const catalog = await this.#getCatalog();
    const regions = catalog.entries.filter((entry) => entry.kind === 'region');
    const stations = catalog.entries.filter((entry) => entry.kind === 'station');
    const provinces = catalog.provinces.map((name) => ({ name, count: stations.filter((entry) => entry.province === name).length }));
    const metadata = { stationCount: stations.length, regionCount: regions.length, provinces, updatedAt: new Date(catalog.fetchedAt).toISOString() };
    if (!query) {
      const text = `中央气象台雷达目录\n区域拼图（${regions.length}）：${regions.map((entry) => entry.name).join('、')}\n单站（${stations.length}站/${provinces.length}省级地区）：${provinces.map((entry) => `${entry.name}(${entry.count})`).join('、')}\n查站：雷达目录 广东\n翻页：雷达目录 新疆 2\n取图：发 雷达 华北 / 发 雷达 北京海坨山\n北京、天津默认分别为大兴、塘沽站。目录每日更新；实际出图以官方供应为准。`;
      if (text.length > 1300) sourceFailure();
      return {
        ...metadata, items: regions.map((entry) => ({ ...entry })), total: catalog.entries.length, page: 1, pages: 1,
        text,
      };
    }
    const key = normalized(query);
    const matches = catalog.entries.filter((entry) => normalized(entry.label).includes(key) || normalized(entry.province ?? '') === key);
    if (!matches.length) fail('NOT_FOUND', '目录中未找到匹配名称；发送“雷达目录”查看区域和省份。');
    const pages = Math.ceil(matches.length / RADAR_LIMITS.catalogPageSize);
    if (page > pages) fail('NOT_FOUND', `该目录共${pages}页，请使用有效页码。`);
    const items = matches.slice((page - 1) * RADAR_LIMITS.catalogPageSize, page * RADAR_LIMITS.catalogPageSize);
    const text = `中央气象台雷达目录：${query}（${matches.length}项，第${page}/${pages}页）\n${items.map((entry) => `${entry.label}${entry.kind === 'region' ? '（区域拼图）' : ''}`).join('\n')}\n取图：发 雷达 ${items[0].label}${page < pages ? `\n下一页：雷达目录 ${query} ${page + 1}` : ''}\n目录收录不保证该站当前有新图；无图或图已过期时会明确提示。`;
    if (text.length > 1300) sourceFailure();
    return { ...metadata, text, items: items.map((entry) => ({ ...entry })), total: matches.length, page, pages };
  }

  async #getCatalog() {
    const now = this.#now();
    if (this.#catalog && now >= this.#catalog.fetchedAt && now - this.#catalog.fetchedAt < RADAR_LIMITS.catalogMs) return this.#catalog;
    if (this.#catalogPending) return this.#catalogPending;
    if (now < this.#catalogRetryAt) fail('RADAR_CATALOG_UNAVAILABLE', '官方雷达目录暂时无法更新，请几分钟后重试。');
    this.#catalogPending = this.#loadCatalog().catch(() => {
      this.#catalogRetryAt = this.#now() + RADAR_LIMITS.catalogRetryMs;
      fail('RADAR_CATALOG_UNAVAILABLE', '官方雷达目录暂时无法完整读取，请几分钟后重试；未使用不完整目录。');
    }).finally(() => { this.#catalogPending = undefined; });
    return this.#catalogPending;
  }

  async #loadCatalog() {
    const [stationPage, regionPage] = await Promise.all([
      download(this.#fetch, SOURCES.北京.pageUrl, 'page', this.#timeout),
      download(this.#fetch, CATALOG_REGION_URL, 'page', this.#timeout),
    ]);
    const stationHtml = stationPage.buffer.toString('utf8');
    const provinces = navigation(stationHtml, 2);
    const regions = navigation(regionPage.buffer.toString('utf8'), 2);
    if (!provinces.length || provinces.length > 50 || !regions.length || regions.length > 30) sourceFailure();
    const groupedStations = await mapLimited(provinces, RADAR_LIMITS.catalogConcurrency, async (province) => {
      const html = province.pageUrl === SOURCES.北京.pageUrl ? stationHtml
        : (await download(this.#fetch, province.pageUrl, 'page', this.#timeout)).buffer.toString('utf8');
      const links = navigation(html, 3);
      if (!links.length || links.length > 200) sourceFailure();
      return links.map((entry) => ({ ...entry, kind: 'station', province: province.name, label: `${province.name}·${entry.name}` }));
    });
    const entries = [...regions.map((entry) => ({ ...entry, kind: 'region', label: entry.name })), ...groupedStations.flat()];
    // A province list without one province's station menu must never become a partial catalog.
    if (new Set(entries.map((entry) => entry.pageUrl)).size !== entries.length) sourceFailure();
    const catalog = { entries, provinces: provinces.map((entry) => entry.name), fetchedAt: this.#now() };
    this.#catalog = catalog;
    this.#catalogRetryAt = 0;
    return catalog;
  }

  async #load(source) {
    const page = await download(this.#fetch, source.pageUrl, 'page', this.#timeout);
    const frame = latestFrame(page.buffer.toString('utf8'), source);
    checkFreshness(frame.issuedAt, this.#now());
    const image = await download(this.#fetch, frame.imageUrl, 'image', this.#timeout);
    verifyImage(image.buffer, image.mimeType);
    checkFreshness(frame.issuedAt, this.#now());
    const result = {
      kind: 'image', city: source.province ?? source.name, target: source.label, targetKind: source.kind, buffer: image.buffer, mimeType: image.mimeType,
      sourceUrl: image.url, pageUrl: source.pageUrl,
      issuedAt: new Date(frame.issuedAt).toISOString(),
      caption: `${source.label} ${source.kind === 'region' ? '区域雷达拼图' : '单站雷达实况'}（组合反射率）\n官方页时间：${beijingTime(frame.issuedAt)}（北京时间；精确观测时刻见原图）。\n来源：中央气象台 ${source.pageUrl}\n原图保留图例及署名；雷达实况不等同于后续天气预报。`,
    };
    this.#cache.set(source.pageUrl, { fetchedAt: this.#now(), result });
    let cacheBytes = [...this.#cache.values()].reduce((total, entry) => total + entry.result.buffer.length, 0);
    while (this.#cache.size > RADAR_LIMITS.imageCacheEntries || cacheBytes > RADAR_LIMITS.imageCacheBytes) {
      const oldestKey = this.#cache.keys().next().value;
      cacheBytes -= this.#cache.get(oldestKey).result.buffer.length;
      this.#cache.delete(oldestKey);
    }
    return result;
  }
}
