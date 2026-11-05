import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ModelRequestBudget } from '../src/chat-safety.mjs';

const key = value => createHash('sha256').update(String(value)).digest('hex');
const request = (user = 'user', scope = 'group') => ({ userKey: key(user), scopeKey: key(scope) });
async function fixture(t, { limits = {globalPerMinute:6,scopePerMinute:3,userPerMinute:2,userCooldownMs:10000,daily:120}, initialized = true, save } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-model-budget-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('qq-model-budget-test-'));
    await fs.rm(home, { recursive: true, force: true });
  });
  if (initialized) await fs.mkdir(path.join(home, '.private'), { mode: 0o700 });
  let clock = Date.parse('2026-10-29T01:00:00Z');
  const options = { now: () => clock, ...(limits ? { limits } : {}), ...(save ? { save } : {}) };
  return { home, file: path.join(home, '.private', 'model-budget.json'),
    budget: new ModelRequestBudget(home, options), restart: () => new ModelRequestBudget(home, options),
    now: () => clock, advance: ms => { clock += ms; }, setTime: time => { clock = time; } };
}

test('production defaults allow nine immediate followups but still cap user, scope and global bursts',async t=>{
  const f=await fixture(t,{limits:{}});
  for(let i=0;i<9;i++)assert.equal((await f.budget.acquire(request())).ok,true);
  assert.equal((await f.restart().acquire(request())).code,'MODEL_RATE_LIMIT_USER');
  for(let i=0;i<3;i++)assert.equal((await f.budget.acquire(request('other'+i))).ok,true);
  assert.equal((await f.budget.acquire(request('scope-blocked'))).code,'MODEL_RATE_LIMIT_SCOPE');
  for(let i=0;i<3;i++)assert.equal((await f.budget.acquire(request('third'+i,'other-scope'))).ok,true);
  assert.equal((await f.budget.acquire(request('global-blocked','third-scope'))).code,'MODEL_RATE_LIMIT_GLOBAL');
});

test('first acquisition persists only timestamp and opaque hashes before success', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.budget.acquire({ ...request(), text: 'NEVER-PERSIST-TEXT', userId: 'raw-openid' }), { ok: true, code: 'MODEL_BUDGET_ACQUIRED' });
  const raw = await fs.readFile(f.file, 'utf8'), state = JSON.parse(raw);
  assert.equal(state.version, 1); assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0], { at: f.now(), ...request() });
  assert.doesNotMatch(raw, /NEVER-PERSIST-TEXT|raw-openid/);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ['model-budget.json']);
});

test('same user has a ten-second cooldown and two calls per rolling minute across scopes and restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.budget.acquire(request())).ok, true);
  f.advance(9999);
  assert.equal((await f.restart().acquire(request('user', 'other-group'))).code, 'MODEL_RATE_LIMIT_COOLDOWN');
  f.advance(1);
  assert.equal((await f.budget.acquire(request('user', 'other-group'))).ok, true);
  f.advance(10_000);
  assert.equal((await f.budget.acquire(request('user', 'third-group'))).code, 'MODEL_RATE_LIMIT_USER');
  f.advance(40_000);
  assert.equal((await f.budget.acquire(request())).ok, true);
});

test('scope limit applies across users and the global limit applies across scopes', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) assert.equal((await f.budget.acquire(request(`a${i}`, 'one-group'))).ok, true);
  assert.equal((await f.budget.acquire(request('fourth', 'one-group'))).code, 'MODEL_RATE_LIMIT_SCOPE');
  for (let i = 0; i < 3; i++) assert.equal((await f.budget.acquire(request(`b${i}`, 'other-group'))).ok, true);
  assert.equal((await f.budget.acquire(request('seventh', 'third-group'))).code, 'MODEL_RATE_LIMIT_GLOBAL');
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).records.length, 6);
});

test('queued model calls wait for the actual ledger slot and acquire only once',async t=>{
  const f=await fixture(t);
  const start=f.now(), waits=[];
  const wait=async at=>{waits.push(at-start);f.setTime(at);return true;};
  for(let i=0;i<3;i++)assert.equal((await f.budget.acquire(request(),wait)).ok,true);
  assert.deepEqual(waits,[10000,20000,60000]);
  assert.equal((await f.budget.acquire(request(),async()=>false)).code,'MODEL_REQUEST_CANCELLED');
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).records.length,3);
});

