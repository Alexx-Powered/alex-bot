import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_ORIGIN = 'http://127.0.0.1:19327';
const DEFAULT_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_RESPONSE_BYTES = 64 * 1024;
const validCityQuery = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && /^[\p{Script=Han}\p{Script=Latin}\d ·（）()，,.'-]+$/u.test(value) && !['__proto__','constructor','toString'].includes(value);
const WEATHER_ERROR_CODES = new Set(['LOCATION_AMBIGUOUS', 'LOCATION_NOT_FOUND', 'LOCATION_INPUT_INVALID', 'LOCATION_SOURCE_UNAVAILABLE', 'DAILY_CITY_RESTRICTED']);
const CODES = new Set([
  'OK', 'SENT', 'DUPLICATE', 'NOT_CONFIGURED', 'NOT_CONNECTED', 'NOT_PAIRED',
  'OWNER_NOT_PAIRED', 'PAUSED', 'RATE_LIMITED', 'DAILY_LIMIT', 'DAILY_LIMIT_REACHED',
  'MINUTE_LIMIT', 'INVALID_TEXT', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_INPUT',
  'IDEMPOTENCY_CONFLICT', 'DELIVERY_UNKNOWN', 'SEND_FAILED', 'NETWORK_ERROR',
  'TIMEOUT', 'FORBIDDEN', 'REJECTED', 'CONTENT_REJECTED', 'RECIPIENT_REJECTED',
  'NO_PERMISSION', 'OFFLINE', 'STOPPED', 'UNAVAILABLE', 'AUTH_FAILED',
  'TRANSPORT_UNAVAILABLE', 'PERMANENT_FAILURE', 'UNKNOWN', 'UNPAIRED',
  'NOT_READY', 'LOCAL_PAUSE', 'OWNER_PAUSE', 'DELIVERY_UNCERTAIN', 'STORAGE_ERROR',
  'PERMISSION_DENIED', 'PLATFORM_REJECTED', 'FATAL_ERROR', 'SENDING',
  'RATE_LIMIT_DAY', 'RATE_LIMIT_REPLY_DAY', 'RATE_LIMIT_MINUTE', 'HISTORY_FULL', 'NOT_ATTEMPTED', 'MORNING_NOT_ENABLED', 'MORNING_ANALYSIS_UNAVAILABLE',
  'QQ_BOT_BANNED', 'QQ_BOT_UNAVAILABLE', 'QQ_RECONNECT_EXHAUSTED',
  'QQ_GATEWAY_STOPPED', 'QQ_RATE_LIMITED', 'QQ_PERMISSION_DENIED',
  'QQ_DISCONNECTED', 'QQ_CONNECTION_ERROR', 'QQ_MESSAGE_HANDLER_FAILED',
  'QQ_CONNECTION_ENDED', 'QQ_CONNECT_FAILED',
]);
const STATES = new Set(['idle', 'unconfigured', 'disconnected', 'connecting', 'reconnecting', 'connected', 'ready', 'error', 'stopped', 'offline', 'blocked']);

export class BridgeClientError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BridgeClientError';
    this.code = code;
  }
}

function safeCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  return CODES.has(value) || /^\d{3,9}$/.test(value) ? value : 'UNKNOWN';
}

