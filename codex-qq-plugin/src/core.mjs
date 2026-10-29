import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sanitizeContextText } from './chat-safety.mjs';

export const CORE_LIMITS = Object.freeze({
  textLength: 1500,
  minuteAttempts: 3,
  dailyAttempts: 200,
  reservedNotifications: 10,
  pairingTtlMs: 5 * 60_000,
  historySize: 4096,
  allowedGroups: 10,
  grayGroups: 10,
});

const STORED_ATTEMPT_LIMIT = 4096;
const GROUP_CONTEXT_TTL_MS = 30 * 60_000;
const GROUP_CONTEXT_SIZE = 10;
const GROUP_CONTEXT_SEEN_LIMIT = 512;
const MAX_PENDING_INCOMING = 4;
const GROUP_PREFIX = /^(?:梁圣|梁祖|梁嗨|小难梁)\s+(\S[\s\S]*)$/u;
const ownerControlCommands = new Set(['/pause', '/status']);
const contextControl = text => text.startsWith('/') || /\/(?:pair|group-bind|pause|resume|status|notify|help|ping)\b/i.test(text) || ['帮助','菜单'].includes(text);
function sendingLimits(overrides) {
  const keys = ['dailyAttempts', 'minuteAttempts', 'reservedNotifications'];
  if (!overrides || typeof overrides !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(overrides)) ||
      Reflect.ownKeys(overrides).some(key => !keys.includes(key))) throw new TypeError('INVALID_CORE_LIMITS');
  const limits = Object.fromEntries(keys.map(key => [key, Object.hasOwn(overrides, key) ? overrides[key] : CORE_LIMITS[key]]));
  if (!Number.isInteger(limits.dailyAttempts) || limits.dailyAttempts < 10 || limits.dailyAttempts > 1000 ||
      !Number.isInteger(limits.minuteAttempts) || limits.minuteAttempts < 1 || limits.minuteAttempts > 30 ||
      !Number.isInteger(limits.reservedNotifications) || limits.reservedNotifications < 0 ||
      limits.reservedNotifications > Math.min(limits.dailyAttempts - 1, 100)) throw new TypeError('INVALID_CORE_LIMITS');
  return Object.freeze(limits);
}

const hash = (value) => createHash('sha256').update(value).digest('hex');
const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const validGroupId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validGroupName = (value) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(value);
const validGroupKey = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const groupKeyFor = (id) => hash(`group:${id}`);
const describeGroup = ({ id, name }) => ({ name, groupKey: groupKeyFor(id), groupHint: `sha256:${groupKeyFor(id).slice(0, 12)}` });
const hkDay = (time) => new Date(time + 8 * 60 * 60_000).toISOString().slice(0, 10);
const result = (ok, code, extra = {}) => ({ ok, code, ...extra });
const hint = (value) => value ? `sha256:${hash(value).slice(0, 12)}` : null;
const knownDeliveryStates = new Set(['inFlight', 'sent', 'rejected', 'uncertain']);
const knownPauseReasons = new Set([
  'UNPAIRED', 'LOCAL_PAUSE', 'OWNER_PAUSE', 'DELIVERY_UNCERTAIN', 'STORAGE_ERROR',
  'RATE_LIMITED', 'PERMISSION_DENIED', 'CONTENT_REJECTED', 'PLATFORM_REJECTED', 'FATAL_ERROR',
]);
const knownDeliveryCodes = new Set([
  'SENDING', 'SENT', 'DELIVERY_UNCERTAIN', 'STORAGE_ERROR', 'RATE_LIMITED',
  'PERMISSION_DENIED', 'CONTENT_REJECTED', 'PLATFORM_REJECTED', 'FATAL_ERROR',
]);

function initialState() {
  return {
    version: 1,
    ownerId: null,
    paused: true,
    pauseReason: 'UNPAIRED',
    attempts: [],
    deliveries: [],
    incoming: [],
    lastDeliveryCode: null,
    allowedGroups: [],
    grayGroups: [],
  };
}

function restoreState(raw) {
  if (raw == null) return initialState();
  if (raw.version !== 1 || (raw.ownerId !== null && !validId(raw.ownerId)) ||
      typeof raw.paused !== 'boolean' || !Array.isArray(raw.attempts) ||
      !Array.isArray(raw.deliveries) || !Array.isArray(raw.incoming) ||
      raw.attempts.length > STORED_ATTEMPT_LIMIT || raw.deliveries.length > CORE_LIMITS.historySize ||
      raw.incoming.length > CORE_LIMITS.historySize) throw new Error('STATE_INVALID');
  const isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const attempts = raw.attempts.map((entry) => {
    if (!Number.isSafeInteger(entry.at) || entry.at < 0 ||
        typeof entry.day !== 'string' || entry.day !== hkDay(entry.at)) throw new Error('STATE_INVALID');
    return { at: entry.at, day: entry.day };
  });
  const deliveries = raw.deliveries.map((entry) => {
    if (!isHash(entry.key) || !knownDeliveryStates.has(entry.state) ||
        !Number.isSafeInteger(entry.at) || entry.at < 0 ||
        !knownDeliveryCodes.has(entry.code)) throw new Error('STATE_INVALID');
    return { key: entry.key, state: entry.state, at: entry.at, code: entry.code };
  });
  const incoming = raw.incoming.map((key) => {
    if (!isHash(key)) throw new Error('STATE_INVALID');
    return key;
  });
  if (new Set(deliveries.map((entry) => entry.key)).size !== deliveries.length) throw new Error('STATE_INVALID');
  if (raw.pauseReason != null && !knownPauseReasons.has(raw.pauseReason)) throw new Error('STATE_INVALID');
  if (raw.lastDeliveryCode != null && !knownDeliveryCodes.has(raw.lastDeliveryCode)) throw new Error('STATE_INVALID');
  const groups = raw.allowedGroups === undefined ? [] : raw.allowedGroups;
  if (!Array.isArray(groups) || groups.length > CORE_LIMITS.allowedGroups || (groups.length && !raw.ownerId)) throw new Error('STATE_INVALID');
  const allowedGroups = groups.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        Object.keys(entry).length !== 2 || !validGroupId(entry.id) || !validGroupName(entry.name)) throw new Error('STATE_INVALID');
    return { id: entry.id, name: entry.name };
  });
  if (new Set(allowedGroups.map(entry => entry.id)).size !== allowedGroups.length) throw new Error('STATE_INVALID');
  const gray = raw.grayGroups === undefined ? [] : raw.grayGroups;
  if (!Array.isArray(gray) || gray.length > CORE_LIMITS.grayGroups || (gray.length && !raw.ownerId)) throw new Error('STATE_INVALID');
  const grayGroups=gray.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).length!==2||!validGroupId(entry.id)||!validGroupName(entry.name))throw new Error('STATE_INVALID');
    return {id:entry.id,name:entry.name};
  });
  if(new Set([...allowedGroups,...grayGroups].map(g=>g.id)).size!==allowedGroups.length+grayGroups.length)throw new Error('STATE_INVALID');
  return {
    version: 1,
    ownerId: raw.ownerId,
    paused: raw.ownerId ? raw.paused : true,
    pauseReason: raw.ownerId ? (raw.pauseReason ?? null) : 'UNPAIRED',
    attempts,
    deliveries,
    incoming,
    lastDeliveryCode: raw.lastDeliveryCode ?? null,
    allowedGroups,
    grayGroups,
  };
}

