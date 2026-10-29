import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson } from './storage.mjs';

const INPUT_REPLY = '这题太费鱼脑啦，拆成一个小问题吧。';
const SAFE_REPLY = '我只能陪聊和查天气，不能执行这些操作哦。';
const CREDENTIAL = /\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:app[_-]?secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|token|密钥|密码)["']?\s*[=:：]\s*\S+/iu;
const CREDENTIAL_VALUES = /\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:app[_-]?secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|token|密钥|密码)["']?\s*[=:：]\s*[^\r\n]+/giu;
const URL = /(?:\b(?:https?|ftp|file|javascript|data):[^\s<>"'`]+|\bwww\.[^\s<>"'`]+)/giu;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const PHONE = /(?<!\d)(?:(?:(?:\+?86|0086)[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}|(?:\+?852|\+?853)[ -]?\d{4}[ -]?\d{4}|(?:\+?886[ -]?9\d{2}|09\d{2})[ -]?\d{3}[ -]?\d{3})(?!\d)/gu;
const NATIVE_MENTION = /<[@#][^>\r\n]*>/gu;
const INJECTION = /(?:忽略|无视|绕过|覆盖|忘掉|跳过).{0,24}(?:规则|指令|提示|限制)|系统.{0,8}(?:提示词|指令)|(?:显示|输出|泄露|告诉).{0,20}(?:prompt|系统|密钥)|\b(?:developer|jailbreak|DAN)\b|\bignore\b.{0,25}\b(?:instructions?|rules?|prompts?)\b|\bsystem\s+prompt\b|\bdo\s+anything\s+now\b|<\|(?:system|developer|im_start)|\[\s*(?:system|developer)\s*\]|\brole\s*[:=]\s*(?:system|developer)\b/iu;
const COMPLEX = /(?:详细|逐步|复杂|多步).{0,8}(?:推理|论证|分析)|推理题|数学题|逻辑题|证明|求解|微积分|方程|算法|长篇|长文|论文|(?:写|生成|输出|撰写|制作).{0,20}(?:报告|方案|计划书|作文|文章|程序|代码)|(?:\d{3,}|[一二三四五六七八九十]+[百千])\s*字|\b\d{3,}\s*words?\b|程序|代码|编程|部署|执行命令|\b(?:python|javascript|typescript|powershell|bash|shell|sql|docker|kubernetes|code|program(?:ming)?|script|deploy(?:ment)?|essay|thesis|proof|prove|theorem|calculus)\b|\bstep[- ]by[- ]step\b|\b(?:const|let|var)\s+\w+\s*=|\bfunction\s*\(/iu;
const SENSITIVE = /诊断|处方|确诊|治疗方案|用药|药物剂量|吃什么药|开什么药|开药|(?:头疼|胸痛|症状).{0,12}(?:怎么办|判断|治疗)|金融交易|交易策略|投资建议|投资组合|股票推荐|买入|卖出|做多|做空|(?:买|卖|交易|推荐).{0,10}(?:股票|期货|基金|比特币|加密货币)|炒股|杠杆|止盈|止损|\b(?:diagnose|diagnosis|prescription|prescribe|dosage)\b|\b(?:buy|sell|trade|short)\s+(?:stocks?|shares?|crypto|bitcoin|futures?)\b/iu;

const unicodeLength = text => [...text].length;
const cap = (value, maximum) => Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : maximum;
function clean(raw, preserveLines = false) {
  let text = raw.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/gu, '\n').replace(NATIVE_MENTION, '');
  text = text.replace(/[\p{Cc}\p{Cf}]/gu, char => preserveLines && char === '\n' ? '\n' : char === '\n' || char === '\t' ? ' ' : '');
  return text;
}
function redact(text) {
  return text.replace(CREDENTIAL_VALUES, '[敏感信息]').replace(/[A-Za-z0-9_+/=-]{80,}/gu, '[长标识]').replace(EMAIL, '[邮箱]').replace(PHONE, '[手机号]').replace(/@/gu, '');
}

export function sanitizeContextText(raw, { maxChars = 240 } = {}) {
  if (typeof raw !== 'string') return '';
  const text = clean(raw);
  if (CREDENTIAL.test(text)) return '';
  return [...redact(text).replace(URL, '[链接]').replace(/\s+/gu, ' ').trim()].slice(0, cap(Number.isFinite(maxChars) ? maxChars : 240, 320)).join('');
}

export function checkChatInput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'CHAT_INPUT_INVALID', reply: INPUT_REPLY };
  const text = clean(raw, true).trim();
  if (!text) return { ok: false, reason: 'CHAT_INPUT_EMPTY' };
  const reject = reason => ({ ok: false, reason, reply: INPUT_REPLY });
  if (unicodeLength(text) > 320 || text.split('\n').length > 3) return reject('CHAT_INPUT_TOO_LONG');
  if (CREDENTIAL.test(text)) return reject('CHAT_INPUT_SENSITIVE');
  if (INJECTION.test(text.replace(/\s+/gu, ' '))) return reject('CHAT_INPUT_INJECTION');
  if (/```|~~~|[A-Za-z0-9_+/.=-]{80,}/u.test(text)) return reject('CHAT_INPUT_COMPLEX');
  if (/(?:https?|ftp|file|javascript|data):|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|cn|io)\b|附件|上传的|\battachments?\b|(?:看|分析|读取|总结|处理|打开).{0,12}(?:文件|文档|PDF|图片|照片|视频|音频|链接|网址)|\b(?:read|summarize|analyze|open)\s+(?:(?:this|the|a)\s+)?(?:file|pdf|image|video|audio)\b|\.(?:pdf|docx?|xlsx?|pptx?|zip|png|jpe?g|mp4|mp3)\b/iu.test(text)) return reject('CHAT_INPUT_ATTACHMENT');
  const calculation=/古月币|HU\$|马里|马时|生活费|全马|半马|工资/iu.test(text)&&!/代码|程序|编程|部署|论文|长文|千字|\d{3,}字|python|script|shell/iu.test(text);
  if (COMPLEX.test(text)&&!calculation) return reject('CHAT_INPUT_COMPLEX');
  if (SENSITIVE.test(text)) return reject('CHAT_INPUT_SENSITIVE');
  return { ok: true, reason: 'CHAT_INPUT_OK' };
}

export function boundChatReply(raw, maxChars = 80) {
  const maximum = cap(maxChars, 80);
  if (typeof raw !== 'string' || maximum === 0) return '';
  let text = clean(raw, true).replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, '');
  text = redact(text).replace(URL, '').replace(/[\t ]+/gu, ' ').trim();
  if (/已(?:经)?(?:为你|帮你)?(?:执行|修改(?:了)?配置|转账|删除(?:了)?文件)/u.test(text)) text = SAFE_REPLY;
  let truncated = false;
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length > 2) truncated = true;
  text = lines.slice(0, 2).join('\n');
  text = text.replace(/[A-Za-z]{25,}/gu, word => { truncated = true; return word.slice(0, 24); });
  const words = [...text.matchAll(/[A-Za-z]+(?:['’-][A-Za-z]+)*/gu)];
  if (words.length > 24) { text = text.slice(0, words[23].index + words[23][0].length).trimEnd(); truncated = true; }
  const chars = [...text]; let sentences = 0;
  for (let index = 0; index < chars.length; index++) {
    const punctuation = /[。！？!?]/u.test(chars[index]) || (chars[index] === '.' && !(/\d/u.test(chars[index - 1] ?? '') && /\d/u.test(chars[index + 1] ?? '')));
    if (!punctuation) continue;
    while (index + 1 < chars.length && /[。！？!?.]/u.test(chars[index + 1])) index++;
    if (++sentences === 2) {
      if (chars.slice(index + 1).join('').trim()) truncated = true;
      text = chars.slice(0, index + 1).join(''); break;
    }
  }
  if (unicodeLength(text) > maximum) truncated = true;
  if (truncated) return [...text.replace(/…+$/u, '').trimEnd()].slice(0, maximum - 1).join('') + '…';
  return [...text].slice(0, maximum).join('');
}

const DEFAULT_LIMITS = Object.freeze({ globalPerMinute: 15, scopePerMinute: 12, userPerMinute: 9, userCooldownMs: 0, daily: 180 });
const MAX_BYTES = 256 * 1024, MAX_RECORDS = 1024, RETENTION_MS = 48 * 60 * 60_000;
const hashKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const dayOf = now => new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
const denied = code => ({ ok: false, code });

export class ModelRequestBudget {
  #file; #now; #save; #limits; #valid; #tail = Promise.resolve();
  constructor(home, { now = Date.now, save = atomicJson, limits = {} } = {}) {
    this.#valid = typeof home === 'string' && path.isAbsolute(home) && typeof now === 'function' && typeof save === 'function' &&
      limits !== null && typeof limits === 'object' && !Array.isArray(limits) && Object.keys(limits).every(key => Object.hasOwn(DEFAULT_LIMITS, key));
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
    this.#valid &&= Object.entries(this.#limits).every(([key, value]) => Number.isSafeInteger(value) && value >= (key === 'userCooldownMs' ? 0 : 1));
    if (this.#valid) this.#file = path.join(home, '.private', 'model-budget.json');
    this.#now = now; this.#save = save;
  }

  async #load(now) {
    let handle;
    try { handle = await fs.open(this.#file, 'r'); }
    catch (error) { if (error?.code === 'ENOENT') return []; throw new Error(); }
    let raw;
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error();
      raw = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    } finally { await handle.close(); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 2 || raw.version !== 1 ||
        !Array.isArray(raw.records) || raw.records.length > MAX_RECORDS) throw new Error();
    for (const record of raw.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 3 ||
          !Number.isSafeInteger(record.at) || record.at < 0 || record.at > now || !hashKey(record.userKey) || !hashKey(record.scopeKey)) throw new Error();
    }
    return raw.records.filter(record => record.at > now - RETENTION_MS).map(({ at, userKey, scopeKey }) => ({ at, userKey, scopeKey }));
  }

  acquire(input) {
    let request;
    try { request = { userKey: input?.userKey, scopeKey: input?.scopeKey }; }
    catch { return Promise.resolve(denied('MODEL_BUDGET_INVALID')); }
    const pending = this.#tail.then(async () => {
      if (!this.#valid || !hashKey(request.userKey) || !hashKey(request.scopeKey)) return denied('MODEL_BUDGET_INVALID');
      let now;
      try { now = this.#now(); } catch { return denied('MODEL_BUDGET_INVALID'); }
      if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - RETENTION_MS) return denied('MODEL_BUDGET_INVALID');
      try {
        const records = await this.#load(now), minute = records.filter(record => record.at > now - 60_000);
        if (records.filter(record => dayOf(record.at) === dayOf(now)).length >= this.#limits.daily) return denied('MODEL_RATE_LIMIT_DAY');
        const userRecords = records.filter(record => record.userKey === request.userKey);
        if (userRecords.some(record => now - record.at < this.#limits.userCooldownMs)) return denied('MODEL_RATE_LIMIT_COOLDOWN');
        if (minute.filter(record => record.userKey === request.userKey).length >= this.#limits.userPerMinute) return denied('MODEL_RATE_LIMIT_USER');
        if (minute.filter(record => record.scopeKey === request.scopeKey).length >= this.#limits.scopePerMinute) return denied('MODEL_RATE_LIMIT_SCOPE');
        if (minute.length >= this.#limits.globalPerMinute) return denied('MODEL_RATE_LIMIT_GLOBAL');
        if (records.length >= MAX_RECORDS) return denied('MODEL_BUDGET_FULL');
        records.push({ at: now, ...request });
        await this.#save(this.#file, { version: 1, records });
        return { ok: true, code: 'MODEL_BUDGET_ACQUIRED' };
      } catch { return denied('MODEL_BUDGET_UNAVAILABLE'); }
    });
    this.#tail = pending.catch(() => {});
    return pending;
  }
}

// Natural conversation keeps privacy/action filtering, with only a generous flood ceiling.
export function naturalChatReply(raw,maxChars=600){
  if(typeof raw!=='string')return '';
  let text=redact(clean(raw,true)).replace(URL,'').replace(/```[\s\S]*?(?:```|$)/gu,'').trim();
  if(/已(?:经)?(?:为你|帮你)?(?:执行|修改(?:了)?配置|转账|删除(?:了)?文件)/u.test(text))text=SAFE_REPLY;
  const maximum=cap(maxChars,600);return [...text].slice(0,maximum).join('');
}