test('concurrent acquisitions serialize and cannot overspend the global minute limit', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.budget.acquire(request(`u${i}`, `s${i}`))));
  assert.equal(results.filter(result => result.ok).length, 6);
  assert.equal(results.filter(result => result.code === 'MODEL_RATE_LIMIT_GLOBAL').length, 14);
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).records.length, 6);
});

test('all 120 daily attempts remain spent after ignored or failed model calls and restarts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 120; i++) {
    assert.equal((await f.restart().acquire(request())).ok, true);
    // There is deliberately no release operation after downstream ignore/failure.
    f.advance(61_000);
  }
  assert.equal((await f.restart().acquire(request('new-user', 'new-group'))).code, 'MODEL_RATE_LIMIT_DAY');
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).records.length, 120);
});

test('daily date resets at UTC+8 midnight while rolling-minute usage survives midnight', async t => {
  const f = await fixture(t, { limits: { daily: 1 } });
  f.setTime(Date.parse('2026-10-29T15:59:50Z'));
  assert.equal((await f.budget.acquire(request())).ok, true);
  assert.equal((await f.budget.acquire(request('other'))).code, 'MODEL_RATE_LIMIT_DAY');
  f.advance(10_000);
  assert.equal((await f.restart().acquire(request())).ok, true);
  const g = await fixture(t);
  g.setTime(Date.parse('2026-10-29T15:59:59Z'));
  for (let i = 0; i < 6; i++) assert.equal((await g.budget.acquire(request(`u${i}`, `s${i}`))).ok, true);
  g.advance(1000);
  assert.equal((await g.restart().acquire(request('fresh', 'fresh'))).code, 'MODEL_RATE_LIMIT_GLOBAL');
});

test('records exactly 48 hours old are pruned on the next persisted acquisition', async t => {
  const f = await fixture(t);
  await f.budget.acquire(request()); f.advance(48 * 3600_000);
  assert.equal((await f.restart().acquire(request())).ok, true);
  const state = JSON.parse(await fs.readFile(f.file, 'utf8'));
  assert.deepEqual(state.records, [{ at: f.now(), ...request() }]);
});

test('invalid keys and clocks fail closed without writing or echoing supplied values', async t => {
  const f = await fixture(t);
  for (const input of [null, {}, { userKey: 'raw-secret-id', scopeKey: key('scope') },
    { userKey: key('u'), scopeKey: 'f'.repeat(63) }, { userKey: 'G'.repeat(64), scopeKey: key('s') }]) {
    assert.deepEqual(await f.budget.acquire(input), { ok: false, code: 'MODEL_BUDGET_INVALID' });
  }
  for (const now of [() => NaN, () => -1, () => { throw Error('secret clock details'); }]) {
    assert.deepEqual(await new ModelRequestBudget(f.home, { now }).acquire(request()), { ok: false, code: 'MODEL_BUDGET_INVALID' });
  }
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
});

test('malformed, oversized, future or overfull persisted state is unavailable rather than reset', async t => {
  const f = await fixture(t), good = { at: f.now(), ...request() };
  const cases = ['not-json', 'x'.repeat(256 * 1024 + 1),
    JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [{ ...good, userKey: 'raw-id' }] }),
    JSON.stringify({ version: 1, records: [{ ...good, at: f.now() + 1 }] }),
    JSON.stringify({ version: 1, records: [{ ...good, text: 'do-not-echo' }] }),
    JSON.stringify({ version: 1, records: Array(1025).fill(good) })];
  for (const raw of cases) {
    await fs.writeFile(f.file, raw);
    assert.deepEqual(await f.restart().acquire(request()), { ok: false, code: 'MODEL_BUDGET_UNAVAILABLE' });
    assert.equal(await fs.readFile(f.file, 'utf8'), raw);
  }
});

test('write failure and uninitialized private directory never grant a model call', async t => {
  const f = await fixture(t, { save: async () => { throw new Error('secret storage location'); } });
  assert.deepEqual(await f.budget.acquire(request()), { ok: false, code: 'MODEL_BUDGET_UNAVAILABLE' });
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  const g = await fixture(t, { initialized: false });
  assert.deepEqual(await g.budget.acquire(request()), { ok: false, code: 'MODEL_BUDGET_UNAVAILABLE' });
  await assert.rejects(fs.stat(path.dirname(g.file)), { code: 'ENOENT' });
});
