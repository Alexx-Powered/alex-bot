import {incomingMedia} from './incoming-media.mjs';
import { QQBot } from '@tencent-connect/qqbot-nodejs';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });
const REPLY_WINDOW_MS = 5 * 60 * 1000;
const MAX_OBSERVED_MESSAGES = 500;
const MAX_TEXT_LENGTH = 4000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OPENID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TERMINAL_CODES = new Set(['GATEWAY_FATAL_CLOSE', 'GATEWAY_RETRY_EXHAUSTED']);
// Used only to stop a later @ copy from re-admitting a command already received
// through an alias. BridgeCore remains responsible for routing and permissions.
const ALIAS_ADDRESS = /^(?:梁圣|梁祖|梁嗨|小难梁|大肥鱼)\s+\S/u;

/** Deliberately excludes the SDK's message, URL, response body and cause. */
export class QQAdapterError extends Error {
  constructor(code, { httpStatus, bizCode, kind = 'error', fatal = false, phase, messageAttempted, timedOut } = {}) {
    super(code);
    this.name = 'QQAdapterError';
    this.code = code;
    this.kind = kind;
    this.fatal = fatal;
    if (Number.isInteger(httpStatus) && httpStatus >= 0 && httpStatus <= 599) this.httpStatus = httpStatus;
    if (Number.isSafeInteger(bizCode) && bizCode >= 0) this.bizCode = bizCode;
    if (phase === 'upload' || phase === 'send') this.phase = phase;
    if (typeof messageAttempted === 'boolean') this.messageAttempted = messageAttempted;
    if(timedOut===true)this.timedOut=true;
  }
}