// Only return fixed categories. Upstream error text, URLs, message bodies and
// credentials must never reach status(), persisted state or API responses.
function classifyError(error) {
  if(error?.code==='QQ_SEND_CANCELLED'&&error?.messageAttempted===false)return {code:'PLATFORM_REJECTED',pause:false,uncertain:false};
  const status = Number(error?.httpStatus ?? error?.status ?? error?.statusCode);
  const category = `${error?.code ?? ''} ${error?.kind ?? ''}`.toLowerCase().slice(0, 256);
  const bizCode = error?.bizCode;
  if (status === 429 || /rate.?limit|too.?many|\b429\b/.test(category)) {
    return { code: 'RATE_LIMITED', pause: true, uncertain: false };
  }
  if (status === 401 || status === 403 || /permission|forbidden|unauthori|auth.?fail/.test(category)) {
    return { code: 'PERMISSION_DENIED', pause: true, uncertain: false };
  }
  if (/content|sensitive|moderation/.test(category)) {
    return { code: 'CONTENT_REJECTED', pause: true, uncertain: false };
  }
  if (error?.fatal === true || /fatal/.test(category)) {
    return { code: 'FATAL_ERROR', pause: true, uncertain: error?.messageAttempted !== false && !(status >= 400 || (bizCode != null && String(bizCode) !== '0')) };
  }
  if ((status >= 400 && status < 500) || /reject|invalid.?target|invalid.?reply|expired.?reply|reply.*(?:invalid|expired)|target.*(?:invalid|expired)/.test(category) ||
      (bizCode !== undefined && bizCode !== null && String(bizCode) !== '0')) {
    return { code: 'PLATFORM_REJECTED', pause: true, uncertain: false };
  }
  if (error?.messageAttempted === false) return { code: 'PLATFORM_REJECTED', pause: true, uncertain: false };
  return { code: 'DELIVERY_UNCERTAIN', pause: true, uncertain: true };
}

/** Owner C2C notifications and explicitly allowed group replies share one serial queue. */
export class BridgeCore {
  #loadState;
  #saveState;
  #send;
  #now;
  #state = initialState();
  #ready = false;
  #tail = Promise.resolve();
  #pairing = null;
  #candidate = null;
  #groupPairing = null;
  #groupCandidate = null;
  #commandHandler;
  #pauseRequested = false;
  #limits;
  #groupContexts = new Map();
  #pendingIncoming = 0;
  #groupRestrictions = new Map();

  constructor({ loadState, saveState, send, now = Date.now, commandHandler = null, limits = {} }) {
    if (![loadState, saveState, send, now].every((fn) => typeof fn === 'function')) {
      throw new TypeError('INVALID_CORE_DEPENDENCIES');
    }
    this.#loadState = loadState;
    this.#saveState = saveState;
    this.#send = send;
    this.#now = now;
    this.#commandHandler = commandHandler;
    this.#limits = sendingLimits(limits);
  }

  #time() {
    const value = Number(this.#now());
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CLOCK');
    return value;
  }

  #budgetCode(now, { reply = false, count = 1 } = {}) {
    const dayAttempts = this.#state.attempts.filter(entry => entry.day === hkDay(now)).length;
    if (reply && dayAttempts + count > this.#limits.dailyAttempts - this.#limits.reservedNotifications) return 'RATE_LIMIT_REPLY_DAY';
    if (dayAttempts + count > this.#limits.dailyAttempts) return 'RATE_LIMIT_DAY';
    if (this.#state.attempts.filter(entry => entry.at > now - 60_000).length + count > this.#limits.minuteAttempts) return 'RATE_LIMIT_MINUTE';
    return null;
  }

  #enqueue(work) {
    const pending = this.#tail.then(work);
    this.#tail = pending.catch(() => {});
    return pending;
  }

  #canRememberGroup(groupId) {
    return this.#ready && Boolean(this.#state.ownerId) && !this.#state.paused && !this.#pauseRequested &&
      this.groupAccess(groupId)!==null;
  }

