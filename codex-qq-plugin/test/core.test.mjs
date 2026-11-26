import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCore, CORE_LIMITS } from '../src/core.mjs';

function fixture({ state = null, send, now = Date.parse('2026-10-28T01:00:00Z') } = {}) {
  const persisted = { value: state };
  const sent = [];
  const clock = { value: now };
  const deps = {
    limits: { dailyAttempts: 20, minuteAttempts: 3, reservedNotifications: 0 },
    loadState: async () => structuredClone(persisted.value),
    saveState: async (value) => { persisted.value = structuredClone(value); },
    send: async (value) => { sent.push(value); return send ? send(value) : { ok: true }; },
    now: () => clock.value,
  };
  return { core: new BridgeCore(deps), deps, persisted, sent, clock };
}

const message = (id, text, senderId = 'owner-qq-openid') => ({
  kind: 'c2c', id, senderId, text,
  replyTarget: { scope: 'c2c', targetId: senderId, msgId: id },
});

async function pair(f) {
  await f.core.init();
  const start = await f.core.startPairing();
  assert.equal(start.ok, true);
  assert.match(start.pairingCode, /^[a-f0-9]{32}$/);
  assert.equal((await f.core.handleMessage(message('pair-1', `/pair ${start.pairingCode}`))).code, 'PAIRING_PENDING');
  assert.equal((await f.core.confirmPairing()).code, 'PAIRED');
}

test('empty owner fails closed, no send, and groups never pair', async () => {
  const f = fixture();
  await f.core.init();
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'one' })).code, 'NOT_PAIRED');
  assert.equal((await f.core.setPaused(false)).code, 'NOT_PAIRED');
  const { pairingCode } = await f.core.startPairing();
  assert.equal((await f.core.handleMessage({ ...message('g1', `/pair ${pairingCode}`), kind: 'group' })).code, 'SCOPE_DENIED');
  assert.equal((await f.core.confirmPairing()).code, 'NO_PAIRING_CANDIDATE');
  assert.equal(f.sent.length, 0);
  assert.equal(f.core.status().paused, true);
});

test('the paired owner receives the help image for all three private menu aliases',async()=>{
  const f=fixture();
  await pair(f);
  for(const [i,command] of ['帮助','菜单','/help'].entries()){
    assert.equal((await f.core.handleMessage(message('menu-'+i,command))).code,'SENT');
    assert.equal(f.sent.at(-1).image.mimeType,'image/png');
    assert.equal(f.sent.at(-1).text,'私聊使用指南');
  }
});

test('upload timeout gets one text notice; uncertain submission never retries or sends a notice',async()=>{
  const image={buffer:Buffer.from([137,80,78,71,13,10,26,10]),mimeType:'image/png'};
  for(const submitted of [false,true]){
    const f=fixture({send:async request=>{if(request.image)throw {timedOut:true,messageAttempted:submitted,phase:submitted?'send':'upload'};return {ok:true};}});
    const core=new BridgeCore({...f.deps,commandHandler:async()=>({text:'',image})});f.core=core;
    await pair(f);
    const result=await core.handleMessage(message('weather','发天气北京'));
    assert.equal(f.sent.filter(r=>r.image).length,1);
    assert.equal(f.sent.length,submitted?1:2);
    assert.equal(core.status().paused,submitted);
    if(!submitted){assert.match(f.sent[1].text,/图片上传.*超时.*120秒/);assert.equal(result.timeoutNoticeSent,true);}
    else assert.equal(result.code,'DELIVERY_UNCERTAIN');
  }
});

test('pairing rejects wrong and expired codes without consuming valid code', async () => {
  const f = fixture();
  await f.core.init();
  const { pairingCode } = await f.core.startPairing();
  assert.equal((await f.core.handleMessage(message('a', `/pair ${'f'.repeat(32)}`))).code, 'PAIRING_CODE_INVALID');
  f.clock.value += CORE_LIMITS.pairingTtlMs;
  assert.equal((await f.core.handleMessage(message('b', `/pair ${pairingCode}`))).code, 'PAIRING_EXPIRED');
  assert.equal((await f.core.confirmPairing()).code, 'NO_PAIRING_CANDIDATE');
  assert.equal(f.sent.length, 0);
});