function safeError(error, fallback) {
  const closeCode = Number.isInteger(error?.closeCode) ? error.closeCode : undefined;
  if (closeCode === 4915) return new QQAdapterError('QQ_BOT_BANNED', { kind: 'blocked', fatal: true });
  if (closeCode === 4914) return new QQAdapterError('QQ_BOT_UNAVAILABLE', { kind: 'blocked', fatal: true });
  if (error?.code === 'GATEWAY_RETRY_EXHAUSTED') {
    return new QQAdapterError('QQ_RECONNECT_EXHAUSTED', { kind: 'blocked', fatal: true });
  }
  if (error?.code === 'GATEWAY_FATAL_CLOSE') {
    return new QQAdapterError('QQ_GATEWAY_STOPPED', { kind: 'blocked', fatal: true });
  }
  const httpStatus = error?.httpStatus;
  const bizCode = error?.bizCode;
  const details = { httpStatus, bizCode };
  if(error?.name==='TimeoutError'||error?.name==='AbortError'||/^Request timeout \[/u.test(error?.message||''))return new QQAdapterError('QQ_HTTP_TIMEOUT',{...details,timedOut:true});
  if (httpStatus === 429 || bizCode === 50002) {
    return new QQAdapterError('QQ_RATE_LIMITED', { ...details, kind: 'rate_limited' });
  }
  if (httpStatus === 401 || httpStatus === 403 || bizCode === 40034105) {
    return new QQAdapterError('QQ_PERMISSION_DENIED', { ...details, kind: 'permission_denied' });
  }
  return new QQAdapterError(fallback, details);
}

function isId(value) {
  return typeof value === 'string' && OPENID_PATTERN.test(value);
}

function isMessageId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function groupMention(message, appId) {
  const mentions = Array.isArray(message.mentions) ? message.mentions.slice(0, 100) : [];
  const own = mentions.filter(item => item?.is_you === true);
  const ids = new Set(isId(appId) ? [appId] : []);
  const names = new Set();
  // SDK dispatcher forwards these fields from the authenticated gateway event.
  // Never infer self identity from nickname, bot:true, or message text alone.
  for (const item of own) for (const field of ['id', 'user_openid', 'member_openid']) if (isId(item[field])) ids.add(item[field]);
  for (const item of own) for (const field of ['nickname', 'username']) {
    const name = item[field];
    if (typeof name === 'string' && name === name.trim() && name.length > 0 && [...name].length <= 80 && !/[@＠<>\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) names.add(name);
  }
  const text = typeof message.content === 'string' ? message.content : '';
  const hasNativeSelfTag = [...ids].some(id => text.includes(`<@!${id}>`) || text.includes(`<@${id}>`));
  return {
    // The installed official SDK also supports an exact configured self tag
    // in all-message payloads whose structured mentions field is absent.
    mentioned: message.rawEventType === 'GROUP_AT_MESSAGE_CREATE' || own.length > 0 || hasNativeSelfTag,
    ids, names,
    diagnostic: {
      rawType: message.rawEventType, structuredSelf: own.length > 0,
      mentionsCount: mentions.length,
      hasNativeSelfTag,
      hasAnyNativeTag: /<@!?[A-Za-z0-9_-]{1,128}>/u.test(text),
      decision: 'invalid',
    },
  };
}

const observedKey = (scope, targetId, msgId) => `${scope}:${targetId}:${msgId}`;

/** Accept only the in-memory images produced by our trusted weather service. */
export function imageBase64(image) {
  if (!image || typeof image !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(image)) ||
      Reflect.ownKeys(image).length !== 2 ||
      !Object.hasOwn(image, 'buffer') || !Object.hasOwn(image, 'mimeType') ||
      !Buffer.isBuffer(image.buffer)) throw new QQAdapterError('QQ_IMAGE_INVALID');
  const { buffer, mimeType } = image;
  if (buffer.length > MAX_IMAGE_BYTES) throw new QQAdapterError('QQ_IMAGE_TOO_LARGE');
  const isPng = mimeType === 'image/png' && buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = mimeType === 'image/jpeg' && buffer.length >= 5 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (!isPng && !isJpeg) throw new QQAdapterError('QQ_IMAGE_INVALID');
  // Materialize before any await so the caller cannot mutate the validated
  // buffer while upload authorization or the network request is pending.
  return buffer.toString('base64');
}

/** Official QQ API transport only. The caller owns pairing, quotas and policy. */
export class QQAdapter {
  #onMessage;
  #onStatus;
  #createBot;
  #now;
  #canSend;
  #bot = null;
  #botMentionId = null;
  #generation = 0;
  #current = { state: 'disconnected', code: null };
  #observed = new Map();
  #lastGroupDiagnostic = null;
  #lastSendDiagnostic = null;

  constructor({ onMessage = () => {}, onStatus = () => {}, createBot = (options) => new QQBot(options), now = Date.now, canSend = () => true } = {}) {
    if (typeof canSend !== 'function') throw new TypeError('INVALID_SEND_GUARD');
    this.#onMessage = onMessage;
    this.#onStatus = onStatus;
    this.#createBot = createBot;
    this.#now = now;
    this.#canSend = canSend;
  }

  status() {
    return { ...this.#current };
  }

  /** Addressing diagnostics only, never IDs, content, names or authorization. */
  diagnostics() {
    return { lastGroup: this.#lastGroupDiagnostic ? { ...this.#lastGroupDiagnostic } : null,
      ...(this.#lastSendDiagnostic?{lastSend:{...this.#lastSendDiagnostic}}:{}) };
  }

  #emitStatus(state, code = null) {
    this.#current = { state, code };
    // Consumer callbacks must not create unhandled rejections or SDK log data.
    try { Promise.resolve(this.#onStatus(this.status())).catch(() => {}); } catch {}
  }

  #detach() {
    ++this.#generation;
    const old = this.#bot;
    this.#bot = null;
    this.#botMentionId = null;
    this.#observed.clear();
    this.#lastGroupDiagnostic = null;
    // SDK 1.0.5 stop() is synchronous and aborts its background connection.
    try { old?.stop(); } catch {}
  }

  async connect({ appId, appSecret }) {
    this.#detach();
    const generation = this.#generation;
    this.#emitStatus('connecting');
    let bot;
    try {
      bot = this.#createBot({
        appId,
        appSecret,
        transport: 'websocket',
        baseUrl: 'https://api.bot.qq.com',
        tokenBaseUrl: 'https://api.bot.qq.com',
        markdownSupport: false,
        // QQ exposes C2C and group events through the same intent bit. Only
        // explicit group @ events pass below; guild/interaction APIs are unused.
        intents: 1 << 25,
        reconnect: { maxAttempts: 3, delays: [1000, 5000, 15000] },
        logger: NOOP_LOGGER,
      });
      this.#bot = bot;
      this.#botMentionId = isId(appId) ? appId : null;
      const active = () => this.#generation === generation && this.#bot === bot;
      const ready = () => {
        if (active() && this.#current.state !== 'blocked') this.#emitStatus('connected');
      };
      bot.on('ready', ready);
      bot.on('resumed', ready);
      bot.on('disconnected', (event) => {
        if (!active() || this.#current.state === 'blocked') return;
        if (event?.code === 4914 || event?.code === 4915 || event?.willReconnect === false) {
          const failure = safeError({ closeCode: event?.code, code: 'GATEWAY_FATAL_CLOSE' }, 'QQ_DISCONNECTED');
          this.#emitStatus('blocked', failure.code);
          try { bot.stop(); } catch {}
          return;
        }
        this.#emitStatus('reconnecting', event?.code === 4008 ? 'QQ_RATE_LIMITED' : 'QQ_DISCONNECTED');
      });
      bot.on('error', (error) => {
        if (!active() || this.#current.state === 'blocked') return;
        const failure = safeError(error, 'QQ_CONNECTION_ERROR');
        this.#emitStatus(failure.fatal ? 'blocked' : this.#current.state, failure.code);
        if (failure.fatal) { try { bot.stop(); } catch {} }
      });
      bot.on('message', async (_ctx, message) => {
        if (!active() || this.#current.state !== 'connected') return;
        const normalized = this.#normalize(message);
        if (!normalized) return;
        try { await this.#onMessage(normalized); } catch {
          if (active() && this.#current.state !== 'blocked') this.#emitStatus(this.#current.state, 'QQ_MESSAGE_HANDLER_FAILED');
        }
      });
      // start() lives until shutdown. Do not await it as a connection request.
      Promise.resolve().then(() => active() ? bot.start() : undefined).then(() => {
        if (active() && this.#current.state !== 'blocked') this.#emitStatus('disconnected', 'QQ_CONNECTION_ENDED');
      }).catch((error) => {
        if (!active() || this.#current.state === 'blocked') return;
        const failure = safeError(error, 'QQ_CONNECT_FAILED');
        this.#emitStatus(failure.fatal || TERMINAL_CODES.has(error?.code) ? 'blocked' : 'error', failure.code);
        try { bot.stop(); } catch {}
      });
    } catch (error) {
      const failure = safeError(error, 'QQ_CONNECT_FAILED');
      this.#detach();
      this.#emitStatus('error', failure.code);
      throw failure;
    }
    return this.status();
  }

  async disconnect() {
    this.#detach();
    this.#emitStatus('disconnected');
    return this.status();
  }

  #normalize(message) {
    if (!message || !['c2c', 'group'].includes(message.kind)) return null;
    const isGroup = message.kind === 'group';
    const mention = isGroup && ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(message.rawEventType)
      ? groupMention(message, this.#botMentionId) : null;
    if (mention) this.#lastGroupDiagnostic = mention.diagnostic;
    if (message.senderIsBot === true) { if (mention) mention.diagnostic.decision = 'ignored'; return null; }
    // Plain group messages require QQ's "receive all messages" permission.
    // The core independently enforces the group whitelist and addressing rules.
    if (isGroup && (!['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'].includes(message.rawEventType) || !isId(message.groupOpenid))) return null;
    if (!isId(message.senderId) || !isMessageId(message.messageId)) return null;
    const media=incomingMedia(message.attachments);
    if (typeof message.content !== 'string' && message.content !== undefined) return null;
    let text = message.content || '';
    if (!text.trim() && !media.length) return null;
    if (mention?.mentioned) {
      // Current group events may already omit the bot mention. Remove just one
      // exact leading self marker, using this connection's AppID or the
      // gateway's is_you row; other people and inner mentions stay intact.
      const leading = text.trimStart();
      let stripped = false;
      for (const prefix of [...mention.ids].flatMap(id => [`<@!${id}>`, `<@${id}>`])) {
        if (leading.startsWith(prefix)) { text = leading.slice(prefix.length).trimStart(); stripped = true; break; }
      }
      if (!stripped) for (const name of mention.names) {
        const prefix = '@' + name, remaining = leading.slice(prefix.length);
        if (leading.startsWith(prefix) && (!remaining || /^\s/u.test(remaining))) { text = remaining.trimStart(); break; }
      }
    }
    if (!text.trim()) {
      if (!media.length) return null;
      text=media.some(a=>a.kind==='audio')?'[语音]':'[图片]';
    }
    const scope = isGroup ? 'group' : 'c2c';
    const targetId = isGroup ? message.groupOpenid : message.senderId;
    const target = message.replyTarget;
    if (target?.scope !== scope || target.targetId !== targetId || target.msgId !== message.messageId) return null;
    const now = this.#now();
    const issuedAt = typeof message.timestamp === 'string' ? Date.parse(message.timestamp) : NaN;
    // Conservative local freshness policy, not a claim about QQ's allowance.
    if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt >= REPLY_WINDOW_MS) return null;
    for (const [key, value] of this.#observed) {
      if (value.expiresAt <= now) this.#observed.delete(key);
    }
    const key = observedKey(scope, targetId, message.messageId);
    const addressed = !isGroup || mention?.mentioned === true || ALIAS_ADDRESS.test(text.trim());
    const previous = this.#observed.get(key);
    if (previous) {
      // All-message mode may deliver the ordinary copy before its trusted @
      // copy. Upgrade just once, without extending the original reply window.
      if (!(isGroup && mention?.mentioned === true && !previous.addressed && previous.senderId === message.senderId)) {
        if (mention) mention.diagnostic.decision = 'duplicate';
        return null;
      }
      previous.addressed = true;
    } else {
      if (this.#observed.size >= MAX_OBSERVED_MESSAGES) this.#observed.delete(this.#observed.keys().next().value);
      this.#observed.set(key, { expiresAt: Math.min(now, issuedAt) + REPLY_WINDOW_MS, addressed, senderId: message.senderId });
    }
    // Ignored here means no wake-up; the core may still retain ordinary group
    // background. It does not claim a business action or a successful QQ reply.
    if (mention) mention.diagnostic.decision = addressed ? 'accepted' : 'ignored';
    return {
      kind: scope,
      ...(isGroup ? { groupId: targetId } : {}),
      ...(mention?.mentioned === true ? { mentioned: true } : {}),
      id: message.messageId,
      senderId: message.senderId,
      text,
      ...(media.length?{media}:{}),
      replyTarget: { scope, targetId, msgId: message.messageId },
    };
  }

  #target(ownerId, replyTarget, groupId, proactiveGroup = false) {
    const isGroup = groupId !== undefined;
    if (typeof proactiveGroup !== 'boolean' || (proactiveGroup && !isGroup)) throw new QQAdapterError('QQ_GROUP_INVALID');
    if (isGroup && !isId(groupId)) throw new QQAdapterError('QQ_GROUP_INVALID');
    const target = { scope: isGroup ? 'group' : 'c2c', targetId: isGroup ? groupId : ownerId };
    // A fresh observed group event authorizes the command response locally.
    // The persisted whitelist and member permissions are enforced by BridgeCore.
    if (isGroup && !proactiveGroup && (replyTarget === undefined || replyTarget === null)) throw new QQAdapterError('QQ_REPLY_TARGET_INVALID');
    if (replyTarget !== undefined && replyTarget !== null) {
      if (replyTarget.scope !== target.scope || replyTarget.targetId !== target.targetId || !isMessageId(replyTarget.msgId)) {
        throw new QQAdapterError('QQ_REPLY_TARGET_INVALID');
      }
      const observed = this.#observed.get(observedKey(target.scope, target.targetId, replyTarget.msgId));
      if (!observed) throw new QQAdapterError('QQ_REPLY_TARGET_INVALID');
      if (observed.expiresAt <= this.#now()) throw new QQAdapterError('QQ_REPLY_TARGET_EXPIRED');
      target.msgId = replyTarget.msgId;
    }
    return target;
  }

  async send({ ownerId, text, replyTarget, image, groupId, proactiveGroup = false, requiredAccess = 'chat', richMedia = false } = {}) {
    if (!isId(ownerId)) throw new QQAdapterError('QQ_OWNER_INVALID');
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH ||
        (image === undefined && !text.trim())) throw new QQAdapterError('QQ_TEXT_INVALID');
    if(typeof richMedia!=='boolean'||(richMedia&&(image===undefined||!text.trim())))throw new QQAdapterError('QQ_TEXT_INVALID');
    if (!this.#bot || this.#current.state !== 'connected') throw new QQAdapterError('QQ_NOT_CONNECTED');
    // Only BridgeCore's explicit local broadcast method sets proactiveGroup;
    // public notifications and Python/chat tool results cannot supply it.
    const authorizedTarget = this.#target(ownerId, replyTarget, groupId, proactiveGroup);
    // Group users requested independent messages without an implicit @ reply.
    // Retain msgId only for local authorization/freshness checks; the group API
    // request is explicitly proactive and must pass the platform's permissions.
    // Never fall back to a referenced/passive reply if proactive sending fails.
    const wireTarget = authorizedTarget.scope === 'group'
      ? { scope: 'group', targetId: authorizedTarget.targetId }
      : authorizedTarget;
    const fileData = image === undefined ? null : imageBase64(image);
    const bot = this.#bot;
    const generation = this.#generation;
    let phase = fileData === null ? 'send' : 'upload';
    let messageAttempted = false;
    try {
      if (this.#canSend({groupId,proactiveGroup,requiredAccess}) !== true) throw new QQAdapterError('QQ_SEND_CANCELLED');
      if (fileData !== null) {
        // SDK 1.0.5 uploadMedia/sendImage have a built-in two-retry policy and
        // may select chunked upload. Its public api.post -> ApiClient.request
        // path makes one request, with the same token manager and fixed origin.
        // srv_send_msg=false is essential: upload must not send a message.
        const upload = await bot.api.post(`/v2/${authorizedTarget.scope === 'group' ? 'groups' : 'users'}/${authorizedTarget.targetId}/files`, {
          file_type: 1,
          file_data: fileData,
          srv_send_msg: false,
          ...(authorizedTarget.scope === 'group' ? { file_name: image.mimeType === 'image/png' ? 'weather.png' : 'weather.jpg' } : {}),
        });
        if (typeof upload?.file_info !== 'string' || !upload.file_info.trim() || upload.file_info.length > 65_536) {
          throw new QQAdapterError('QQ_UPLOAD_RESPONSE_INVALID');
        }
        phase = 'send';
        if (this.#bot !== bot || this.#generation !== generation || this.#current.state !== 'connected') {
          throw new QQAdapterError('QQ_CONNECTION_CHANGED');
        }
        // Upload can take time. Recheck the original local authorization for
        // either scope before sending; expiry or reconnect always stops delivery.
        if (authorizedTarget.msgId) this.#target(ownerId, authorizedTarget, groupId);
        if (this.#canSend({groupId,proactiveGroup,requiredAccess}) !== true) throw new QQAdapterError('QQ_SEND_CANCELLED');
        messageAttempted = true;
        // Opt-in rich media carries content + media in ONE message. Legacy
        // weather/classroom image-only callers keep their preceding behavior.
        await bot.send({ target: wireTarget, msgType: 7, ...(richMedia?{content:text}:{}), media: { file_info: upload.file_info } });
      } else {
        messageAttempted = true;
        await bot.sendText(wireTarget, text);
      }
      // Upload success alone never reaches this return. Neither phase retries.
      return { ok: true };
    } catch (error) {
      const normalized = error instanceof QQAdapterError ? error : safeError(error, phase === 'upload' ? 'QQ_UPLOAD_FAILED' : 'QQ_SEND_FAILED');
      const failure = new QQAdapterError(normalized.timedOut?(phase==='upload'?'QQ_UPLOAD_TIMEOUT':'QQ_SEND_TIMEOUT'):normalized.code, { ...normalized, phase, messageAttempted });
      this.#lastSendDiagnostic={at:new Date(this.#now()).toISOString(),scope:authorizedTarget.scope,
        code:failure.code,phase,messageAttempted,...(failure.httpStatus!==undefined?{httpStatus:failure.httpStatus}:{}),
        ...(failure.bizCode!==undefined?{bizCode:failure.bizCode}:{})};
      if (this.#bot === bot && this.#generation === generation) {
        if (this.#current.state !== 'blocked') this.#emitStatus(failure.fatal ? 'blocked' : this.#current.state, failure.code);
        if (failure.fatal) { try { bot.stop(); } catch {} }
      }
      throw failure;
    }
  }
}
