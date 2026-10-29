import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, protectCredential, unprotectCredential, credentialFormat, supportedCredentialFormat } from './storage.mjs';

const DEFAULTS = Object.freeze({ enabled: false, provider: 'deepseek', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', apiKey: '' });
const BASE_URLS = new Set(['https://api.deepseek.com', 'https://api.deepseek.com/v1']);
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;
const API_KEY = /^\S{8,512}$/u;
const CONFIG_KEYS = ['enabled', 'provider', 'model', 'baseURL', 'apiKey'];
const failure = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicStatus = config => ({ enabled: config.enabled, configured: Boolean(config.apiKey), model: config.model, baseURL: config.baseURL, provider: config.provider });

function validConfig(config) {
  return object(config) && Object.keys(config).length === CONFIG_KEYS.length &&
    CONFIG_KEYS.every(key => Object.hasOwn(config, key)) &&
    typeof config.enabled === 'boolean' && config.provider === 'deepseek' &&
    typeof config.model === 'string' && MODEL.test(config.model) && BASE_URLS.has(config.baseURL) &&
    typeof config.apiKey === 'string' && (config.apiKey === '' || API_KEY.test(config.apiKey)) &&
    (!config.enabled || config.apiKey !== '');
}

/** The caller must initialize and restrict .private through PrivateStore first. */
export class AgentConfigStore {
  #file;
  #protect;
  #unprotect;
  #tail = Promise.resolve();

  constructor(home, { protect = protectCredential, unprotect = unprotectCredential } = {}) {
    if (typeof home !== 'string' || !path.isAbsolute(home) || typeof protect !== 'function' || typeof unprotect !== 'function') {
      throw failure('AGENT_CONFIG_INVALID');
    }
    this.#file = path.join(home, '.private', 'agent-config.json');
    this.#protect = protect;
    this.#unprotect = unprotect;
  }

  #enqueue(work) {
    const pending = this.#tail.then(work);
    this.#tail = pending.catch(() => {});
    return pending;
  }

  async #readConfig() {
    let raw;
    try { raw = await fs.readFile(this.#file, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULTS };
      throw failure('AGENT_CONFIG_UNAVAILABLE');
    }
    try {
      const envelope = JSON.parse(raw);
      if (!object(envelope) || Object.keys(envelope).length !== 3 || envelope.version !== 1 ||
          !supportedCredentialFormat(envelope.format) || typeof envelope.cipher !== 'string' ||
          envelope.cipher.length < 1 || envelope.cipher.length > 65536) throw new Error();
      const config = await this.#unprotect(envelope.cipher);
      if (!validConfig(config)) throw new Error();
      return Object.fromEntries(CONFIG_KEYS.map(key => [key, config[key]]));
    } catch { throw failure('AGENT_CONFIG_UNAVAILABLE'); }
  }

  async read() {
    return this.#enqueue(() => this.#readConfig());
  }

  async status() {
    return this.#enqueue(async () => publicStatus(await this.#readConfig()));
  }

  async save(input) {
    return this.#enqueue(async () => {
      if (!object(input) || Object.keys(input).some(key => !CONFIG_KEYS.includes(key)) ||
          typeof input.enabled !== 'boolean' || typeof input.model !== 'string' || !MODEL.test(input.model) ||
          (Object.hasOwn(input, 'provider') && input.provider !== 'deepseek') ||
          (Object.hasOwn(input, 'baseURL') && !BASE_URLS.has(input.baseURL)) ||
          (Object.hasOwn(input, 'apiKey') && (typeof input.apiKey !== 'string' || !API_KEY.test(input.apiKey)))) {
        throw failure('AGENT_CONFIG_INVALID');
      }
      const current = await this.#readConfig();
      if (Object.hasOwn(input, 'baseURL') && input.baseURL !== current.baseURL) throw failure('AGENT_CONFIG_INVALID');
      const config = { ...current, enabled: input.enabled, model: input.model,
        apiKey: Object.hasOwn(input, 'apiKey') ? input.apiKey : current.apiKey };
      if (!validConfig(config)) throw failure('AGENT_CONFIG_INVALID');
      try {
        const cipher = await this.#protect(config);
        if (typeof cipher !== 'string' || cipher.length < 1 || cipher.length > 65536) throw new Error();
        await atomicJson(this.#file, { version: 1, format: credentialFormat(), cipher });
      } catch { throw failure('AGENT_CONFIG_UNAVAILABLE'); }
      return publicStatus(config);
    });
  }
}
