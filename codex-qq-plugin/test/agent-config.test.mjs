import {credentialFormat} from '../src/storage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentConfigStore } from '../src/agent-config.mjs';

const KEY = 'FAKE-deepseek-agent-test-key';
const defaults = { enabled: false, provider: 'deepseek', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', apiKey: '' };
function memoryCodec() {
  const values = new Map();
  return {
    async protect(value) { const cipher = `fake-cipher-${randomUUID()}`; values.set(cipher, structuredClone(value)); return cipher; },
    async unprotect(cipher) { if (!values.has(cipher)) throw new Error(`DECRYPT_FAILED ${cipher}`); return structuredClone(values.get(cipher)); },
  };
}
async function fixture(t, { initialized = true } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-agent-config-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('qq-agent-config-test-'));
    await fs.rm(home, { recursive: true, force: true });
  });
  if (initialized) await fs.mkdir(path.join(home, '.private'), { mode: 0o700 });
  const codec = memoryCodec(), file = path.join(home, '.private', 'agent-config.json');
  return { home, file, codec, store: new AgentConfigStore(home, codec) };
}
const hasCode = code => error => { assert.equal(error.code, code); assert.equal(error.message, code); assert.equal(error.cause, undefined); return true; };
async function writeEncrypted(f, config) {
  await fs.writeFile(f.file, JSON.stringify({ version: 1, format: 'windows-dpapi-v1', cipher: await f.codec.protect(config) }));
}