test('one-time pairing needs local confirmation and cannot replace existing owner', async () => {
  const f = fixture();
  await f.core.init();
  const start = await f.core.startPairing();
  assert.equal((await f.core.handleMessage(message('a', `/pair ${start.pairingCode}`))).code, 'PAIRING_PENDING');
  assert.equal(f.core.status().paired, false);
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'before' })).code, 'NOT_PAIRED');
  assert.equal((await f.core.handleMessage(message('b', `/pair ${start.pairingCode}`, 'attacker'))).ok, false);
  assert.equal((await f.core.confirmPairing()).code, 'PAIRED');
  assert.equal(f.persisted.value.ownerId, 'owner-qq-openid');
  assert.equal((await f.core.startPairing()).code, 'ALREADY_PAIRED');
  assert.equal((await f.core.confirmPairing()).code, 'ALREADY_PAIRED');
  assert.equal(f.sent.length, 0);
  assert.equal(JSON.stringify(f.persisted.value).includes(start.pairingCode), false);
  assert.equal(JSON.stringify(f.core.status()).includes('owner-qq-openid'), false);
});

test('confirmation expiry and restart do not preserve ephemeral pairing secrets', async () => {
  const f = fixture();
  await f.core.init();
  const { pairingCode } = await f.core.startPairing();
  await f.core.handleMessage(message('a', `/pair ${pairingCode}`));
  const restarted = new BridgeCore(f.deps);
  await restarted.init();
  assert.equal((await restarted.confirmPairing()).code, 'NO_PAIRING_CANDIDATE');
  f.clock.value += CORE_LIMITS.pairingTtlMs;
  assert.equal((await f.core.confirmPairing()).code, 'PAIRING_EXPIRED');
});

test('cancelPairing invalidates old codes and pending candidates without replacing an established owner', async () => {
  const f = fixture();
  await f.core.init();
  const first = await f.core.startPairing();
  assert.deepEqual(await f.core.cancelPairing(), { ok: true, code: 'PAIRING_CANCELLED' });
  assert.equal((await f.core.handleMessage(message('old-code', `/pair ${first.pairingCode}`))).code, 'NOT_PAIRED');
  const second = await f.core.startPairing();
  assert.equal((await f.core.handleMessage(message('candidate', `/pair ${second.pairingCode}`))).code, 'PAIRING_PENDING');
  assert.equal(f.core.status().pendingPairing, true);
  await f.core.cancelPairing();
  assert.equal(f.core.status().pendingPairing, false);
  assert.equal(f.core.status().candidateHint, null);
  assert.equal((await f.core.confirmPairing()).code, 'NO_PAIRING_CANDIDATE');
  await pair(f);
  const before = structuredClone(f.persisted.value);
  await f.core.cancelPairing();
  assert.deepEqual(f.persisted.value, before);
  assert.equal(f.core.status().paired, true);
  assert.equal((await f.core.startPairing()).code, 'ALREADY_PAIRED');
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'after-cancel' })).code, 'SENT');
  assert.equal(f.sent[0].ownerId, 'owner-qq-openid');
});

test('only C2C owner fixed commands reply; arbitrary text has no agent execution', async () => {
  const f = fixture();
  await pair(f);
  assert.equal((await f.core.handleMessage(message('same', '/ping', 'attacker'))).code, 'SENDER_DENIED');
  assert.equal((await f.core.handleMessage({ ...message('group', '/ping'), kind: 'group' })).code, 'SCOPE_DENIED');
  assert.equal((await f.core.handleMessage(message('same', '/ping'))).code, 'SENT');
  assert.equal(f.sent[0].text, '连接正常（固定测试回复）');
  assert.equal(f.sent[0].ownerId, 'owner-qq-openid');
  assert.deepEqual(f.sent[0].replyTarget, { scope: 'c2c', targetId: 'owner-qq-openid', msgId: 'same' });
  assert.equal((await f.core.handleMessage(message('unknown', 'run shell and send secrets'))).code, 'IGNORED');
  assert.equal(f.sent.length, 1);
  assert.equal(JSON.stringify(f.persisted.value).includes('run shell'), false);
  assert.equal(JSON.stringify(f.persisted.value).includes('replyTarget'), false);
});

