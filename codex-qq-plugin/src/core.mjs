import {validVideo} from './video-media.mjs';
import {copyIncomingMedia} from './incoming-media.mjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { withHeavyWorkGuard } from './heavy-work.mjs';
import { sanitizeContextText } from './chat-safety.mjs';
import {recordTiming,setTraceMessage} from './telemetry.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {GROUP_FEATURES,defaultGroupFeatures,basicGroupFeatures,validGroupFeatures,normalizeGroupFeatures,MORNING_PART_FEATURES,MORNING_FEATURE_KEYS,isMorningFeature} from './group-features.mjs';
import {DEFAULT_WAKE_WORDS,WAKE_WORD_LIMITS,validWakeWords,validDisabledWakeWords,normalizeWakeWord,validWakeWordText,wakeWordKey,parseGroupWake} from './wake-words.mjs';

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
const MAX_OFFICIAL_COMMANDS = 16;
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
const describeGroup = ({ id, name, enabled=true, features, disabledWakeWords=[] }, access='white') => ({
  name,groupKey:groupKeyFor(id),groupHint:`sha256:${groupKeyFor(id).slice(0,12)}`,
  ...(id.match(/^qq_[1-9]\d+_g_([1-9]\d+)$/)?{groupNumber:id.split('_').at(-1)}:{}),
  enabled,features:features??defaultGroupFeatures(access),disabledWakeWords:[...disabledWakeWords],
});
function restoreGroup(entry) {
  if (!entry || typeof entry!=='object' || Array.isArray(entry) ||
      Object.keys(entry).some(key=>!['id','name','enabled','features','disabledWakeWords'].includes(key)) ||
      !validGroupId(entry.id) || !validGroupName(entry.name) ||
      (entry.enabled!==undefined && typeof entry.enabled!=='boolean') ||
      (entry.features!==undefined && !validGroupFeatures(entry.features)) ||
      (entry.disabledWakeWords!==undefined&&!validDisabledWakeWords(entry.disabledWakeWords))) throw Error('STATE_INVALID');
  return {...entry,...(entry.features?{features:normalizeGroupFeatures(entry.features)}:{})};
}
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
    wakeWords: structuredClone(DEFAULT_WAKE_WORDS),
    wakeWordRevision: 0,
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
    for (const key of ['target','caller']) if (entry[key] !== undefined && !isHash(entry[key])) throw Error('STATE_INVALID');
    return { at: entry.at, day: entry.day, ...(entry.target ? {target:entry.target} : {}), ...(entry.caller ? {caller:entry.caller} : {}) };
  });
  const deliveries = raw.deliveries.map((entry) => {
    if (!isHash(entry.key) || !knownDeliveryStates.has(entry.state) ||
        !Number.isSafeInteger(entry.at) || entry.at < 0 ||
        !knownDeliveryCodes.has(entry.code)) throw new Error('STATE_INVALID');
    if (entry.receiptHash !== undefined && !isHash(entry.receiptHash)) throw Error('STATE_INVALID');
    return { key: entry.key, state: entry.state, at: entry.at, code: entry.code, ...(entry.receiptHash ? {receiptHash:entry.receiptHash} : {}) };
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
  const allowedGroups = groups.map(restoreGroup);
  if (new Set(allowedGroups.map(entry => entry.id)).size !== allowedGroups.length) throw new Error('STATE_INVALID');
  const gray = raw.grayGroups === undefined ? [] : raw.grayGroups;
  if (!Array.isArray(gray) || gray.length > CORE_LIMITS.grayGroups || (gray.length && !raw.ownerId)) throw new Error('STATE_INVALID');
  const grayGroups=gray.map(restoreGroup);
  if(new Set([...allowedGroups,...grayGroups].map(g=>g.id)).size!==allowedGroups.length+grayGroups.length)throw new Error('STATE_INVALID');
  const wakeWords=raw.wakeWords===undefined?structuredClone(DEFAULT_WAKE_WORDS):raw.wakeWords;
  const wakeWordRevision=raw.wakeWordRevision??0;
  if (!validWakeWords(wakeWords)||!Number.isSafeInteger(wakeWordRevision)||wakeWordRevision<0||
      [...allowedGroups,...grayGroups].some(g=>(g.disabledWakeWords||[]).some(id=>!wakeWords.some(w=>w.id===id)))) throw Error('STATE_INVALID');
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
    wakeWords:structuredClone(wakeWords),wakeWordRevision,
  };
}