// Deliberately project documented, non-secret fields. Never return arbitrary
// bridge bodies, error messages, credentials, received messages, or owner IDs.
export function projectStatus(body) {
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    throw new BridgeClientError('BRIDGE_INVALID_RESPONSE');
  }
  const result = { ok: body.ok };
  if (typeof body.configured === 'boolean') result.configured = body.configured;
  if (/^\d+\.\d+\.\d+$/.test(body.version ?? '')) result.version = body.version;
  const transport = body.transport;
  if (transport && typeof transport === 'object') {
    result.transport = {};
    if (STATES.has(transport.state)) result.transport.state = transport.state;
    if (safeCode(transport.code) !== undefined) result.transport.code = safeCode(transport.code);
  }
  const core = body.core;
  if (core && typeof core === 'object') {
    result.core = {};
    for (const key of ['ready', 'paired', 'pendingPairing', 'paused']) {
      if (typeof core[key] === 'boolean') result.core[key] = core[key];
    }
    for (const key of ['dailyAttempts', 'minuteAttempts', 'uncertainDeliveries', 'groupCount', 'remainingDailyAttempts']) {
      if (Number.isSafeInteger(core[key]) && core[key] >= 0) result.core[key] = core[key];
    }
    if(core.limits&&typeof core.limits==='object'){
      result.core.limits={};
      for(const key of ['dailyAttempts','minuteAttempts','reservedNotifications','replyDailyAttempts'])if(Number.isSafeInteger(core.limits[key])&&core.limits[key]>=0&&core.limits[key]<=1000)result.core.limits[key]=core.limits[key];
    }
    for (const key of ['pauseReason', 'lastDeliveryCode']) {
      if (safeCode(core[key]) !== undefined) result.core[key] = safeCode(core[key]);
    }
  }
  if (!body.ok) result.code = safeCode(body.code) ?? 'BRIDGE_RESPONSE_ERROR';
  return result;
}

export function projectNotify(body) {
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean') {
    throw new BridgeClientError('BRIDGE_INVALID_RESPONSE');
  }
  const result = { ok: body.ok, code: safeCode(body.code) ?? (body.ok ? 'OK' : 'BRIDGE_RESPONSE_ERROR') };
  for (const key of ['duplicate', 'sent']) {
    if (typeof body[key] === 'boolean') result[key] = body[key];
  }
  if (['inFlight', 'sent', 'rejected', 'uncertain'].includes(body.deliveryState)) result.deliveryState = body.deliveryState;
  return result;
}

export function projectBroadcast(body) {
  const base = projectNotify(body);
  if (!Array.isArray(body.results) || body.results.length > 11) throw new BridgeClientError('BRIDGE_INVALID_RESPONSE');
  const result = { ok: base.ok, code: base.code, results: body.results.map(entry => {
    if (!entry || typeof entry.destination !== 'string' || !entry.destination.trim() || entry.destination !== entry.destination.trim() ||
        entry.destination.length > 80 || /[\u0000-\u001f\u007f]/u.test(entry.destination)) throw new BridgeClientError('BRIDGE_INVALID_RESPONSE');
    const projected = projectNotify(entry);
    return { destination: entry.destination, ok: projected.ok, code: projected.code,
      ...(projected.deliveryState ? { deliveryState: projected.deliveryState } : {}) };
  }) };
  for (const key of ['attempted', 'sent']) {
    if (Number.isSafeInteger(body[key]) && body[key] >= 0 && body[key] <= 11) result[key] = body[key];
  }
  return result;
}

// Weather errors have their own narrow projection; never return backend error
// messages, raw locations, credentials or additional response properties.
export function projectWeatherError(body) {
  if (body?.ok !== false || !WEATHER_ERROR_CODES.has(body.code)) return null;
  const result = { ok: false, code: body.code };
  if (body.code === 'LOCATION_AMBIGUOUS' && Array.isArray(body.suggestions)) {
    result.suggestions = body.suggestions.filter(value => validCityQuery(value) && value === value.trim()).slice(0, 8);
  }
  return result;
}

