// Standalone, opt-in public-source audit. No QQ client, bridge, state or credentials.
// Every catalog entry is attempted once. A failed/stale source is never a pass.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { RadarService, RadarError, RADAR_LIMITS } from '../src/radar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'test-output');
const REPORT = resolve(OUTPUT, 'radar-all-report.json');
const INTERVAL_MS = 500;
const CONCURRENCY = 2;
const PREVIEWS = new Map([
  ['全国', 'radar-all-national'], ['华北', 'radar-all-north-china'],
  ['北京·大兴', 'radar-all-beijing-daxing'], ['广东·广州', 'radar-all-guangzhou'],
]);
const contexts = new AsyncLocalStorage();
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 1, startedAt, finishedAt: null, outcome: 'running',
  policy: { maximumConcurrency: CONCURRENCY, minimumRequestStartIntervalMs: INTERVAL_MS,
    attemptPerEntry: 1, retries: 0, maxImageAgeMinutes: RADAR_LIMITS.maxAgeMs / 60000,
    stopOnExplicitRateLimit: true, qqImportedOrContacted: false,
    source: 'NMC official menu and unmodified latest image',
    note: 'A directory entry is not a promise that its station currently publishes a fresh image.',
    pageEvidenceTimeNote: 'page.latestFrame.issuedAt parses the filename as UTC for diagnostics; only a successful result confirms this agrees with the page label. Failed entries must not be treated as having a verified issue time.' },
  catalog: { complete: false, requests: [] }, entries: [],
  network: { requestCount: 0, maxActive: 0, minimumObservedStartIntervalMs: null },
  stop: null, counts: {},
};
let active = 0;
const waiters = [];
let lastStart = 0;
let startGate = Promise.resolve();
let saveQueue = Promise.resolve();
let completed = 0;

function stop(reason, details = {}) {
  report.stop ??= { reason, at: new Date().toISOString(), ...details };
}
function stoppedError() {
  return new RadarError(report.stop?.reason === 'RATE_LIMITED' ? 'RADAR_RATE_LIMITED' : 'RADAR_AUDIT_STOPPED', 'Full radar audit stopped.');
}
process.once('SIGINT', () => stop('INTERRUPTED'));
process.once('SIGTERM', () => stop('INTERRUPTED'));