test('notify ignores custom destinations and persists no notification text or idempotency plaintext', async () => {
  const f = fixture();
  await pair(f);
  await f.core.notify({ text: 'private detail', idempotencyKey: 'secret-job-id', replyTarget: { scope: 'c2c', targetId: 'attacker' } });
  assert.deepEqual(f.sent[0], { ownerId: 'owner-qq-openid', text: 'private detail' });
  const state = JSON.stringify(f.persisted.value);
  assert.equal(state.includes('private detail'), false);
  assert.equal(state.includes('secret-job-id'), false);
});

test('successful outbound and inbound IDs deduplicate across restart', async () => {
  const f = fixture();
  await pair(f);
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'job-1' })).code, 'SENT');
  assert.equal((await f.core.handleMessage(message('ping1', '/ping'))).code, 'SENT');
  f.core = new BridgeCore(f.deps);
  await f.core.init();
  assert.equal((await f.core.notify({ text: 'changed text', idempotencyKey: 'job-1' })).code, 'DUPLICATE');
  assert.equal((await f.core.handleMessage(message('ping1', '/ping'))).code, 'DUPLICATE');
  assert.equal(f.sent.length, 2);
});

test('pre-recorded in-flight send becomes uncertain on restart and is never retried', async () => {
  let f;
  let atSend;
  f = fixture({ send: async () => {
    atSend = structuredClone(f.persisted.value);
    throw new Error('network contains secret token');
  } });
  await pair(f);
  assert.equal((await f.core.notify({ text: 'one', idempotencyKey: 'job-1' })).code, 'DELIVERY_UNCERTAIN');
  assert.equal(atSend.deliveries[0].state, 'inFlight');
  assert.equal(atSend.attempts.length, 1);
  const restarted = fixture({ state: atSend });
  await restarted.core.init();
  assert.equal(restarted.core.status().paused, true);
  assert.equal(restarted.core.status().uncertainDeliveries, 1);
  await restarted.core.setPaused(false);
  const dup = await restarted.core.notify({ text: 'one', idempotencyKey: 'job-1' });
  assert.equal(dup.code, 'DUPLICATE');
  assert.equal(dup.deliveryState, 'uncertain');
  assert.equal(restarted.sent.length, 0);
  assert.equal(JSON.stringify(f.persisted.value).includes('secret token'), false);
});

test('concurrent sends serialize and cannot overspend the per-minute budget', async () => {
  let active = 0;
  let maxActive = 0;
  const f = fixture({ send: async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return { ok: true };
  } });
  await pair(f);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.core.notify({ text: 'test', idempotencyKey: `job-${i}` })));
  assert.equal(results.filter((item) => item.code === 'SENT').length, 3);
  assert.equal(results.filter((item) => item.code === 'RATE_LIMIT_MINUTE').length, 9);
  assert.equal(maxActive, 1);
  assert.equal(f.persisted.value.attempts.length, 3);
  f.clock.value += 60_000;
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'next-minute' })).code, 'SENT');
});

test('daily budget uses Hong Kong date and midnight resets daily budget', async () => {
  const f = fixture({ now: Date.parse('2026-10-28T15:00:00Z') });
  await pair(f);
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await f.core.notify({ text: 'test', idempotencyKey: `day-${i}` })).code, 'SENT');
    f.clock.value += 60_001;
  }
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'over-day' })).code, 'RATE_LIMIT_DAY');
  f.clock.value = Date.parse('2026-10-28T16:00:00Z');
  assert.equal(f.core.status().day, '2026-10-29');
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'next-day' })).code, 'SENT');
  assert.equal(f.core.status().dailyAttempts, 1);
});

test('Hong Kong midnight does not reset rolling minute budget', async () => {
  const f = fixture({ now: Date.parse('2026-10-28T15:59:50Z') });
  await pair(f);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await f.core.notify({ text: 'test', idempotencyKey: `near-midnight-${i}` })).code, 'SENT');
  }
  f.clock.value += 10_000;
  assert.equal(f.core.status().dailyAttempts, 0);
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'midnight' })).code, 'RATE_LIMIT_MINUTE');
  f.clock.value += 50_000;
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'minute-passed' })).code, 'SENT');
});