test('missing configuration returns disabled defaults without creating private files', async t => {
  const f = await fixture(t, { initialized: false });
  assert.deepEqual(await f.store.read(), defaults);
  assert.deepEqual(await f.store.status(), { enabled: false, configured: false, model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', provider: 'deepseek' });
  await assert.rejects(fs.stat(path.join(f.home, '.private')), { code: 'ENOENT' });
  const copy = await f.store.read(); copy.enabled = true; copy.apiKey = KEY;
  assert.deepEqual(await f.store.read(), defaults);
});

test('encrypted persistence, status and save results never expose the key or cipher', async t => {
  const f = await fixture(t);
  const status = await f.store.save({ enabled: true, model: 'deepseek-flash', apiKey: KEY });
  assert.deepEqual(status, { enabled: true, configured: true, model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', provider: 'deepseek' });
  const raw = await fs.readFile(f.file, 'utf8'), envelope = JSON.parse(raw);
  assert.equal(raw.includes(KEY), false); assert.equal(envelope.format, credentialFormat());
  assert.deepEqual(Object.keys(envelope).sort(), ['cipher', 'format', 'version']);
  assert.ok(!JSON.stringify(status).includes(envelope.cipher)); assert.equal(Object.hasOwn(status, 'apiKey'), false);
  assert.deepEqual(await f.store.status(), status);
  assert.equal((await new AgentConfigStore(f.home, f.codec).read()).apiKey, KEY);
});

test('model updates and disabling preserve an existing key; explicit rotation replaces it', async t => {
  const f = await fixture(t);
  await f.store.save({ enabled: true, model: 'deepseek-flash', apiKey: KEY });
  await f.store.save({ enabled: false, model: 'deepseek-chat:v2.1_test' });
  assert.equal((await f.store.read()).apiKey, KEY);
  assert.deepEqual(await f.store.status(), { enabled: false, configured: true, model: 'deepseek-chat:v2.1_test', baseURL: defaults.baseURL, provider: 'deepseek' });
  await f.store.save({ enabled: true, model: 'deepseek-flash' });
  assert.equal((await f.store.read()).apiKey, KEY);
  await f.store.save({ enabled: true, model: 'deepseek-flash', apiKey: 'FAKE-rotated-agent-key' });
  assert.equal((await f.store.read()).apiKey, 'FAKE-rotated-agent-key');
});

test('disabled configuration can omit a key, but enabling without one fails closed', async t => {
  const f = await fixture(t);
  const saved = await f.store.save({ enabled: false, model: 'deepseek-flash' });
  assert.equal(saved.configured, false);
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(f.store.save({ enabled: true, model: 'deepseek-flash' }), hasCode('AGENT_CONFIG_INVALID'));
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.equal((await f.store.read()).enabled, false);
});

test('invalid fields, keys, models and endpoint/provider changes cannot overwrite configuration', async t => {
  const f = await fixture(t);
  const valid = { enabled: true, model: 'deepseek-flash', apiKey: KEY };
  await f.store.save(valid);
  const before = await fs.readFile(f.file, 'utf8');
  const invalid = [null, [], {}, { ...valid, enabled: 'true' }, { ...valid, model: '' },
    { ...valid, model: 'x'.repeat(101) }, { ...valid, model: 'deepseek/flash' }, { ...valid, model: 'model\n' },
    ...['', 'short', 'a'.repeat(513), 'has space-key', '\twhitespace-key', null, undefined].map(apiKey => ({ ...valid, apiKey })),
    { ...valid, provider: 'openai' }, { ...valid, baseURL: 'https://example.invalid' },
    { ...valid, baseURL: 'https://api.deepseek.com/v1' }, { ...valid, baseURL: 'http://api.deepseek.com' },
    { ...valid, target: 'another-user' }];
  for (const value of invalid) await assert.rejects(f.store.save(value), hasCode('AGENT_CONFIG_INVALID'));
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.equal((await f.store.read()).apiKey, KEY);
  await f.store.save({ ...valid, provider: 'deepseek', baseURL: defaults.baseURL });
  assert.equal((await f.store.status()).baseURL, defaults.baseURL);
});

test('both fixed official endpoint forms can be read and retained, never changed by save', async t => {
  const f = await fixture(t);
  for (const baseURL of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
    await writeEncrypted(f, { ...defaults, enabled: true, apiKey: KEY, baseURL });
    assert.equal((await f.store.status()).baseURL, baseURL);
    await f.store.save({ enabled: true, model: 'deepseek-chat' });
    assert.equal((await f.store.read()).baseURL, baseURL);
    const changedURL = baseURL.endsWith('/v1') ? defaults.baseURL : defaults.baseURL + '/v1';
    await assert.rejects(f.store.save({ enabled: true, model: 'deepseek-chat', baseURL: changedURL }), hasCode('AGENT_CONFIG_INVALID'));
  }
});

test('malformed ciphertext, decrypted config and decrypt errors expose only unavailable code', async t => {
  const f = await fixture(t);
  for (const raw of ['{not-json', JSON.stringify({ version: 1, format: 'plaintext', apiKey: KEY }),
    JSON.stringify({ version: 1, format: 'windows-dpapi-v1', cipher: 'UNKNOWN-CIPHER-SECRET' }),
    JSON.stringify({ version: 2, format: 'windows-dpapi-v1', cipher: 'x' })]) {
    await fs.writeFile(f.file, raw);
    await assert.rejects(f.store.read(), hasCode('AGENT_CONFIG_UNAVAILABLE'));
    await assert.rejects(f.store.status(), hasCode('AGENT_CONFIG_UNAVAILABLE'));
  }
  for (const config of [{ ...defaults, enabled: true }, { ...defaults, apiKey: 'short' },
    { ...defaults, provider: 'other' }, { ...defaults, baseURL: 'https://attacker.invalid' },
    { ...defaults, baseURL: 'https://api.deepseek.com/' }, { ...defaults, model: 'invalid/model' },
    { ...defaults, cipher: 'not-a-field' }]) {
    await writeEncrypted(f, config);
    await assert.rejects(f.store.read(), hasCode('AGENT_CONFIG_UNAVAILABLE'));
    await assert.rejects(f.store.status(), hasCode('AGENT_CONFIG_UNAVAILABLE'));
  }
  await writeEncrypted(f, { ...defaults, enabled: true, apiKey: KEY });
  const broken = new AgentConfigStore(f.home, { ...f.codec, unprotect: async () => { throw Object.assign(new Error(KEY), { code: 'ENOENT' }); } });
  await assert.rejects(broken.read(), hasCode('AGENT_CONFIG_UNAVAILABLE'));
  await assert.rejects(broken.status(), hasCode('AGENT_CONFIG_UNAVAILABLE'));
});

test('save cannot recover from unreadable configuration, missing private directory or failed protection silently', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, 'corrupted');
  await assert.rejects(f.store.save({ enabled: true, model: 'deepseek-flash', apiKey: KEY }), hasCode('AGENT_CONFIG_UNAVAILABLE'));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'corrupted');
  await fs.unlink(f.file);
  const broken = new AgentConfigStore(f.home, { ...f.codec, protect: async () => { throw new Error(KEY); } });
  await assert.rejects(broken.save({ enabled: true, model: 'deepseek-flash', apiKey: KEY }), hasCode('AGENT_CONFIG_UNAVAILABLE'));
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const uninitialized = await fixture(t, { initialized: false });
  await assert.rejects(uninitialized.store.save({ enabled: false, model: 'deepseek-flash' }), hasCode('AGENT_CONFIG_UNAVAILABLE'));
  await assert.rejects(fs.stat(path.join(uninitialized.home, '.private')), { code: 'ENOENT' });
});

test('concurrent key creation and configuration update serialize without losing the key', async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    f.store.save({ enabled: true, model: 'deepseek-flash', apiKey: KEY }),
    f.store.save({ enabled: false, model: 'deepseek-chat' }),
    f.store.status(),
  ]);
  assert.equal(results[0].enabled, true); assert.equal(results[1].enabled, false);
  assert.deepEqual(results[2], { enabled: false, configured: true, model: 'deepseek-chat', baseURL: defaults.baseURL, provider: 'deepseek' });
  assert.equal((await f.store.read()).apiKey, KEY);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['agent-config.json']);
});