  groupAccess(groupId) {
    if(this.#groupRestrictions.has(groupId))return this.#groupRestrictions.get(groupId).access;
    if(this.#state.allowedGroups.some(g=>g.id===groupId))return 'white';
    if(this.#state.grayGroups.some(g=>g.id===groupId))return 'gray';
    return null;
  }

  canDeliver({groupId,requiredAccess='chat',proactiveGroup=false}={}) {
    if(!this.sendingEnabled())return false;
    if(groupId===undefined)return true;
    const access=this.groupAccess(groupId);
    return access!==null&&(!(requiredAccess==='white'||proactiveGroup)||access==='white');
  }

  #bindRequest(context, incomingKey, target, groupId) {
    let acknowledged = false;
    Object.defineProperties(context, {
      authorize: { enumerable:false, value:required => this.canDeliver({groupId,requiredAccess:required}) },
      progress: { enumerable:false, value:async stage => {
        if(!['campus-fetch','campus-fetch-current'].includes(stage)||acknowledged||!this.canDeliver({groupId,requiredAccess:'white'}))return false;
        // Reserve enough capacity for both the acknowledgement and final reply.
        if(this.#budgetCode(this.#time(),{reply:true,count:2}))return false;
        acknowledged=true;
        const delivery=await this.#notify({text:stage==='campus-fetch-current'?'正在抓取数据，随后生成当前推荐图':'正在抓取数据',requiredAccess:'white',progress:true,
          idempotencyKey:`progress:${incomingKey}:campus-fetch`},target,groupId);
        return delivery.code==='SENT';
      } },
    });
    return context;
  }

  #restrictGroup(groupId,access){
    if(access==='white')return null; // Promotion takes effect only after persistence.
    const ticket={access};this.#groupRestrictions.set(groupId,ticket);this.#groupContexts.delete(groupId);return ticket;
  }
  #releaseRestriction(groupId,ticket){if(ticket&&this.#groupRestrictions.get(groupId)===ticket)this.#groupRestrictions.delete(groupId);}