export function createBridgeClient({ home = process.env.QQ_BRIDGE_HOME || DEFAULT_HOME, timeoutMs = 10_000, port = 19327 } = {}) {
  // Trusted local construction only: public MCP arguments never select a port
  // or host. Tests inject an ephemeral loopback port without touching live QQ.
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BridgeClientError('BRIDGE_INVALID_PORT');
  const origin = `http://127.0.0.1:${port}`;
  const tokenPath = resolve(home, '.private', 'admin-token');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new BridgeClientError('BRIDGE_INVALID_TIMEOUT');
  }

  async function request(path, payload) {
    // There is no URL override, destination parameter, redirect, or proxy path.
    const url = new URL(path, origin);
    if (url.origin !== origin || !['/api/status', '/api/notify', '/api/notify-all-allowed', '/api/weather/preview', '/api/weather/briefing', '/api/morning/test-all-allowed'].includes(url.pathname) || url.search || url.hash) {
      throw new BridgeClientError('BRIDGE_INVALID_ENDPOINT');
    }
    let token;
    try {
      token = (await readFile(tokenPath, 'utf8')).trim();
    } catch {
      throw new BridgeClientError('BRIDGE_NOT_INITIALIZED');
    }
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new BridgeClientError('BRIDGE_INVALID_TOKEN');
    const data = payload === undefined ? undefined : JSON.stringify(payload);

    return new Promise((resolveResult, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolveResult(value);
      };
      const req = http.request(url, {
        method: data === undefined ? 'GET' : 'POST',
        agent: false,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }),
        },
      });
      const timer = setTimeout(() => {
        finish(new BridgeClientError('BRIDGE_TIMEOUT'));
        req.destroy();
      }, timeoutMs);
      req.on('error', () => finish(new BridgeClientError('BRIDGE_UNAVAILABLE')));
      req.on('response', (res) => {
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new BridgeClientError('BRIDGE_INVALID_RESPONSE'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () => finish(new BridgeClientError('BRIDGE_UNAVAILABLE')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const code = res.statusCode === 401 || res.statusCode === 403 ? 'BRIDGE_AUTH_FAILED'
              : res.statusCode === 429 ? 'BRIDGE_RATE_LIMITED' : 'BRIDGE_HTTP_ERROR';
            finish(new BridgeClientError(code));
            return;
          }
          try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new BridgeClientError('BRIDGE_INVALID_RESPONSE')); }
        });
      });
      req.end(data);
    });
  }

  return Object.freeze({
    async status() { return projectStatus(await request('/api/status')); },
    async weatherPreview({cities=['beijing']}={}) {
      if(!Array.isArray(cities)||cities.length<1||cities.length>2||cities.some(c=>!validCityQuery(c))) throw new BridgeClientError('BRIDGE_INVALID_INPUT');
      const data=await request('/api/weather/preview',{cities});
      const error=projectWeatherError(data); if(error)return error;
      if(data?.ok!==true||typeof data.text!=='string'||data.text.length>1500) throw new BridgeClientError('BRIDGE_INVALID_RESPONSE');
      return {ok:true,text:data.text,date:/^\d{4}-\d{2}-\d{2}$/.test(data.date)?data.date:undefined};
    },
    async weatherBriefing({cities,mode='daily'}={}) {
      if (cities === undefined && mode === 'test') cities = ['beijing'];
      if(!['daily','test'].includes(mode)||(cities!==undefined&&(!Array.isArray(cities)||cities.length<1||cities.length>2||cities.some(c=>!validCityQuery(c))))) throw new BridgeClientError('BRIDGE_INVALID_INPUT');
      const data=await request('/api/weather/briefing',{mode,...(cities===undefined?{}:{cities})});
      return projectWeatherError(data) ?? projectNotify(data);
    },
    async notify({ text, idempotencyKey }) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1500
        || typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(idempotencyKey)) {
        throw new BridgeClientError('BRIDGE_INVALID_INPUT');
      }
      return projectNotify(await request('/api/notify', { text, idempotencyKey }));
    },
    async broadcast({ text, idempotencyKey }) {
      if (typeof text !== 'string' || !text.trim() || text.length > 1500 ||
          typeof idempotencyKey !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(idempotencyKey)) {
        throw new BridgeClientError('BRIDGE_INVALID_INPUT');
      }
      return projectBroadcast(await request('/api/notify-all-allowed', { text, idempotencyKey }));
    },
    async morningTestAllAllowed({idempotencyKey}) {
      if(typeof idempotencyKey!=='string'||!/^[a-zA-Z0-9._:-]{1,100}$/.test(idempotencyKey))throw new BridgeClientError('BRIDGE_INVALID_INPUT');
      return projectBroadcast(await request('/api/morning/test-all-allowed',{idempotencyKey}));
    },
  });
}