test('rate, permission, content and fatal errors pause and count attempts', async (t) => {
  for (const [error, code] of [
    [{ httpStatus: 429 }, 'RATE_LIMITED'],
    [{ httpStatus: 403 }, 'PERMISSION_DENIED'],
    [{ code: 'content_rejected' }, 'CONTENT_REJECTED'],
    [{ code: 'QQ_BOT_BANNED', bizCode: 4915, fatal: true }, 'FATAL_ERROR'],
    [{ fatal: true }, 'FATAL_ERROR'],
  ]) {
    await t.test(code, async () => {
      const f = fixture({ send: async () => { throw { ...error, message: 'SECRET raw error' }; } });
      await pair(f);
      assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'fail' })).code, code);
      assert.equal(f.core.status().paused, true);
      assert.equal(f.core.status().dailyAttempts, 1);
      assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'next' })).code, 'PAUSED');
      assert.equal(f.sent.length, 1);
      assert.equal(JSON.stringify(f.core.status()).includes('SECRET'), false);
      assert.equal(JSON.stringify(f.persisted.value).includes('SECRET'), false);
      assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'fail' })).code, 'DUPLICATE');
    });
  }
});

test('explicit message rejections do not disable unrelated subsequent messages or retry rejected sends',async()=>{
  for(const error of [{httpStatus:400,bizCode:40054001},{code:'QQ_REPLY_TARGET_EXPIRED'}]){
    let first=true;
    const f=fixture({send:async()=>{if(first){first=false;throw error;}return {ok:true};}});
    await pair(f);
    assert.equal((await f.core.notify({text:'first',idempotencyKey:'rejected'})).code,'PLATFORM_REJECTED');
    assert.equal(f.core.status().paused,false);
    assert.equal((await f.core.notify({text:'first',idempotencyKey:'rejected'})).code,'DUPLICATE');
    assert.equal((await f.core.notify({text:'other request',idempotencyKey:'next'})).code,'SENT');
    assert.equal(f.core.status().dailyAttempts,2);
    assert.equal(f.sent.length,2);
    const restarted=new BridgeCore(f.deps);await restarted.init();
    assert.equal(restarted.status().paused,false);
  }
});

test('known QQ service errors leave sending enabled and use the ledger to protect submitted messages',async t=>{
  for(const [error,expected,state] of [
    [{code:'QQ_SERVICE_UNAVAILABLE',httpStatus:503,messageAttempted:false},'QQ_SERVICE_UNAVAILABLE','rejected'],
    [{code:'QQ_SERVICE_UNAVAILABLE',httpStatus:503,messageAttempted:true},'DELIVERY_UNCERTAIN','uncertain'],
    [{code:'QQ_SEND_TIMEOUT',timedOut:true,messageAttempted:true},'DELIVERY_UNCERTAIN','uncertain'],
    [{code:'QQ_NOT_CONNECTED',messageAttempted:false},'NOT_CONNECTED','rejected'],
  ])await t.test(error.code+' '+state,async()=>{
    let first=true;
    const f=fixture({send:async()=>{if(first){first=false;throw error;}return {ok:true};}});
    await pair(f);
    assert.deepEqual(await f.core.notify({text:'test',idempotencyKey:'failed'}),{ok:false,code:expected,deliveryState:state});
    assert.equal(f.core.status().paused,false);
    const restored=new BridgeCore(f.deps);await restored.init();
    assert.equal(restored.status().paused,false);
    assert.equal((await restored.notify({text:'repeat',idempotencyKey:'failed'})).code,'DUPLICATE');
    assert.equal((await restored.handleMessage(message('next','/ping'))).code,'SENT');
    assert.equal(f.sent.length,2);
  });
});

test('a QQ API rate limit cools down the addressed conversation and keeps unrelated replies working',async()=>{
  const f=fixture({state:{version:1,ownerId:'owner-qq-openid',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:[{id:'g1',name:'fixture group'}],grayGroups:[]},send:async request=>{
    if(request.groupId)throw {code:'QQ_RATE_LIMITED',httpStatus:429,messageAttempted:true};
    return {ok:true};
  }});
  await f.core.init();
  const group={kind:'group',groupId:'g1',id:'group-1',senderId:'member',text:'大肥鱼 /ping',
    replyTarget:{scope:'group',targetId:'g1',msgId:'group-1'}};
  assert.equal((await f.core.handleMessage(group)).code,'RATE_LIMITED');
  assert.equal(f.core.status().paused,false);
  assert.equal((await f.core.handleMessage({...group,id:'group-2',replyTarget:{...group.replyTarget,msgId:'group-2'}})).code,'RATE_LIMITED');
  assert.equal(f.sent.length,1);
  assert.equal((await f.core.handleMessage(message('private-next','/ping'))).code,'SENT');
});