  #groupContext(groupId) {
    const now = this.#time();
    let context = this.#groupContexts.get(groupId);
    if (!context) {
      context = { rows: [], seen: new Map() };
      this.#groupContexts.set(groupId, context);
    }
    context.rows = context.rows.filter(row => row.at <= now && now - row.at < GROUP_CONTEXT_TTL_MS);
    for (const [key, at] of context.seen) if (at > now || now - at >= GROUP_CONTEXT_TTL_MS) context.seen.delete(key);
    return context;
  }

  #rememberGroup(groupId, { key, speaker, role, text }) {
    if (!this.#canRememberGroup(groupId)) return;
    const context = this.#groupContext(groupId);
    if (context.seen.has(key)) return;
    const cleaned = sanitizeContextText(text);
    if (!cleaned) return;
    const now = this.#time();
    context.seen.set(key, now);
    while (context.seen.size > GROUP_CONTEXT_SEEN_LIMIT) context.seen.delete(context.seen.keys().next().value);
    context.rows.push({ at: now, speaker, role, text: cleaned });
    context.rows = context.rows.slice(-GROUP_CONTEXT_SIZE);
  }

  #groupMessageContext(groupId, senderId) {
    const currentSpeaker = 'member-' + hash('group-sender:' + groupId + ':' + senderId).slice(0, 12);
    return { scope: 'group', access:this.groupAccess(groupId), sessionKey: hash('chat:group:' + groupId + ':' + senderId),
      scopeKey: hash('chat-scope-group:' + groupId), userKey: hash('chat-user:' + senderId), currentSpeaker,
      groupContext: this.#groupContext(groupId).rows.map(({ speaker, role, text }) => ({ speaker, role, text })) };
  }

  async #persist(next) {
    await this.#saveState(structuredClone(next));
    this.#state = next;
  }

  #storageFailed() {
    this.#clearGroupPairing();
    this.#groupContexts.clear();
    this.#state.paused = true;
    this.#state.pauseReason = 'STORAGE_ERROR';
    return result(false, 'STORAGE_ERROR');
  }

  async init() {
    return this.#enqueue(async () => {
      if (this.#ready) return this.status();
      let raw;
      try { raw = await this.#loadState(); } catch { throw new Error('STATE_LOAD_FAILED'); }
      const state = restoreState(raw);
      let recovered = false;
      for (const entry of state.deliveries) {
        if (entry.state === 'inFlight') {
          entry.state = 'uncertain';
          entry.code = 'DELIVERY_UNCERTAIN';
          recovered = true;
        }
      }
      if (recovered) {
        state.paused = true;
        state.pauseReason = 'DELIVERY_UNCERTAIN';
        state.lastDeliveryCode = 'DELIVERY_UNCERTAIN';
      }
      try { await this.#persist(state); } catch { throw new Error('STATE_SAVE_FAILED'); }
      this.#ready = true;
      return this.status();
    });
  }

  sendingEnabled() {
    return this.#ready && Boolean(this.#state.ownerId) && !this.#state.paused && !this.#pauseRequested;
  }

  status() {
    const now = this.#time();
    const day = hkDay(now);
    const dailyAttempts = this.#state.attempts.filter(entry => entry.day === day).length;
    return {
      ready: this.#ready,
      paired: Boolean(this.#state.ownerId),
      ownerHint: hint(this.#state.ownerId),
      pendingPairing: Boolean(this.#candidate && now < this.#candidate.expiresAt),
      candidateHint: this.#candidate && now < this.#candidate.expiresAt ? hint(this.#candidate.ownerId) : null,
      paused: this.#state.paused || this.#pauseRequested,
      pauseReason: this.#state.pauseReason,
      dailyAttempts,
      minuteAttempts: this.#state.attempts.filter((entry) => entry.at > now - 60_000).length,
      limits: { ...this.#limits, replyDailyAttempts: this.#limits.dailyAttempts - this.#limits.reservedNotifications },
      remainingDailyAttempts: Math.max(0, this.#limits.dailyAttempts - dailyAttempts),
      day,
      timezone: 'Asia/Hong_Kong',
      lastDeliveryCode: this.#state.lastDeliveryCode,
      uncertainDeliveries: this.#state.deliveries.filter((entry) => entry.state === 'uncertain' || entry.state === 'inFlight').length,
      groupCount: this.#state.allowedGroups.length,
      allowedGroups: this.#state.allowedGroups.map(describeGroup),
      grayGroupCount:this.#state.grayGroups.length,
      grayGroups:this.#state.grayGroups.map(describeGroup),
      pendingGroupPairing: Boolean((this.#groupPairing && now < this.#groupPairing.expiresAt) ||
        (this.#groupCandidate && now < this.#groupCandidate.expiresAt)),
      pendingGroup: this.#groupCandidate && now < this.#groupCandidate.expiresAt
        ? { ...describeGroup(this.#groupCandidate), ...(this.#groupCandidate.access==='gray'?{access:'gray'}:{}), expiresAt: this.#groupCandidate.expiresAt } : null,
    };
  }

  async startPairing() {
    return this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (this.#state.ownerId) return result(false, 'ALREADY_PAIRED');
      const expiresAt = this.#time() + CORE_LIMITS.pairingTtlMs;
      const code = randomBytes(16).toString('hex');
      this.#pairing = { code, expiresAt };
      this.#candidate = null;
      return result(true, 'PAIRING_STARTED', { pairingCode: code, expiresAt });
    });
  }

  async cancelPairing() {
    // Configuration changes/disconnects also discard ephemeral conversation data.
    this.#groupContexts.clear();
    return this.#enqueue(async () => {
      this.#pairing = null;
      this.#candidate = null;
      this.#clearGroupPairing();
      this.#groupContexts.clear();
      return result(true, 'PAIRING_CANCELLED');
    });
  }

  #clearGroupPairing() {
    this.#groupPairing = null;
    this.#groupCandidate = null;
  }

  async startGroupPairing({ name, access='white' } = {}) {
    return this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
      if (this.#state.paused) return result(false, 'PAUSED');
      const normalizedName = typeof name === 'string' ? name.trim() : name;
      if (!validGroupName(normalizedName)||!['white','gray'].includes(access)) return result(false, 'INVALID_INPUT');
      if ((access==='white'?this.#state.allowedGroups:this.#state.grayGroups).length >= (access==='gray'?CORE_LIMITS.grayGroups:CORE_LIMITS.allowedGroups)) return result(false, 'GROUP_LIMIT_REACHED');
      const expiresAt = this.#time() + CORE_LIMITS.pairingTtlMs;
      const code = randomBytes(16).toString('hex');
      this.#groupPairing = { name: normalizedName, access, code, expiresAt };
      this.#groupCandidate = null;
      return result(true, 'GROUP_PAIRING_STARTED', { groupPairingCode: code, expiresAt });
    });
  }

  async cancelGroupPairing() {
    return this.#enqueue(async () => {
      this.#clearGroupPairing();
      return result(true, 'GROUP_PAIRING_CANCELLED');
    });
  }

  async confirmGroupPairing({ groupKey } = {}) {
    return this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
      if (this.#state.paused) return result(false, 'PAUSED');
      if (!validGroupKey(groupKey)) return result(false, 'INVALID_INPUT');
      if (!this.#groupCandidate) return result(false, 'NO_GROUP_PAIRING_CANDIDATE');
      if (this.#time() >= this.#groupCandidate.expiresAt) {
        this.#clearGroupPairing();
        return result(false, 'GROUP_PAIRING_EXPIRED');
      }
      if (groupKey !== groupKeyFor(this.#groupCandidate.id)) return result(false, 'GROUP_PAIRING_KEY_MISMATCH');
      if ([...this.#state.allowedGroups,...this.#state.grayGroups].some(group => group.id === this.#groupCandidate.id)) return result(false, 'GROUP_ALREADY_ALLOWED');
      const access=this.#groupCandidate.access||'white',key=access==='gray'?'grayGroups':'allowedGroups';
      if (this.#state[key].length >= (access==='gray'?CORE_LIMITS.grayGroups:CORE_LIMITS.allowedGroups)) return result(false, 'GROUP_LIMIT_REACHED');
      const next = structuredClone(this.#state);
      next[key].push({ id: this.#groupCandidate.id, name: this.#groupCandidate.name });
      try { await this.#persist(next); } catch { return this.#storageFailed(); }
      this.#clearGroupPairing();
      return result(true, access==='gray'?'GRAY_GROUP_ALLOWED':'GROUP_ALLOWED', { status: this.status() });
    });
  }

  async removeAllowedGroup({ groupKey } = {}) {
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>groupKeyFor(g.id)===groupKey);
    const ticket=group?this.#restrictGroup(group.id,null):null;
    try{
    return await this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
      if (!validGroupKey(groupKey)) return result(false, 'INVALID_INPUT');
      if (![...this.#state.allowedGroups,...this.#state.grayGroups].some(group => groupKeyFor(group.id) === groupKey)) return result(false, 'GROUP_NOT_FOUND');
      const next = structuredClone(this.#state);
      next.allowedGroups = next.allowedGroups.filter(group => groupKeyFor(group.id) !== groupKey);
      next.grayGroups = next.grayGroups.filter(group => groupKeyFor(group.id) !== groupKey);
      try { await this.#persist(next); } catch { return this.#storageFailed(); }
      for (const id of this.#groupContexts.keys()) if (groupKeyFor(id) === groupKey) this.#groupContexts.delete(id);
      return result(true, 'GROUP_REMOVED', { status: this.status() });
    });
    }finally{if(group)this.#releaseRestriction(group.id,ticket);}
  }

  async setGroupAccess({groupKey,access}={}){
    if(!validGroupKey(groupKey)||!['white','gray'].includes(access))return result(false,'INVALID_INPUT');
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>groupKeyFor(g.id)===groupKey);
    if(!group)return result(false,'GROUP_NOT_FOUND');
    const ticket=this.#restrictGroup(group.id,access);
    try{return await this.#enqueue(async()=>{
      if(!this.#ready)return result(false,'NOT_READY');
      if(!this.#state.ownerId)return result(false,'NOT_PAIRED');
      const current=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>g.id===group.id);
      if(!current)return result(false,'GROUP_NOT_FOUND');
      const key=access==='gray'?'grayGroups':'allowedGroups';
      if(this.#state[key].some(g=>g.id===group.id))return result(true,'GROUP_ACCESS_CHANGED',{status:this.status()});
      if(this.#state[key].length>=(access==='gray'?CORE_LIMITS.grayGroups:CORE_LIMITS.allowedGroups))return result(false,'GROUP_LIMIT_REACHED');
      const next=structuredClone(this.#state);
      next.allowedGroups=next.allowedGroups.filter(g=>g.id!==group.id);next.grayGroups=next.grayGroups.filter(g=>g.id!==group.id);
      next[key].push(current);
      try{await this.#persist(next);}catch{return this.#storageFailed();}
      this.#groupContexts.delete(group.id);
      return result(true,'GROUP_ACCESS_CHANGED',{status:this.status()});
    });}finally{this.#releaseRestriction(group.id,ticket);}
  }

  async confirmPairing() {
    return this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (this.#state.ownerId) return result(false, 'ALREADY_PAIRED');
      if (!this.#candidate) return result(false, 'NO_PAIRING_CANDIDATE');
      if (this.#time() >= this.#candidate.expiresAt) {
        this.#candidate = null;
        return result(false, 'PAIRING_EXPIRED');
      }
      const next = structuredClone(this.#state);
      next.ownerId = this.#candidate.ownerId;
      next.paused = false;
      next.pauseReason = null;
      try { await this.#persist(next); } catch { return this.#storageFailed(); }
      this.#candidate = null;
      this.#pairing = null;
      return result(true, 'PAIRED', { status: this.status() });
    });
  }

  async setPaused(paused) {
    if (paused === true && this.#ready && this.#state.ownerId) {
      this.#pauseRequested = true;
      this.#groupContexts.clear();
    }
    return this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (typeof paused !== 'boolean') return result(false, 'INVALID_INPUT');
      if (paused) this.#clearGroupPairing();
      if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
      const next = structuredClone(this.#state);
      next.paused = paused;
      next.pauseReason = paused ? 'LOCAL_PAUSE' : null;
      try { await this.#persist(next); } catch { return this.#storageFailed(); }
      this.#pauseRequested = paused;
      return result(true, paused ? 'PAUSED' : 'RESUMED');
    });
  }

  async handleMessage(message) {
    // Capture only normalized scalar fields: a queued caller cannot replace its
    // identity/target while another request is waiting for a model or provider.
    if (message && typeof message === 'object') {
      const { kind, groupId, id, senderId, text, replyTarget } = message;
      message = { kind, groupId, id, senderId, text, ...(replyTarget ? { replyTarget: { ...replyTarget } } : {}) };
    }
    if (!this.#ready) return result(false, 'NOT_READY');
    if (!message || !['c2c','group'].includes(message.kind)) return result(false, 'SCOPE_DENIED');
    if (!validId(message.id) || !validId(message.senderId) || typeof message.text !== 'string' || message.text.length > CORE_LIMITS.textLength) return result(false, 'INVALID_INPUT');
    if (this.#ready && this.#state.ownerId && message?.kind === 'c2c' &&
        message.senderId === this.#state.ownerId && validId(message.id) &&
        typeof message.text === 'string' && message.text.trim() === '/pause') {
      this.#pauseRequested = true;
      this.#groupContexts.clear();
    }
    // Every queued incoming message consumes capacity by default. Only actual
    // owner management commands bypass it; group binding and public help/ping
    // cannot build an unbounded queue while a model/provider is pending.
    let groupContext, countedIncoming = true;
    if (this.#ready && message?.kind === 'group') {
      const { groupId, id, senderId, text, replyTarget } = message;
      if (!validGroupId(groupId)) return result(false, 'SCOPE_DENIED');
      if (!validId(id) || !validId(senderId) || typeof text !== 'string' || text.length > CORE_LIMITS.textLength) return result(false, 'INVALID_INPUT');
      if (replyTarget?.scope !== 'group' || replyTarget.targetId !== groupId || replyTarget.msgId !== id) return result(false, 'GROUP_REPLY_TARGET_INVALID');
      if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
      if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
      if (this.#canRememberGroup(groupId)) {
        const rawCommand = text.trim(), prefixed = GROUP_PREFIX.exec(rawCommand);
        const command = prefixed ? prefixed[1] : rawCommand;
        if (prefixed && this.#state.incoming.includes(hash(`incoming:group:${groupId}:${id}`))) return result(false, 'DUPLICATE');
        // Freeze preceding context at receipt, before recording this message.
        groupContext = this.#groupMessageContext(groupId, senderId);
        if (!contextControl(command)) this.#rememberGroup(groupId, {
          key: hash(`context:member:${groupId}:${id}`), speaker: groupContext.currentSpeaker, role: 'member', text: command,
        });
        // Ordinary allowed-group chatter never joins the expensive serial queue.
        if (!prefixed) return result(true, 'IGNORED');
        if (command.startsWith('/') && !['/ping', '/help'].includes(command)) return result(true, 'IGNORED');
      } else if (!this.#groupPairing) return result(false, 'GROUP_DENIED');
    } else if (this.#ready && this.#state.ownerId && message?.kind === 'c2c') {
      if (message.senderId !== this.#state.ownerId) return result(false, 'SENDER_DENIED');
      countedIncoming = !ownerControlCommands.has(message.text.trim());
      if (countedIncoming && (this.#state.paused || this.#pauseRequested)) return result(false, 'PAUSED');
    }
    if (countedIncoming && this.#pendingIncoming >= MAX_PENDING_INCOMING) return result(false, 'BUSY');
    if (countedIncoming) this.#pendingIncoming++;
    try { return await this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (message?.kind === 'group') return this.#handleGroupMessage(message, groupContext);
      if (!message || message.kind !== 'c2c') return result(false, 'SCOPE_DENIED');
      const { id, senderId, text, replyTarget } = message;
      if (!validId(id) || !validId(senderId) || typeof text !== 'string' || text.length > CORE_LIMITS.textLength) {
        return result(false, 'INVALID_INPUT');
      }
      if (!this.#state.ownerId) {
        if (!this.#pairing) return result(false, 'NOT_PAIRED');
        if (this.#time() >= this.#pairing.expiresAt) {
          this.#pairing = null;
          return result(false, 'PAIRING_EXPIRED');
        }
        const match = /^\/pair ([a-f0-9]{32})$/.exec(text.trim());
        if (!match || !timingSafeEqual(Buffer.from(match[1]), Buffer.from(this.#pairing.code))) {
          return result(false, 'PAIRING_CODE_INVALID');
        }
        this.#candidate = { ownerId: senderId, expiresAt: this.#pairing.expiresAt };
        this.#pairing = null; // One use. A second sender cannot replace the candidate.
        return result(true, 'PAIRING_PENDING', { candidateHint: hint(senderId) });
      }
      if (senderId !== this.#state.ownerId) return result(false, 'SENDER_DENIED');
      const incomingKey = hash(`incoming:c2c:${id}`);
      if (this.#state.incoming.includes(incomingKey)) return result(false, 'DUPLICATE');
      const next = structuredClone(this.#state);
      next.incoming.push(incomingKey);
      next.incoming = next.incoming.slice(-CORE_LIMITS.historySize);
      const command = text.trim();
      if (command === '/pause') {
        this.#clearGroupPairing();
        this.#groupContexts.clear();
        next.paused = true;
        next.pauseReason = 'OWNER_PAUSE';
      }
      try { await this.#persist(next); } catch { return this.#storageFailed(); }
      if (command === '/pause') return result(true, 'PAUSED');
      if (command === '/ping') {
        return this.#notify({ text: '连接正常（固定测试回复）', idempotencyKey: `reply:${incomingKey}` }, replyTarget);
      }
      if (command === '/status') {
        return this.#notify({ text: '状态：已配对；发送已启用；支持本人天气查询。发送“帮助”查看命令。', idempotencyKey: `reply:${incomingKey}` }, replyTarget);
      }
      if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
      if (this.#commandHandler) {
        const now = this.#time();
        const budgetCode = this.#budgetCode(now, { reply: true });
        if (budgetCode) return result(false, budgetCode);
        let response;
        const context=this.#bindRequest({scope:'c2c',sessionKey:hash('chat:c2c:'+senderId),
          scopeKey:hash('chat-scope-c2c:'+senderId),userKey:hash('chat-user:'+senderId)},incomingKey,replyTarget);
        try { response = await this.#commandHandler(command, context); }
        catch { response = { text: '天气查询暂时未完成，请稍后再试。未将旧数据作为当前结果。' }; }
        if (response) return this.#notify({ text: response.text, image: response.image, idempotencyKey: `reply:${incomingKey}` }, replyTarget);
      }
      return result(true, 'IGNORED');
    }); } finally { if (countedIncoming) this.#pendingIncoming--; }
  }

  async #handleGroupMessage(message, groupContext) {
    const { groupId, id, senderId, text, replyTarget } = message;
    // Reject legacy/un-normalized group objects before any query or mutation.
    if (!validGroupId(groupId)) return result(false, 'SCOPE_DENIED');
    if (!validId(id) || !validId(senderId) || typeof text !== 'string' || text.length > CORE_LIMITS.textLength) return result(false, 'INVALID_INPUT');
    if (replyTarget?.scope !== 'group' || replyTarget.targetId !== groupId || replyTarget.msgId !== id) return result(false, 'GROUP_REPLY_TARGET_INVALID');
    if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
    if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
    const rawCommand = text.trim();
    if (this.groupAccess(groupId)===null) {
      if (!this.#groupPairing) return result(false, 'GROUP_DENIED');
      if (this.#time() >= this.#groupPairing.expiresAt) {
        this.#clearGroupPairing();
        return result(false, 'GROUP_PAIRING_EXPIRED');
      }
      const match = /^\/group-bind ([a-f0-9]{32})$/.exec(rawCommand);
      if (!match || !timingSafeEqual(Buffer.from(match[1]), Buffer.from(this.#groupPairing.code))) return result(false, 'GROUP_DENIED');
      this.#groupCandidate = { id: groupId, name: this.#groupPairing.name, access:this.#groupPairing.access, expiresAt: this.#groupPairing.expiresAt };
      this.#groupPairing = null;
      // Candidate capture is memory-only and sends no group acknowledgement.
      return result(true, 'GROUP_PAIRING_PENDING', { ...describeGroup(this.#groupCandidate), expiresAt: this.#groupCandidate.expiresAt });
    }
    // Only an explicit leading alias opens the group command path.
    const prefixed = GROUP_PREFIX.exec(rawCommand);
    if (!prefixed) return result(true, 'IGNORED');
    const command = prefixed[1];
    // No group participant, including the owner, may invoke private management
    // or inspect owner status through group commands. /help is a fixed menu.
    if (command.startsWith('/') && !['/ping', '/help'].includes(command)) return result(true, 'IGNORED');
    const incomingKey = hash(`incoming:group:${groupId}:${id}`);
    if (this.#state.incoming.includes(incomingKey)) return result(false, 'DUPLICATE');
    const next = structuredClone(this.#state);
    next.incoming.push(incomingKey);
    next.incoming = next.incoming.slice(-CORE_LIMITS.historySize);
    try { await this.#persist(next); } catch { return this.#storageFailed(); }
    const target = { scope: 'group', targetId: groupId, msgId: id };
    if (command === '/ping') return this.#notify({ text: '连接正常（固定测试回复）', idempotencyKey: `reply:${incomingKey}` }, target, groupId);
    if (['帮助', '菜单', '/help'].includes(command)) return this.#notify({
      text: this.groupAccess(groupId)==='gray'?'灰名单群：仅开放基础聊天与换算。\n前缀：梁圣、梁祖、梁嗨、小难梁，后加空格。\n例如：梁祖 你好\n梁祖 1马里换公里\n余额、三号楼及其他查询未开放。\n帮助\n/ping':'白名单群：主动询问可使用全部业务功能。\n前缀：梁圣、梁祖、梁嗨、小难梁，后加空格。\n天气、雷达、空气、换算、生活费、官方状态、DeepSeek余额、三号楼简报均可自然询问。\n例如：梁祖 今天学院路有哪些空教室\n固定命令：发 天气 城市或区县、发 雷达 地点、雷达目录、发 雾霾 城市或区县、查DeepSeek余额、查空教室、换算 0.6 HU$ 人民币。\n帮助\n/ping',
      idempotencyKey: `reply:${incomingKey}`,
    }, target, groupId);
    if (this.#commandHandler) {
      if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
      const now = this.#time();
      const budgetCode = this.#budgetCode(now, { reply: true });
      if (budgetCode) return result(false, budgetCode);
      let response;
      const access=this.groupAccess(groupId);
      const context=groupContext&&groupContext.access===access?groupContext:{ scope: 'group', access,
        sessionKey: hash('chat:group:'+groupId+':'+senderId), scopeKey: hash('chat-scope-group:'+groupId),
        userKey: hash('chat-user:'+senderId), currentSpeaker: 'member-'+hash('group-sender:'+groupId+':'+senderId).slice(0,12), groupContext: [] };
      this.#bindRequest(context,incomingKey,target,groupId);
      try { response = await this.#commandHandler(command, context); }
      catch { response = { text: '天气查询暂时未完成，请稍后再试。未将旧数据作为当前结果。' }; }
      if(response?.memoryReset===true)this.#groupContexts.delete(groupId);
      if (response) return this.#notify({ text: response.text, image: response.image,requiredAccess:response.requiredAccess,sensitive:response.sensitive, idempotencyKey: `reply:${incomingKey}` }, target, groupId);
    }
    return result(true, 'IGNORED');
  }

  async notify(input) {
    // replyTarget in input is deliberately ignored. Public/API notifications
    // always address the persisted owner, never a caller-specified destination.
    const {text,idempotencyKey}=input??{};
    return this.#enqueue(() => this.#notify({text,idempotencyKey}));
  }

  async notifyImage({image,idempotencyKey}={}) {
    // Called only with media generated by the local weather service; no HTTP
    // or MCP input can supply images, file paths, URLs or arbitrary recipients.
    if(image===undefined)return result(false,'INVALID_INPUT');
    return this.#enqueue(() => this.#notify({text:'',image,idempotencyKey}));
  }

  /** Explicitly authorized operation summaries only; recipients come from state. */
  async notifyAllAllowed({text,idempotencyKey}={}) {
    // This public text entry point deliberately discards caller-supplied media.
    return this.#notifyAllAllowed({text,idempotencyKey});
  }

  /** Internal generated-image operation; callers cannot choose recipients. */
  async notifyImageAllAllowed({image,idempotencyKey}={}) {
    if (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 8 || image.buffer.length > 5 * 1024 * 1024 ||
        !['image/png','image/jpeg'].includes(image.mimeType)) {
      return result(false, 'INVALID_INPUT', { results: [], attempted: 0, sent: 0 });
    }
    return this.#notifyAllAllowed({text:'',image,idempotencyKey});
  }

  async #notifyAllAllowed({text,image,idempotencyKey}) {
    return this.#enqueue(async () => {
      const empty = code => result(false, code, { results: [], attempted: 0, sent: 0 });
      if (!this.#ready) return empty('NOT_READY');
      if (!this.#state.ownerId) return empty('NOT_PAIRED');
      if (typeof text !== 'string' || (!text.trim() && image === undefined) || text.length > CORE_LIMITS.textLength || !validId(idempotencyKey)) return empty('INVALID_INPUT');
      // Validate before enumerating or sending any target, including after queue wait.
      if (image !== undefined && (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 8 || image.buffer.length > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(image.mimeType))) return empty('INVALID_INPUT');
      const operation = hash(`broadcast:${idempotencyKey}`);
      const targets = [{ destination: 'owner', idempotencyKey: `broadcast:${operation}:owner` },
        ...this.#state.allowedGroups.map(group => ({ destination: group.name, groupId: group.id,
          idempotencyKey: `broadcast:${operation}:${groupKeyFor(group.id)}` }))];
      // Snapshot existing records before new sends can evict settled history.
      for (const target of targets) {
        target.key = hash(`outgoing:${target.idempotencyKey}`);
        target.existing = this.#state.deliveries.find(entry => entry.key === target.key);
      }
      const duplicate = target => ({ destination: target.destination, ok: false, code: 'DUPLICATE', deliveryState: target.existing.state });
      const needed = targets.filter(target => !target.existing).length;
      if (!needed) return result(false, 'DUPLICATE', { results: targets.map(duplicate), attempted: 0, sent: 0 });
      const blocked = code => result(false, code, { results: targets.map(target => target.existing ? duplicate(target) :
        { destination: target.destination, ok: false, code }), attempted: 0, sent: 0 });
      if (this.#state.paused || this.#pauseRequested) return blocked('PAUSED');
      const budgetCode = this.#budgetCode(this.#time(), { count: needed });
      if (budgetCode) return blocked(budgetCode);
      const results = []; let attempted = 0, sent = 0, stoppedCode = null;
      for (const target of targets) {
        if (target.existing) { results.push(duplicate(target)); continue; }
        if (stoppedCode || this.#state.paused || this.#pauseRequested) {
          const code = this.#state.paused || this.#pauseRequested ? 'PAUSED' : 'NOT_ATTEMPTED';
          stoppedCode ??= code;
          results.push({ destination: target.destination, ok: false, code }); continue;
        }
        const delivery = await this.#notify({ text, ...(image !== undefined ? {image} : {}), idempotencyKey: target.idempotencyKey }, undefined, target.groupId, target.groupId !== undefined);
        if (this.#state.deliveries.some(entry => entry.key === target.key)) attempted++;
        if (delivery.code === 'SENT') sent++;
        results.push({ destination: target.destination, ok: delivery.ok, code: delivery.code,
          ...(delivery.deliveryState ? { deliveryState: delivery.deliveryState } : {}) });
        if (!delivery.ok && delivery.code !== 'DUPLICATE') stoppedCode = delivery.code;
      }
      return result(stoppedCode === null, stoppedCode ?? 'SENT', { results, attempted, sent });
    });
  }

  async #notify(input, replyTarget, groupId, proactiveGroup = false) {
    if (!this.#ready) return result(false, 'NOT_READY');
    if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
    if (groupId !== undefined) {
      if (!validGroupId(groupId) || this.groupAccess(groupId)===null) return result(false, 'GROUP_DENIED');
      if((proactiveGroup||(input?.requiredAccess||(input?.image?'white':'chat'))==='white')&&this.groupAccess(groupId)!=='white')return result(false,'GROUP_ACCESS_DENIED');
      if (!proactiveGroup && (replyTarget?.scope !== 'group' || replyTarget.targetId !== groupId || !validId(replyTarget.msgId))) return result(false, 'GROUP_REPLY_TARGET_INVALID');
    }
    const { text, idempotencyKey, image } = input ?? {};
    if (typeof text !== 'string' || (text.trim().length === 0 && image === undefined) || text.length > CORE_LIMITS.textLength || !validId(idempotencyKey)) {
      return result(false, 'INVALID_INPUT');
    }
    if (image !== undefined && (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 8 || image.buffer.length > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(image.mimeType))) return result(false, 'INVALID_INPUT');
    const key = hash(`outgoing:${idempotencyKey}`);
    const existing = this.#state.deliveries.find((entry) => entry.key === key);
    if (existing) return result(false, 'DUPLICATE', { deliveryState: existing.state });
    if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
    const now = this.#time();
    const day = hkDay(now);
    const budgetCode = this.#budgetCode(now, { reply: replyTarget !== undefined && replyTarget !== null });
    if (budgetCode) return result(false, budgetCode);
    const next = structuredClone(this.#state);
    // Keep uncertain attempts until explicitly dealt with; do not evict them
    // just because more work arrives. Settled history has a fixed bounded capacity.
    if (next.deliveries.length >= CORE_LIMITS.historySize) {
      const index = next.deliveries.findIndex((entry) => entry.state === 'sent' || entry.state === 'rejected');
      if (index < 0) return result(false, 'HISTORY_FULL');
      next.deliveries.splice(index, 1);
    }
    next.attempts = next.attempts.filter((entry) => entry.at >= now - 48 * 60 * 60_000);
    next.attempts.push({ at: now, day });
    next.deliveries.push({ key, state: 'inFlight', at: now, code: 'SENDING' });
    next.lastDeliveryCode = 'SENDING';
    // Persist the budget and key BEFORE any network call. A crash here favors
    // suppressing an uncertain notification over sending it twice.
    try { await this.#persist(next); } catch { return this.#storageFailed(); }
    let failure = null;
    try {
      const response = await this.#send({ ownerId: this.#state.ownerId, text, ...(groupId !== undefined ? { groupId,requiredAccess:proactiveGroup?'white':input?.requiredAccess||(image?'white':'chat') } : {}), ...(proactiveGroup ? { proactiveGroup: true } : {}), ...(replyTarget ? { replyTarget } : {}), ...(image ? { image } : {}) });
      if (response?.ok === false) throw response;
    } catch (error) { failure = classifyError(error); }
    const finished = structuredClone(this.#state);
    const record = finished.deliveries.find((entry) => entry.key === key);
    record.state = failure ? (failure.uncertain ? 'uncertain' : 'rejected') : 'sent';
    record.code = failure?.code ?? 'SENT';
    finished.lastDeliveryCode = record.code;
    if (failure?.pause) {
      this.#clearGroupPairing();
      this.#groupContexts.clear();
      finished.paused = true;
      finished.pauseReason = failure.code;
    }
    try { await this.#persist(finished); } catch {
      const pending = this.#state.deliveries.find((entry) => entry.key === key);
      pending.state = 'uncertain';
      pending.code = 'DELIVERY_UNCERTAIN';
      this.#state.lastDeliveryCode = 'STORAGE_ERROR';
      return this.#storageFailed();
    }
    if (!failure && groupId !== undefined && replyTarget && !proactiveGroup && !input?.progress) this.#rememberGroup(groupId, {
      key: `context:bot:${key}`, speaker: 'fish', role: 'assistant', text: image ? '[已发送查询图片]' : input?.sensitive ? '[已查询账户余额]' : text,
    });
    return failure ? result(false, failure.code, { deliveryState: record.state }) : result(true, 'SENT');
  }
}