async function acquire() {
  if (active >= CONCURRENCY) await new Promise(resolveWaiter => waiters.push(resolveWaiter));
  else active += 1;
  report.network.maxActive = Math.max(report.network.maxActive, active);
}
function release() {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
}
async function requestStart() {
  const turn = startGate.then(async () => {
    if (report.stop) throw stoppedError();
    while (lastStart + INTERVAL_MS > Date.now()) await delay(lastStart + INTERVAL_MS - Date.now());
    if (report.stop) throw stoppedError();
    const now = Date.now();
    if (lastStart) report.network.minimumObservedStartIntervalMs = Math.min(
      report.network.minimumObservedStartIntervalMs ?? Infinity, now - lastStart);
    lastStart = now;
  });
  startGate = turn.catch(() => {});
  return turn;
}
function attributes(tag) {
  return new Map([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
}
function pageEvidence(html) {
  const frames = [];
  for (const match of html.matchAll(/<div\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (!(attrs.get('class') ?? '').split(/\s+/).includes('time') || !attrs.has('data-img')) continue;
    const imageUrl = attrs.get('data-img').replaceAll('&amp;', '&');
    const stamp = imageUrl.match(/_PI_(\d{14})\d{3}\./)?.[1];
    const issuedAt = stamp ? `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:${stamp.slice(12,14)}.000Z` : null;
    frames.push({ imageUrl, displayedTime: attrs.get('data-time') ?? null, issuedAt });
  }
  frames.sort((a, b) => (Date.parse(b.issuedAt) || 0) - (Date.parse(a.issuedAt) || 0));
  return { title: html.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1] ?? null,
    frameCount: frames.length, latestFrame: frames[0] ?? null,
    noDataPlaceholder: /(?:nodata|no-data|暂无数据)/i.test(html),
    // Structural evidence helps distinguish changed markup from a missing image.
    imageProducts: [...new Set([...html.matchAll(/SEVP_[A-Z0-9_]+\.(?:png|jpe?g)/gi)].map(m => m[0]))].slice(0, 3) };
}

async function auditFetch(url, options = {}) {
  if (report.stop) throw stoppedError();
  await acquire();
  let trace;
  try {
    await requestStart();
    if (options.signal?.aborted) throw options.signal.reason;
    const publicUrl = new URL(url);
    if (publicUrl.protocol !== 'https:' || !['www.nmc.cn', 'image.nmc.cn'].includes(publicUrl.hostname)
        || publicUrl.username || publicUrl.password || publicUrl.port) throw new Error('AUDIT_NONOFFICIAL_URL');
    trace = { url: publicUrl.href, startedAt: new Date().toISOString(), status: null };
    (contexts.getStore()?.requests ?? report.catalog.requests).push(trace);
    report.network.requestCount += 1;
    const response = await fetch(url, options);
    trace.status = response.status;
    trace.contentType = response.headers.get('content-type');
    trace.retryAfter = response.headers.get('retry-after');
    if (response.status === 429 || ([403, 503].includes(response.status) && trace.retryAfter !== null)) {
      trace.rateLimited = true;
      stop('RATE_LIMITED', { url: publicUrl.href, status: response.status });
      await response.body?.cancel();
      throw stoppedError();
    }
    const maxBytes = publicUrl.hostname === 'image.nmc.cn' ? RADAR_LIMITS.imageBytes : RADAR_LIMITS.pageBytes;
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new RadarError('RADAR_TOO_LARGE', 'Official response exceeds the audit size limit.');
          }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
    }
    trace.bytes = bytes;
    const buffer = Buffer.concat(chunks, bytes);
    if (/text\/|json/i.test(trace.contentType ?? '')) {
      const text = buffer.toString('utf8');
      if (/(?:too many requests|rate[ -]?limit(?:ed|ing)?|访问过于频繁|请求过于频繁|访问频繁|频率限制|访问频率过高|请求频率过高)/i.test(text)) {
        trace.rateLimited = true;
        stop('RATE_LIMITED', { url: publicUrl.href, status: response.status, evidence: 'explicit rate-limit text' });
        throw stoppedError();
      }
      if (publicUrl.hostname === 'www.nmc.cn' && response.ok) trace.page = pageEvidence(text);
    }
    return new Response([204, 205, 304].includes(response.status) ? null : buffer, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    if (trace) trace.errorCode = error instanceof RadarError ? error.code : ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'NETWORK_ERROR';
    throw error;
  } finally {
    if (trace) trace.finishedAt = new Date().toISOString();
    release();
  }
}

function counts() {
  const values = { total: report.entries.length, success: 0, stale: 0, sourceUnavailable: 0,
    rejected: 0, rateLimited: 0, notRun: 0, pending: 0 };
  for (const entry of report.entries) values[entry.status] = (values[entry.status] ?? 0) + 1;
  return values;
}
function diagnostic(entry) {
  if (entry.code !== 'RADAR_SOURCE_CHANGED') return undefined;
  const page = entry.requests.find(request => request.page)?.page;
  if (page?.frameCount === 0) return 'OFFICIAL_PAGE_HAS_NO_FRAME_LIST';
  const frame = page?.latestFrame;
  if (frame?.issuedAt) {
    const time = new Date(Date.parse(frame.issuedAt) + 8 * 3600000).toISOString();
    const expected = `${time.slice(5,7)}/${time.slice(8,10)} ${time.slice(11,16)}`;
    if (frame.displayedTime !== expected) return 'PAGE_LABEL_DIFFERS_FROM_FILENAME_UTC_PLUS_8';
  }
  return 'SOURCE_FORMAT_OR_IMAGE_REJECTED';
}
function save() {
  report.counts = counts();
  const snapshot = JSON.stringify(report, null, 2) + '\n';
  saveQueue = saveQueue.then(() => writeFile(REPORT, snapshot, 'utf8'));
  return saveQueue;
}
const sourceCodes = new Set(['RADAR_UNAVAILABLE', 'RADAR_TIMEOUT', 'RADAR_SOURCE_CHANGED', 'RADAR_CATALOG_UNAVAILABLE']);
async function check(service, entry) {
  entry.startedAt = new Date().toISOString();
  entry.attempts = 1;
  entry.requests = [];
  try {
    const result = await contexts.run(entry, () => service.get(entry.label));
    entry.status = 'success';
    entry.code = 'OK';
    entry.image = { sourceUrl: result.sourceUrl, pageUrl: result.pageUrl, issuedAt: result.issuedAt,
      ageMinutes: Math.round((Date.now() - Date.parse(result.issuedAt)) / 6000) / 10,
      mimeType: result.mimeType, bytes: result.buffer.length,
      sha256: createHash('sha256').update(result.buffer).digest('hex') };
    if (result.target !== entry.label || result.targetKind !== entry.kind || result.pageUrl !== entry.pageUrl) {
      entry.status = 'rejected';
      entry.code = 'AUDIT_RESULT_TARGET_MISMATCH';
    } else if (PREVIEWS.has(entry.label)) {
      const filename = `${PREVIEWS.get(entry.label)}.${result.mimeType === 'image/png' ? 'png' : 'jpg'}`;
      await writeFile(resolve(OUTPUT, filename), result.buffer);
      entry.preview = filename;
    }
  } catch (error) {
    entry.code = typeof error?.code === 'string' ? error.code : 'AUDIT_UNEXPECTED_ERROR';
    entry.status = entry.code === 'RADAR_STALE' ? 'stale'
      : entry.code === 'RADAR_RATE_LIMITED' ? (entry.requests.some(request => request.rateLimited) ? 'rateLimited' : 'notRun')
        : entry.code === 'RADAR_AUDIT_STOPPED' ? 'notRun'
          : sourceCodes.has(entry.code) ? 'sourceUnavailable' : 'rejected';
    // RadarError messages are fixed source-module text, not raw upstream bodies.
    if (error instanceof RadarError) entry.message = error.message;
  }
  entry.diagnostic = diagnostic(entry);
  entry.finishedAt = new Date().toISOString();
  completed += 1;
  if (completed % 20 === 0 || report.stop) {
    await save();
    console.log(JSON.stringify({ progress: `${completed}/${report.entries.length}`, counts: report.counts, stop: report.stop?.reason ?? null }));
  }
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  await save();
  const service = new RadarService({ fetchImpl: auditFetch });
  try {
    const summary = await service.list();
    const entries = new Map();
    const add = entry => {
      const existing = entries.get(entry.pageUrl);
      if (existing && (existing.label !== entry.label || existing.kind !== entry.kind)) throw new Error('CATALOG_CONFLICT');
      entries.set(entry.pageUrl, entry);
    };
    summary.items.forEach(add);
    const enumeration = [];
    for (const province of summary.provinces) {
      const first = await service.list(province.name);
      const found = [...first.items];
      for (let page = 2; page <= first.pages; page += 1) found.push(...(await service.list(province.name, { page })).items);
      const stations = found.filter(entry => entry.kind === 'station' && entry.province === province.name);
      if (stations.length !== province.count || new Set(stations.map(entry => entry.pageUrl)).size !== province.count) throw new Error('CATALOG_PROVINCE_COUNT_MISMATCH');
      stations.forEach(add);
      enumeration.push({ province: province.name, declaredCount: province.count, enumeratedCount: stations.length, pages: first.pages });
    }
    if (entries.size !== summary.total || [...entries.values()].filter(entry => entry.kind === 'station').length !== summary.stationCount) throw new Error('CATALOG_TOTAL_MISMATCH');
    report.catalog = { ...report.catalog, complete: true, updatedAt: summary.updatedAt,
      sourcePageCount: new Set(report.catalog.requests.map(request => request.url)).size,
      stationCount: summary.stationCount, regionCount: summary.regionCount,
      provinceCount: summary.provinces.length, total: summary.total, enumeration };
    report.entries = [...entries.values()].map(entry => ({ ...entry, status: 'pending', attempts: 0 }));
    await save();
    console.log(JSON.stringify({ catalog: { ...report.catalog, requests: undefined, enumeration: undefined } }));
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (!report.stop && next < report.entries.length) {
        const entry = report.entries[next++];
        await check(service, entry);
      }
    }));
  } catch (error) {
    report.catalog.errorCode = typeof error?.code === 'string' ? error.code : 'AUDIT_CATALOG_ENUMERATION_FAILED';
    stop(report.stop?.reason ?? 'CATALOG_UNAVAILABLE');
  }
  for (const entry of report.entries) if (entry.status === 'pending') {
    entry.status = 'notRun'; entry.code = report.stop?.reason ?? 'AUDIT_NOT_RUN';
  }
  report.finishedAt = new Date().toISOString();
  report.counts = counts();
  report.outcome = report.stop ? 'stopped' : report.counts.success === report.counts.total && report.catalog.complete ? 'all_sources_fresh' : 'completed_with_source_failures';
  await save();
  console.log(JSON.stringify({ report: REPORT, outcome: report.outcome, counts: report.counts, network: report.network, stop: report.stop }));
  process.exitCode = report.stop ? 2 : report.outcome === 'all_sources_fresh' ? 0 : 1;
}

await main();