test('failed attempts still consume budgets after explicit resume and restart', async () => {
  const f = fixture({ send: async () => { throw { httpStatus: 403 }; } });
  await pair(f);
  for (let i = 0; i < 3; i += 1) {
    await f.core.setPaused(false);
    assert.equal((await f.core.notify({ text: 'test', idempotencyKey: `failure-${i}` })).code, 'PERMISSION_DENIED');
  }
  f.core = new BridgeCore(f.deps);
  await f.core.init();
  await f.core.setPaused(false);
  assert.equal((await f.core.notify({ text: 'test', idempotencyKey: 'fourth' })).code, 'RATE_LIMIT_MINUTE');
  assert.equal(f.sent.length, 3);
});

test('owner pause suppresses all replies until explicit local resume', async () => {
  const f = fixture();
  await pair(f);
  assert.equal((await f.core.handleMessage(message('pause', '/pause'))).code, 'PAUSED');
  assert.equal((await f.core.handleMessage(message('status', '/status'))).code, 'PAUSED');
  assert.equal(f.sent.length, 0);
  assert.equal((await f.core.setPaused(false)).code, 'RESUMED');
  assert.equal((await f.core.handleMessage(message('status2', '/status'))).code, 'SENT');
});

test('invalid text and missing keys do not consume budget or invoke send', async () => {
  const f = fixture();
  await pair(f);
  for (const input of [null, {}, { text: 'ok' }, { text: '', idempotencyKey: 'a' }, { text: 'a'.repeat(1501), idempotencyKey: 'a' }]) {
    assert.equal((await f.core.notify(input)).code, 'INVALID_INPUT');
  }
  assert.equal(f.sent.length, 0);
  assert.equal(f.core.status().dailyAttempts, 0);
});

test('storage failure before network cannot send, and corrupt state fails closed', async () => {
  const f = fixture();
  await pair(f);
  const restarted = new BridgeCore({ ...f.deps, saveState: async () => { throw new Error('private path'); } });
  await assert.rejects(restarted.init(), { message: 'STATE_SAVE_FAILED' });
  assert.equal((await restarted.notify({ text: 'test', idempotencyKey: 'a' })).code, 'NOT_READY');
  const corrupt = fixture({ state: { version: 1, ownerId: '*', paused: false } });
  await assert.rejects(corrupt.core.init(), { message: 'STATE_INVALID' });
  assert.equal(f.sent.length, 0);
});

test('preflight write failure blocks network invocation', async () => {
  const f = fixture();
  await pair(f);
  let failing = false;
  const guarded = new BridgeCore({
    ...f.deps,
    saveState: async (state) => {
      if (failing) throw new Error('private storage path');
      await f.deps.saveState(state);
    },
  });
  await guarded.init();
  failing = true;
  assert.equal((await guarded.notify({ text: 'test', idempotencyKey: 'blocked' })).code, 'STORAGE_ERROR');
  assert.equal(guarded.status().paused, true);
  assert.equal(f.sent.length, 0);
});

test('post-send write failure keeps persisted in-flight key and recovers uncertain after restart', async () => {
  const f = fixture();
  await pair(f);
  const guarded = new BridgeCore({
    ...f.deps,
    saveState: async (state) => {
      if (state.deliveries.some((entry) => entry.state === 'sent')) throw new Error('private storage path');
      await f.deps.saveState(state);
    },
  });
  await guarded.init();
  assert.equal((await guarded.notify({ text: 'test', idempotencyKey: 'sent-but-unrecorded' })).code, 'STORAGE_ERROR');
  assert.equal(f.sent.length, 1);
  assert.equal(f.persisted.value.deliveries[0].state, 'inFlight');
  const restarted = new BridgeCore(f.deps);
  await restarted.init();
  assert.equal((await restarted.notify({ text: 'test', idempotencyKey: 'sent-but-unrecorded' })).code, 'DUPLICATE');
  assert.equal(restarted.status().uncertainDeliveries, 1);
  assert.equal(f.sent.length, 1);
});