// Only return fixed categories. Upstream error text, URLs, message bodies and
// credentials must never reach status(), persisted state or API responses.
function classifyError(error) {
  if(error?.timedOut===true){
    if(error.messageAttempted===false)return {code:'PLATFORM_REJECTED',pause:false,uncertain:false,timeoutText:'图片上传到QQ超时（120秒时限），图片消息尚未提交，请稍后重试'};
    return {code:'DELIVERY_UNCERTAIN',pause:true,uncertain:true};
  }
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
    // An explicit message rejection is final for this attempt, not a global outage.
    // Authentication, platform rate limits, fatal and uncertain failures above/below
    // retain their global stop behavior. Never retry this rejected message.
    return { code: 'PLATFORM_REJECTED', pause: false, uncertain: false };
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
  #officialTail = Promise.resolve();
  #officialPending = 0;
  #officialRequest = new AsyncLocalStorage();
  #policyChange = new AbortController();
  #pauseEpoch = 0;
  #groupRestrictions = new Map();
  #groupRevisions = new Map();
  #morningRevisions = new Map();
  #caller = new AsyncLocalStorage();
  #oneBotMode;

  constructor({ loadState, saveState, send, now = Date.now, commandHandler = null, observeMessage = null, limits = {}, oneBotMode = null }) {
    if (![loadState, saveState, send, now].every((fn) => typeof fn === 'function')) {
      throw new TypeError('INVALID_CORE_DEPENDENCIES');
    }
    this.#loadState = loadState;
    this.#saveState = saveState;
    this.#send = send;
    this.#now = now;
    this.#commandHandler = commandHandler;
    this.observeMessage = observeMessage;
    if (oneBotMode !== null && !['receive-only','limited','normal'].includes(oneBotMode)) throw Error('ONEBOT_MODE_INVALID');
    this.#oneBotMode = oneBotMode;
    const configured = sendingLimits(limits);
    this.#limits = oneBotMode ? sendingLimits({dailyAttempts:Math.min(100,configured.dailyAttempts),
      minuteAttempts:Math.min(6,configured.minuteAttempts),reservedNotifications:Math.min(99,Math.max(10,configured.reservedNotifications),Math.min(100,configured.dailyAttempts)-1)}) : configured;
  }

  #time() {
    const value = Number(this.#now());
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_CLOCK');
    return value;
  }

  #budgetCode(now, { reply = false, count = 1, target } = {}) {
    if (this.#oneBotMode === 'receive-only') return 'RECEIVE_ONLY';
    const dayAttempts = this.#state.attempts.filter(entry => entry.day === hkDay(now)).length;
    if (reply && dayAttempts + count > this.#limits.dailyAttempts - this.#limits.reservedNotifications) return 'RATE_LIMIT_REPLY_DAY';
    if (dayAttempts + count > this.#limits.dailyAttempts) return 'RATE_LIMIT_DAY';
    if (this.#state.attempts.filter(entry => entry.at > now - 60_000).length + count > this.#limits.minuteAttempts) return 'RATE_LIMIT_MINUTE';
    if (this.#oneBotMode) {
      const recent = this.#state.attempts.filter(entry => entry.at > now - 60_000);
      if (target && recent.filter(entry => entry.target === hash(target)).length + count > 3) return 'RATE_LIMIT_TARGET';
      const caller = this.#caller.getStore();
      if (caller && recent.filter(entry => entry.caller === hash(caller)).length + count > 2) return 'RATE_LIMIT_CALLER';
    }
    return null;
  }

  admitsOneBotEvent({kind,groupId,senderId,text}) {
    if (!this.#ready) return false;
    if (kind === 'c2c' && this.#pairing && !this.#state.ownerId) return /^\/pair [a-f0-9]{32}$/.test(text);
    if (kind === 'group' && this.#groupPairing && this.#state.ownerId === senderId && /^\/group-bind [a-f0-9]{32}$/.test(text)) return true;
    if (this.#oneBotMode === 'receive-only') return false;
    return kind === 'c2c' ? senderId === this.#state.ownerId : this.groupEnabled(groupId);
  }

  #enqueue(work, measureQueue = true) {
    const queuedAt=performance.now();
    const pending = this.#tail.then(()=>{if(measureQueue)recordTiming('core_queue',performance.now()-queuedAt);return work();});
    this.#tail = pending.catch(() => {});
    return pending;
  }

  #wakeWaitingCommands() {
    this.#policyChange.abort();
    this.#policyChange = new AbortController();
  }

  #commandStop(ticket) {
    if (!this.#ready) return 'NOT_READY';
    if (this.#state.paused || this.#pauseRequested || ticket.epoch !== this.#pauseEpoch) return 'PAUSED';
    if (ticket.groupId !== undefined && (!this.groupEnabled(ticket.groupId) ||
        this.#groupRevisions.get(ticket.groupId) !== ticket.revision)) return 'GROUP_ACCESS_DENIED';
    return this.#time() >= ticket.expiresAt ? 'REQUEST_EXPIRED' : null;
  }

  async #waitForQuota(ticket, retryAt) {
    while (!this.#commandStop(ticket) && this.#time() < retryAt && retryAt < ticket.expiresAt) {
      try { await delay(retryAt - this.#time(), undefined, { signal: this.#policyChange.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    return retryAt < ticket.expiresAt && !this.#commandStop(ticket);
  }

  #queueOfficial(ticket, work) {
    if (this.#officialPending >= MAX_OFFICIAL_COMMANDS) return result(false, 'BUSY');
    this.#officialPending++;
    const queuedAt = performance.now();
    const run = this.#officialTail.then(async () => {
      // Check the ledger under the same lock as sends. Wait outside that lock
      // so control operations and active notifications still get a turn.
      for (;;) {
        const outcome = await this.#enqueue(() => {
          const stop = this.#commandStop(ticket);
          if (stop) return result(false, stop);
          const now = this.#time();
          if (this.#budgetCode(now, { reply: true }) === 'RATE_LIMIT_MINUTE') {
            const attempts = this.#state.attempts.filter(row => row.at > now - 60_000)
              .map(row => row.at).sort((a,b) => b-a);
            return {retryAt: attempts[this.#limits.minuteAttempts - 1] + 60_000};
          }
          recordTiming('core_queue', performance.now() - queuedAt);
          return this.#officialRequest.run(ticket, () => withHeavyWorkGuard(() => this.#commandStop(ticket), work));
        }, false);
        if (outcome.retryAt === undefined) return outcome;
        if (!await this.#waitForQuota(ticket, outcome.retryAt)) {
          return result(false, this.#commandStop(ticket) || 'REQUEST_EXPIRED');
        }
      }
    }).finally(() => { this.#officialPending--; });
    this.#officialTail = run.catch(() => {});
    return run;
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

  groupEnabled(groupId) {
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>g.id===groupId);
    return this.groupAccess(groupId)!==null && group?.enabled!==false;
  }

  groupFeatures(groupId) {
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>g.id===groupId);
    return group?.features??defaultGroupFeatures(this.groupAccess(groupId));
  }

  #enabledWakeWords(groupId) {
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>g.id===groupId);
    return this.#state.wakeWords.filter(word=>!(group?.disabledWakeWords||[]).includes(word.id));
  }

  #groupCommand(groupId,text,mentioned) {
    return parseGroupWake(text,mentioned,this.#enabledWakeWords(groupId));
  }

  addressesGroupMessage(groupId,text) {
    return this.groupEnabled(groupId) && typeof text==='string' && this.#groupCommand(groupId,text,false).addressed;
  }

  #wakeWordHelp(groupId) {
    const names=this.#enabledWakeWords(groupId).map(word=>word.text).join('、');
    const visible=Array.from(names);
    return names?'也可用'+visible.slice(0,300).join('')+(visible.length>300?'…（完整列表见控制台）':'')+'加空格。':'本群已关闭全部唤醒词。';
  }

  canUseFeature(groupId,feature) {
    if (feature==='notifications' && groupId!==undefined) {
      const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>g.id===groupId);
      return this.groupEnabled(groupId) && !group?.features && this.groupAccess(groupId)==='white';
    }
    return groupId===undefined || (this.groupEnabled(groupId) && this.groupFeatures(groupId)[feature]===true);
  }

  canDeliver({groupId,requiredAccess='chat',requiredFeature,proactiveGroup=false}={}) {
    if(!this.sendingEnabled())return false;
    if(groupId===undefined)return true;
    return this.#groupCanDeliver(groupId,requiredAccess,requiredFeature,proactiveGroup);
  }

  #groupCanDeliver(groupId,requiredAccess,requiredFeature,proactiveGroup) {
    if (!this.groupEnabled(groupId)) return false;
    if (proactiveGroup) return this.canUseFeature(groupId,isMorningFeature(requiredFeature)?requiredFeature:'notifications') &&
      (!requiredFeature || this.canUseFeature(groupId,requiredFeature));
    return requiredFeature ? this.canUseFeature(groupId,requiredFeature) :
      !(requiredAccess==='white') || this.groupAccess(groupId)==='white';
  }

  #bindRequest(context, incomingKey, target, groupId, eventKey) {
    let acknowledged = false;
    const ticket = this.#officialRequest.getStore();
    if (ticket) Object.defineProperty(context, 'waitForQuota', {value: at => this.#waitForQuota(ticket, at)});
    const revision=this.#groupRevisions.get(groupId);
    const current=()=>(!ticket || !this.#commandStop(ticket)) && (groupId===undefined||this.#groupRevisions.get(groupId)===revision);
    if (groupId!==undefined) context.features=structuredClone(this.groupFeatures(groupId));
    if (groupId!==undefined) context.policyRevision=revision||0;
    Object.defineProperties(context, {
      eventKey: { enumerable:false, value:eventKey||incomingKey },
      authorize: { enumerable:false, value:(required,feature) => current()&&this.canDeliver({groupId,requiredAccess:required,requiredFeature:feature}) },
      allowsFeature: { enumerable:false, value:feature => current()&&this.canUseFeature(groupId,feature) },
      progress: { enumerable:false, value:async stage => {
        if(!['campus-fetch','campus-fetch-current'].includes(stage)||acknowledged||!current()||!this.canDeliver({groupId,requiredFeature:'campus'}))return false;
        // Reserve enough capacity for both the acknowledgement and final reply.
        if(this.#budgetCode(this.#time(),{reply:true,count:2,target:groupId??this.#state.ownerId})){
          // For a queued command the final result takes the last available slot.
          return Boolean(ticket) && !this.#budgetCode(this.#time(),{reply:true,target:groupId??this.#state.ownerId});
        }
        acknowledged=true;
        const delivery=await this.#notify({text:stage==='campus-fetch-current'?'正在抓取数据，随后生成当前推荐图':'正在抓取数据',requiredAccess:'white',requiredFeature:'campus',progress:true,
          idempotencyKey:`progress:${incomingKey}:campus-fetch`},target,groupId);
        return delivery.code==='SENT';
      } },
    });
    return context;
  }

  #restrictGroup(groupId,access,morningFeatures=MORNING_FEATURE_KEYS){
    this.#groupRevisions.set(groupId,(this.#groupRevisions.get(groupId)||0)+1);
    this.#wakeWaitingCommands();
    const morning=this.#morningRevisions.get(groupId)||{};
    for (const feature of morningFeatures) morning[feature]=(morning[feature]||0)+1;
    this.#morningRevisions.set(groupId,morning);
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
    if (!this.#canRememberGroup(groupId) || !this.canUseFeature(groupId,'memory')) return;
    const context = this.#groupContext(groupId);
    if (context.seen.has(key)) return;
    const cleaned = sanitizeContextText(text);
    if (!cleaned) return;
    const now = this.#time();
    context.seen.set(key, now);
    while (context.seen.size > GROUP_CONTEXT_SEEN_LIMIT) context.seen.delete(context.seen.keys().next().value);
    context.rows.push({ key, at: now, speaker, role, text: cleaned });
    context.rows = context.rows.slice(-GROUP_CONTEXT_SIZE);
  }

  #groupMessageContext(groupId, senderId, excludeKey) {
    const currentSpeaker = 'member-' + hash('group-sender:' + groupId + ':' + senderId).slice(0, 12);
    return { scope: 'group', access:this.groupAccess(groupId), sessionKey: hash('chat:group:' + groupId + ':' + senderId),
      scopeKey: hash('chat-scope-group:' + groupId), userKey: hash('chat-user:' + senderId), currentSpeaker,
      groupContext: this.canUseFeature(groupId,'memory') ? this.#groupContext(groupId).rows.filter(row=>excludeKey===undefined||row.key!==excludeKey).map(({ speaker, role, text }) => ({ speaker, role, text })) : [] };
  }

  async #persist(next) {
    await this.#saveState(structuredClone(next));
    this.#state = next;
  }

  #storageFailed() {
    this.#pauseEpoch++;
    this.#wakeWaitingCommands();
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
      allowedGroups: this.#state.allowedGroups.map(g=>describeGroup(g,'white')),
      grayGroupCount:this.#state.grayGroups.length,
      grayGroups:this.#state.grayGroups.map(g=>describeGroup(g,'gray')),
      groupFeatureCatalog:GROUP_FEATURES.filter(feature=>!feature.hidden),
      groupDefaultFeatures:basicGroupFeatures(),
      wakeWords:structuredClone(this.#state.wakeWords),wakeWordRevision:this.#state.wakeWordRevision,wakeWordLimits:WAKE_WORD_LIMITS,
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
      if (this.#oneBotMode && this.#oneBotMode !== 'normal' && this.#state.allowedGroups.length + this.#state.grayGroups.length >= 1) return result(false,'PILOT_GROUP_LIMIT');
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

  async confirmGroupPairing({ groupKey,features } = {}) {
    return this.#enqueue(async () => {
      if (!this.#ready) return result(false, 'NOT_READY');
      if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
      if (this.#state.paused) return result(false, 'PAUSED');
      if (!validGroupKey(groupKey)) return result(false, 'INVALID_INPUT');
      if (features!==undefined&&!validGroupFeatures(features)) return result(false,'INVALID_INPUT');
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
      // Existing operator clients retain their default; the console always
      // submits an explicit mask, initially the basic three features.
      next[key].push({ id: this.#groupCandidate.id, name: this.#groupCandidate.name,
        ...(features===undefined?{}:{enabled:true,features:normalizeGroupFeatures(features)}) });
      try { await this.#persist(next); } catch { return this.#storageFailed(); }
      this.#clearGroupPairing();
      return result(true, access==='gray'?'GRAY_GROUP_ALLOWED':'GROUP_ALLOWED', { status: this.status() });
    });
  }

  async addDiscoveredGroup({id,name,features=basicGroupFeatures()}={}) {
    return this.#enqueue(async()=>{
      if (this.#oneBotMode!=='normal') return result(false,'GROUP_DIRECTORY_UNAVAILABLE');
      if (!this.#ready || !this.#state.ownerId) return result(false,'NOT_PAIRED');
      if (!this.sendingEnabled()) return result(false,'PAUSED');
      if (!validGroupId(id) || !validGroupName(name) || !validGroupFeatures(features)) return result(false,'INVALID_INPUT');
      if ([...this.#state.allowedGroups,...this.#state.grayGroups].some(g=>g.id===id)) return result(false,'GROUP_ALREADY_ALLOWED');
      if (this.#state.allowedGroups.length>=CORE_LIMITS.allowedGroups) return result(false,'GROUP_LIMIT_REACHED');
      const next=structuredClone(this.#state);
      next.allowedGroups.push({id,name,features:normalizeGroupFeatures(features),enabled:true});
      try {await this.#persist(next);} catch {return this.#storageFailed();}
      return result(true,'GROUP_ALLOWED',{status:this.status()});
    });
  }

  async changeWakeWord({operation,id,text,revision}={}) {
    const normalized=normalizeWakeWord(text);
    if (!['add','rename','delete'].includes(operation)||(operation==='add'&&id!==undefined)||!Number.isSafeInteger(revision)||revision<0||
        (operation!=='delete'&&!validWakeWordText(normalized))) return result(false,'INVALID_WAKE_WORD');
    if (revision!==this.#state.wakeWordRevision) return result(false,'WAKE_WORDS_CHANGED');
    if (operation!=='add'&&!this.#state.wakeWords.some(word=>word.id===id)) return result(false,'WAKE_WORD_NOT_FOUND');
    const tickets=[...this.#state.allowedGroups,...this.#state.grayGroups].map(g=>[g.id,this.#restrictGroup(g.id,null)]);
    try {
      return await this.#enqueue(async()=>{
        if (!this.#ready) return result(false,'NOT_READY');
        if (revision!==this.#state.wakeWordRevision) return result(false,'WAKE_WORDS_CHANGED');
        if (operation!=='delete'&&this.#state.wakeWords.some(word=>word.id!==id&&wakeWordKey(word.text)===wakeWordKey(normalized))) return result(false,'WAKE_WORD_EXISTS');
        if (operation==='add'&&this.#state.wakeWords.length>=WAKE_WORD_LIMITS.count) return result(false,'WAKE_WORD_LIMIT');
        const next=structuredClone(this.#state);
        if (operation==='add') next.wakeWords.push({id:randomBytes(8).toString('hex'),text:normalized});
        else if (operation==='rename') next.wakeWords.find(word=>word.id===id).text=normalized;
        else {
          next.wakeWords=next.wakeWords.filter(word=>word.id!==id);
          for (const group of [...next.allowedGroups,...next.grayGroups]) if (group.disabledWakeWords) {
            group.disabledWakeWords=group.disabledWakeWords.filter(wordId=>wordId!==id);
          }
        }
        if (next.wakeWordRevision>=Number.MAX_SAFE_INTEGER) return result(false,'INVALID_INPUT');
        next.wakeWordRevision++;
        try {await this.#persist(next);} catch {return this.#storageFailed();}
        return result(true,'WAKE_WORDS_SAVED',{status:this.status()});
      });
    } finally {for (const [groupId,ticket] of tickets) this.#releaseRestriction(groupId,ticket);}
  }

  async setGroupWakeWords({groupKey,disabledWakeWords,revision}={}) {
    if (!validGroupKey(groupKey)||!validDisabledWakeWords(disabledWakeWords)||!Number.isSafeInteger(revision)||revision<0) return result(false,'INVALID_INPUT');
    if (revision!==this.#state.wakeWordRevision) return result(false,'WAKE_WORDS_CHANGED');
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>groupKeyFor(g.id)===groupKey);
    if (!group) return result(false,'GROUP_NOT_FOUND');
    const ticket=this.#restrictGroup(group.id,null);
    try {
      return await this.#enqueue(async()=>{
        if (revision!==this.#state.wakeWordRevision) return result(false,'WAKE_WORDS_CHANGED');
        if (disabledWakeWords.some(id=>!this.#state.wakeWords.some(word=>word.id===id))) return result(false,'INVALID_INPUT');
        const next=structuredClone(this.#state),current=[...next.allowedGroups,...next.grayGroups].find(g=>g.id===group.id);
        if (!current) return result(false,'GROUP_NOT_FOUND');
        current.disabledWakeWords=[...disabledWakeWords];
        try {await this.#persist(next);} catch {return this.#storageFailed();}
        return result(true,'GROUP_WAKE_WORDS_SAVED',{status:this.status()});
      });
    } finally {this.#releaseRestriction(group.id,ticket);}
  }

  async setGroupFeatures({groupKey,features,enabled}={}) {
    if (!validGroupKey(groupKey) || !validGroupFeatures(features) || typeof enabled!=='boolean') return result(false,'INVALID_INPUT');
    const group=[...this.#state.allowedGroups,...this.#state.grayGroups].find(g=>groupKeyFor(g.id)===groupKey);
    if (!group) return result(false,'GROUP_NOT_FOUND');
    // Block admission and ongoing work before waiting for the serial queue.
    const normalized=normalizeGroupFeatures(features),previous=this.groupFeatures(group.id);
    const changedMorning=enabled!==(group.enabled!==false)?MORNING_FEATURE_KEYS:
      MORNING_FEATURE_KEYS.filter(key=>previous[key]!==normalized[key]);
    const ticket=this.#restrictGroup(group.id,null,changedMorning);
    try {
      return await this.#enqueue(async()=>{
        const next=structuredClone(this.#state);
        const current=[...next.allowedGroups,...next.grayGroups].find(g=>g.id===group.id);
        if (!current) return result(false,'GROUP_NOT_FOUND');
        current.enabled=enabled;current.features=normalized;
        try {await this.#persist(next);} catch {return this.#storageFailed();}
        return result(true,'GROUP_FEATURES_SAVED',{status:this.status()});
      });
    } finally {this.#releaseRestriction(group.id,ticket);}
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
      if(this.#state[key].some(g=>g.id===group.id) && current.features===undefined)return result(true,'GROUP_ACCESS_CHANGED',{status:this.status()});
      if(this.#state[key].length>=(access==='gray'?CORE_LIMITS.grayGroups:CORE_LIMITS.allowedGroups))return result(false,'GROUP_LIMIT_REACHED');
      const next=structuredClone(this.#state);
      next.allowedGroups=next.allowedGroups.filter(g=>g.id!==group.id);next.grayGroups=next.grayGroups.filter(g=>g.id!==group.id);
      const {features,...legacy}=current;
      next[key].push(legacy);
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
      this.#pauseEpoch++;
      this.#wakeWaitingCommands();
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

  async handleMessage(message, replyExpiresAt) {
    // Capture only normalized scalar fields: a queued caller cannot replace its
    // identity/target while another request is waiting for a model or provider.
    if (message && typeof message === 'object') {
      const { kind, groupId, id, senderId, text, replyTarget, mentioned, media } = message;
      message = { kind, groupId, id, senderId, text, media:copyIncomingMedia(media), ...(mentioned === true ? { mentioned: true } : {}), ...(replyTarget ? { replyTarget: { ...replyTarget } } : {}) };
    }
    if (!this.#ready) return result(false, 'NOT_READY');
    if (!message || !['c2c','group'].includes(message.kind)) return result(false, 'SCOPE_DENIED');
    if (!validId(message.id) || !validId(message.senderId) || typeof message.text !== 'string' || message.text.length > CORE_LIMITS.textLength) return result(false, 'INVALID_INPUT');
    if (this.#ready && this.#state.ownerId && message?.kind === 'c2c' &&
        message.senderId === this.#state.ownerId && validId(message.id) &&
        typeof message.text === 'string' && message.text.trim() === '/pause') {
      this.#pauseRequested = true;
      this.#pauseEpoch++;
      this.#wakeWaitingCommands();
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
        const { command, addressed } = this.#groupCommand(groupId,text, message.mentioned);
        if (addressed && this.#state.incoming.includes(hash(`incoming:group:${groupId}:${id}`))) return result(false, 'DUPLICATE');
        // Freeze preceding context at receipt, before recording this message.
        groupContext = this.#groupMessageContext(groupId, senderId,hash(`context:member:${groupId}:${id}`));
        if (!contextControl(command)) this.#rememberGroup(groupId, {
          key: hash(`context:member:${groupId}:${id}`), speaker: groupContext.currentSpeaker, role: 'member', text: command,
        });
        this.#observe(message,groupContext);
        // Ordinary allowed-group chatter never joins the expensive serial queue.
        if (!addressed || !command) return result(true, 'IGNORED');
        if (command.startsWith('/') && !['/ping', '/help'].includes(command)&&!/^\/(?:识图|记忆)(?:\s|$)/u.test(command)) return result(true, 'IGNORED');
        if(this.groupEnabled(groupId))setTraceMessage(text);
      } else if (!this.#groupPairing) return result(false, 'GROUP_DENIED');
    } else if (this.#ready && this.#state.ownerId && message?.kind === 'c2c') {
      if (message.senderId !== this.#state.ownerId) return result(false, 'SENDER_DENIED');
      countedIncoming = !ownerControlCommands.has(message.text.trim());
      if (countedIncoming && (this.#state.paused || this.#pauseRequested)) return result(false, 'PAUSED');
      if(!this.#state.incoming.includes(hash(`incoming:c2c:${message.id}`)))setTraceMessage(message.text);
      if(countedIncoming)this.#observe(message,{scope:'c2c',sessionKey:hash('chat:c2c:'+message.senderId),scopeKey:hash('chat-scope-c2c:'+message.senderId),userKey:hash('chat-user:'+message.senderId)});
    }
    // Only the official adapter supplies the verified passive-reply deadline.
    // Pairing traffic retains its own small admission bound.
    const official = !this.#oneBotMode && Number.isSafeInteger(replyExpiresAt) &&
      (message.kind === 'group' ? Boolean(groupContext) : this.#state.ownerId === message.senderId && message.text.trim() !== '/pause');
    if (!official && countedIncoming && this.#pendingIncoming >= MAX_PENDING_INCOMING) return result(false, 'BUSY');
    if (!official && countedIncoming) this.#pendingIncoming++;
    const receivedAt = this.#time();
    const work = () => this.#caller.run(message.senderId, async () => {
      if (this.#oneBotMode && countedIncoming && this.#time() - receivedAt >= 60_000) return result(false,'REQUEST_EXPIRED');
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
      if (command === '/help') {
        const budgetCode=this.#budgetCode(this.#time(),{reply:true,target:senderId});
        if (budgetCode) return result(false,budgetCode);
        const {renderHelpImage}=await import('./help-image.mjs');
        const image=renderHelpImage({features:defaultGroupFeatures('white'),privateChat:true});
        return this.#notify({text:'私聊使用指南',image,idempotencyKey:`reply:${incomingKey}`},replyTarget);
      }
      if (this.#commandHandler) {
        const now = this.#time();
        const budgetCode = this.#budgetCode(now, { reply: true, target:senderId });
        if (budgetCode) return result(false, budgetCode);
        let response;
        const context=this.#bindRequest({scope:'c2c',sessionKey:hash('chat:c2c:'+senderId),
          scopeKey:hash('chat-scope-c2c:'+senderId),userKey:hash('chat-user:'+senderId)},incomingKey,replyTarget,undefined,hash('social-event:'+message.kind+':'+(message.groupId||'')+':'+message.id));
        if (message.media?.length || message.readVoiceTranscript) {
          context.media = message.media || [];
          context.mediaEventKey = context.eventKey;
          if (typeof message.readVoiceTranscript === 'function') context.readVoiceTranscript = message.readVoiceTranscript;
        }
        try { response = await this.#commandHandler(command, context); }
        catch(error) { response = { text: timeoutNotice(error)||'这次处理未完成，请稍后再试。' }; }
        if (response) return this.#notify({ text: response.text, image: response.image, video:response.video, ...(response.richMedia===true?{richMedia:true}:{}), idempotencyKey: `reply:${incomingKey}` }, replyTarget);
      }
      return result(true, 'IGNORED');
    });
    if (official) return this.#queueOfficial({expiresAt:replyExpiresAt, epoch:this.#pauseEpoch,
      groupId:message.groupId, revision:this.#groupRevisions.get(message.groupId)}, work);
    try { return await this.#enqueue(work); } finally { if (countedIncoming) this.#pendingIncoming--; }
  }

  #observe(message,context) {
    if(typeof this.observeMessage!=='function')return;
    const revision=this.#groupRevisions.get(message.groupId);
    const isAllowed=()=>this.sendingEnabled()&&(message.kind==='group'?this.groupEnabled(message.groupId)&&this.#groupRevisions.get(message.groupId)===revision:this.#state.ownerId===message.senderId);
    if(!isAllowed())return;
    const media = message.media || [];
    // Owner voice is processed once in the foreground after memory opt-out checks.
    const data={text:message.kind==='group'?this.#groupCommand(message.groupId,message.text,message.mentioned).command:message.text,media:message.readVoiceTranscript?media.filter(a=>a.kind!=='audio'):media,eventKey:hash('social-event:'+message.kind+':'+(message.groupId||'')+':'+message.id)};
    try{Promise.resolve(this.observeMessage(data,{...context,eventKey:data.eventKey,isAllowed,
      allowsFeature:feature=>isAllowed()&&this.canUseFeature(message.groupId,feature)})).catch(()=>{});}catch{}
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
    if (!this.groupEnabled(groupId)) return result(false,'GROUP_DISABLED');
    const revision=this.#groupRevisions.get(groupId);
    // Official normalized @ events and leading aliases share the same path.
    const { command, addressed } = this.#groupCommand(groupId,rawCommand, message.mentioned);
    if (!addressed || !command) return result(true, 'IGNORED');
    // No group participant, including the owner, may invoke private management
    // or inspect owner status through group commands. /help is a fixed menu.
    if (command.startsWith('/') && !['/ping', '/help'].includes(command)&&!/^\/(?:识图|记忆)(?:\s|$)/u.test(command)) return result(true, 'IGNORED');
    const incomingKey = hash(`incoming:group:${groupId}:${id}`);
    if (this.#state.incoming.includes(incomingKey)) return result(false, 'DUPLICATE');
    const next = structuredClone(this.#state);
    next.incoming.push(incomingKey);
    next.incoming = next.incoming.slice(-CORE_LIMITS.historySize);
    try { await this.#persist(next); } catch { return this.#storageFailed(); }
    const target = { scope: 'group', targetId: groupId, msgId: id };
    if (command === '/ping') return this.#notify({ text: '连接正常（固定测试回复）', idempotencyKey: `reply:${incomingKey}` }, target, groupId);
    if (['帮助', '菜单', '/help'].includes(command)) {
      const budgetCode=this.#budgetCode(this.#time(),{reply:true,target:groupId});
      if (budgetCode) return result(false,budgetCode);
      const {renderHelpImage}=await import('./help-image.mjs');
      if (!this.groupEnabled(groupId)||this.#groupRevisions.get(groupId)!==revision) return result(false,'GROUP_ACCESS_DENIED');
      const image=renderHelpImage({features:this.groupFeatures(groupId),words:this.#enabledWakeWords(groupId).map(word=>word.text)});
      return this.#notify({
        image,requiredAccess:'chat',text:'本群使用指南',idempotencyKey:`reply:${incomingKey}`,
      }, target, groupId);
    }
    if (this.#commandHandler) {
      if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
      const now = this.#time();
      const budgetCode = this.#budgetCode(now, { reply: true, target:groupId });
      if (budgetCode) return result(false, budgetCode);
      let response;
      const access=this.groupAccess(groupId);
      const context=groupContext&&groupContext.access===access?groupContext:{ scope: 'group', access,
        sessionKey: hash('chat:group:'+groupId+':'+senderId), scopeKey: hash('chat-scope-group:'+groupId),
        userKey: hash('chat-user:'+senderId), currentSpeaker: 'member-'+hash('group-sender:'+groupId+':'+senderId).slice(0,12), groupContext: [] };
      this.#bindRequest(context,incomingKey,target,groupId,hash('social-event:'+message.kind+':'+(message.groupId||'')+':'+message.id));
      if(message.media?.length||message.readVoiceTranscript){
        context.media=message.media||[];context.mediaEventKey=context.eventKey;
        if (typeof message.readVoiceTranscript==='function') context.readVoiceTranscript=message.readVoiceTranscript;
      }
      try { response = await this.#commandHandler(command, context); }
      catch(error) { response = { text: timeoutNotice(error)||'这次处理未完成，请稍后再试。' }; }
      if (this.#groupRevisions.get(groupId)!==revision) return result(false,'GROUP_ACCESS_DENIED');
      if(response?.memoryReset===true)this.#groupContexts.delete(groupId);
      if (response) return this.#notify({ text: response.text, image: response.image, video:response.video, ...(response.richMedia===true?{richMedia:true}:{}),requiredAccess:response.requiredAccess,requiredFeature:response.requiredFeature,sensitive:response.sensitive, idempotencyKey: `reply:${incomingKey}` }, target, groupId);
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
  async notifyImageAllAllowed({image,idempotencyKey,groupsOnly=false,requiredFeature,groupTargets}={}) {
    if (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 8 || image.buffer.length > 5 * 1024 * 1024 ||
        !['image/png','image/jpeg'].includes(image.mimeType)) {
      return result(false, 'INVALID_INPUT', { results: [], attempted: 0, sent: 0 });
    }
    return this.#notifyAllAllowed({text:'',image,idempotencyKey,groupsOnly,requiredFeature,groupTargets});
  }

  captureMorningTargets(feature) {
    if (feature!==undefined&&!isMorningFeature(feature)) return [];
    return [...this.#state.allowedGroups,...this.#state.grayGroups]
      .filter(g=>(feature?[feature]:MORNING_FEATURE_KEYS).some(key=>this.canUseFeature(g.id,key)))
      .map(g=>({groupKey:groupKeyFor(g.id),revision:this.#groupRevisions.get(g.id)||0,
        morningRevisions:Object.fromEntries(MORNING_FEATURE_KEYS.filter(key=>this.canUseFeature(g.id,key))
          .map(key=>[key,this.#morningRevisions.get(g.id)?.[key]||0]))}));
  }

  #broadcastGroups(requiredFeature,groupTargets) {
    return [...this.#state.allowedGroups,...this.#state.grayGroups].filter(g=>
      this.groupEnabled(g.id)&&this.canUseFeature(g.id,requiredFeature||'notifications')&&
      (!groupTargets||groupTargets.some(t=>t.groupKey===groupKeyFor(g.id)&&
        (isMorningFeature(requiredFeature)&&t.morningRevisions?
          t.morningRevisions[requiredFeature]===(this.#morningRevisions.get(g.id)?.[requiredFeature]||0):
          t.revision===(this.#groupRevisions.get(g.id)||0)))));
  }

  pendingMorningParts(date,groupTargets) {
    return Object.fromEntries(['weather','campus'].map(part=>{
      const groups=this.#broadcastGroups(MORNING_PART_FEATURES[part],groupTargets);
      const operation=hash('broadcast:group-morning-'+date+'-'+part);
      const count=groups.filter(g=>!this.#state.deliveries.some(d=>d.key===hash('outgoing:broadcast:'+operation+':'+groupKeyFor(g.id)))).length;
      return [part,count];
    }));
  }

  async #notifyAllAllowed({text,image,idempotencyKey,groupsOnly=false,requiredFeature,groupTargets}) {
    return this.#enqueue(async () => {
      const empty = code => result(false, code, { results: [], attempted: 0, sent: 0 });
      if (this.#oneBotMode && this.#oneBotMode !== 'normal') return empty(this.#oneBotMode === 'receive-only' ? 'RECEIVE_ONLY' : 'PILOT_BROADCAST_DISABLED');
      if (!this.#ready) return empty('NOT_READY');
      if (!this.#state.ownerId) return empty('NOT_PAIRED');
      if (typeof text !== 'string' || (!text.trim() && image === undefined) || text.length > CORE_LIMITS.textLength || !validId(idempotencyKey)) return empty('INVALID_INPUT');
      // Validate before enumerating or sending any target, including after queue wait.
      if (image !== undefined && (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 8 || image.buffer.length > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(image.mimeType))) return empty('INVALID_INPUT');
      const operation = hash(`broadcast:${idempotencyKey}`);
      const targets = [...(groupsOnly?[]:[{ destination: 'owner', idempotencyKey: `broadcast:${operation}:owner` }]),
        ...this.#broadcastGroups(requiredFeature,groupTargets).map(group => ({ destination: group.name, groupId: group.id,
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
        const delivery = await this.#notify({ text, ...(image !== undefined ? {image} : {}), ...(requiredFeature?{requiredFeature}:{}), idempotencyKey: target.idempotencyKey }, undefined, target.groupId, target.groupId !== undefined);
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
    const ticket = this.#officialRequest.getStore();
    const stop = ticket && this.#commandStop(ticket);
    if (stop) return result(false, stop);
    if (!this.#ready) return result(false, 'NOT_READY');
    if (!this.#state.ownerId) return result(false, 'NOT_PAIRED');
    if (groupId !== undefined) {
      if (!validGroupId(groupId) || this.groupAccess(groupId)===null) return result(false, 'GROUP_DENIED');
      if(!this.#groupCanDeliver(groupId,input?.requiredAccess||((input?.image||input?.video)?'white':'chat'),input?.requiredFeature,proactiveGroup))return result(false,'GROUP_ACCESS_DENIED');
      if (!proactiveGroup && (replyTarget?.scope !== 'group' || replyTarget.targetId !== groupId || !validId(replyTarget.msgId))) return result(false, 'GROUP_REPLY_TARGET_INVALID');
    }
    const { text, idempotencyKey, image, video } = input ?? {};
    if (typeof text !== 'string' || (text.trim().length === 0 && image === undefined && video === undefined) || text.length > CORE_LIMITS.textLength || !validId(idempotencyKey)) {
      return result(false, 'INVALID_INPUT');
    }
    if(video!==undefined&&(!validVideo(video)||image!==undefined||input?.richMedia))return result(false,'INVALID_INPUT');
    if (image !== undefined && (!Buffer.isBuffer(image?.buffer) || image.buffer.length < 8 || image.buffer.length > 5 * 1024 * 1024 || !['image/png','image/jpeg'].includes(image.mimeType))) return result(false, 'INVALID_INPUT');
    if (input?.richMedia!==undefined && (typeof input.richMedia!=='boolean'||(input.richMedia&&(!image||!text.trim())))) return result(false, 'INVALID_INPUT');
    const key = hash(`outgoing:${idempotencyKey}`);
    const existing = this.#state.deliveries.find((entry) => entry.key === key);
    if (existing) return result(false, 'DUPLICATE', { deliveryState: existing.state });
    if (this.#state.paused || this.#pauseRequested) return result(false, 'PAUSED');
    const now = this.#time();
    const day = hkDay(now);
    const target = groupId ?? this.#state.ownerId;
    const budgetCode = this.#budgetCode(now, { reply: replyTarget !== undefined && replyTarget !== null, target });
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
    const caller = this.#caller.getStore();
    next.attempts.push({ at: now, day, ...(this.#oneBotMode ? {target:hash(target),...(caller ? {caller:hash(caller)} : {})} : {}) });
    next.deliveries.push({ key, state: 'inFlight', at: now, code: 'SENDING' });
    next.lastDeliveryCode = 'SENDING';
    // Persist the budget and key BEFORE any network call. A crash here favors
    // suppressing an uncertain notification over sending it twice.
    try { await this.#persist(next); } catch { return this.#storageFailed(); }
    let failure = null, receiptHash;
    try {
      const response = await this.#send({ ownerId: this.#state.ownerId, text, ...(input?.richMedia===true?{richMedia:true}:{}), ...(groupId !== undefined ? { groupId,requiredAccess:proactiveGroup?'white':input?.requiredAccess||(image||video?'white':'chat'),...(input?.requiredFeature?{requiredFeature:input.requiredFeature}:{}) } : {}), ...(proactiveGroup ? { proactiveGroup: true } : {}), ...(replyTarget ? { replyTarget } : {}), ...(image ? { image } : {}),...(video?{video}:{}) });
      if (response?.ok === false) throw response;
      if (this.#oneBotMode) {
        if (response?.ok !== true || !/^[a-f0-9]{64}$/.test(response.receiptHash ?? '')) throw Error('ONEBOT_DELIVERY_UNKNOWN');
        receiptHash = response.receiptHash;
      }
    } catch (error) { failure = classifyError(error); }
    const finished = structuredClone(this.#state);
    const record = finished.deliveries.find((entry) => entry.key === key);
    if (receiptHash) record.receiptHash = receiptHash;
    record.state = failure ? (failure.uncertain ? 'uncertain' : 'rejected') : 'sent';
    record.code = failure?.code ?? 'SENT';
    finished.lastDeliveryCode = record.code;
    if (failure?.pause) {
      this.#pauseEpoch++;
      this.#wakeWaitingCommands();
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
      key: `context:bot:${key}`, speaker: 'fish', role: 'assistant', text: video ? '[已发送动态天气视频]' : image ? '[已发送查询图片]' : input?.sensitive ? '[已查询账户余额]' : text,
    });
    if(failure?.timeoutText&&replyTarget&&(image||video)){
      // One separate text notice only when no original message was submitted.
      // Never resend an image or send again after uncertain submission.
      const notice=await this.#notify({text:failure.timeoutText,idempotencyKey:'timeout-notice:'+key,requiredAccess:input?.requiredAccess,requiredFeature:input?.requiredFeature},replyTarget,groupId,proactiveGroup);
      return result(false,failure.code,{deliveryState:record.state,timeoutNoticeSent:notice.ok===true});
    }
    return failure ? result(false, failure.code, { deliveryState: record.state }) : result(true, 'SENT');
  }
}
