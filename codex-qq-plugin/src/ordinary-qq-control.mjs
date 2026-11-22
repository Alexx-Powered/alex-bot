import {createConnection} from 'node:net';

const socketPath = '/run/alexbot-ordinary-qq.sock';
const windowMs = 150_000;
const states = new Set(['active', 'activating', 'inactive', 'deactivating', 'failed', 'reloading']);
const unavailable = {ok:false, state:'unavailable'};

function request(operation) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const chunks = [];
    let length = 0;
    const deadline = setTimeout(() => socket.destroy(new Error('CONTROL_TIMEOUT')), 14_000);
    socket.on('connect', () => socket.write(operation + '\n'));
    socket.on('data', chunk => {
      length += chunk.length;
      if (length > 140_000) socket.destroy(new Error('INVALID_REPLY'));
      else chunks.push(chunk);
    });
    socket.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.ok !== true) throw new Error('CONTROL_UNAVAILABLE');
        resolve(result);
      } catch (error) { reject(error); }
    });
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(deadline); reject(new Error('CONTROL_CLOSED')); });
  });
}

export class OrdinaryQQControl {
  constructor({call = request, now = Date.now, roster = () => 0} = {}) {
    this.call = call;
    this.now = now;
    this.roster = roster;
    this.retryAfter = 0;
  }

  async startLogin() {
    if (this.starting) return this.starting;
    if ((this.attempt && this.now() < this.attempt.until) || this.now() < this.retryAfter) return this.status();
    const started = this.now();
    this.retryAfter = started + 15_000;
    this.attempt = null;
    this.starting = this.call('start').then(base => {
      this.attempt = {base, started, until:started + windowMs};
      return this.view(base, this.attempt);
    }).catch(() => unavailable).finally(() => { this.starting = null; });
    return this.starting;
  }

  async status() {
    if (this.starting) return this.starting;
    const attempt = this.attempt;
    if (this.read && this.read.attempt === attempt) return this.read.result;
    const poll = attempt && !attempt.ended && this.now() < attempt.until;
    const read = {attempt};
    read.result = this.call(poll ? 'poll' : 'status').then(info => {
      if (attempt !== this.attempt || this.starting) return this.status();
      return this.view(info, attempt);
    }).catch(() => unavailable).finally(() => { if (this.read === read) this.read = null; });
    this.read = read;
    return read.result;
  }

  view(info, attempt) {
    const now = this.now();
    const services = {yogurt:states.has(info.yogurt) ? info.yogurt : 'unknown',
      nonebot:states.has(info.nonebot) ? info.nonebot : 'unknown', listening:info.listening === true};
    const live = services.yogurt === 'active' && services.nonebot === 'active' && services.listening;
    const rosterAt = this.roster();
    const changed = Boolean(attempt && info.invocation && info.invocation !== attempt.base.invocation);
    if (changed && attempt.invocation !== info.invocation) {
      attempt.invocation = info.invocation;
      attempt.observed = now;
    }
    if (live && rosterAt > (info.started || 0) && (!attempt || (changed && rosterAt > attempt.observed))) {
      this.attempt = null;
      return {ok:true, state:'online', services};
    }
    if (!attempt) return {ok:true, state:info.loginEvent || (live ? 'verifying' : 'offline'), services};
    const freshQr = changed && info.qrVersion && info.qrVersion !== attempt.base.qrVersion
      && info.qrTime >= attempt.started && info.qrTime <= now && typeof info.png === 'string';
    const expiresAt = Math.min(attempt.until, (info.qrTime || 0) + 115_000);
    if (attempt.ended || now >= attempt.until || (freshQr && expiresAt <= now)) {
      attempt.ended = attempt.ended || 'expired';
    } else if (changed && info.eventTime >= attempt.started && (!freshQr || info.eventTime >= info.qrTime)
               && ['expired', 'failed'].includes(info.loginEvent)) {
      attempt.ended = info.loginEvent;
    }
    if (attempt.ended) {
      attempt.until = 0;
      return {ok:true, state:attempt.ended, services};
    }
    if (freshQr && expiresAt > now) return {ok:true, state:'waiting_scan', services,
      png:info.png, expiresAt, remainingMs:expiresAt - now};
    return {ok:true, state:changed && live ? 'verifying' : 'starting', services, expiresAt:attempt.until};
  }
}
