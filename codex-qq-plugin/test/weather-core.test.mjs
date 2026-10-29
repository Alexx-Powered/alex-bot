import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCore, CORE_LIMITS } from '../src/core.mjs';

const OWNER = 'weather-owner-openid';
const CAPTION = '北京雷达：仅用于本次回复的私有说明';
const IMAGE_MARKER = 'private-radar-pixels-do-not-persist';
const radarImage = () => ({
  buffer: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(IMAGE_MARKER)]),
  mimeType: 'image/png',
});
const message = (id, text = '雷达 北京', senderId = OWNER) => ({
  kind: 'c2c', id, senderId, text,
  replyTarget: { scope: 'c2c', targetId: senderId, msgId: id },
});

function fixture({ commandHandler = async (command) => command === '雷达 北京'
  ? { text: '', image: radarImage() } : null, send } = {}) {
  const persisted = { value: null };
  const snapshots = [];
  const calls = [];
  const sent = [];
  const clock = { value: Date.parse('2026-10-28T01:00:00Z') };
  const deps = {
    loadState: async () => structuredClone(persisted.value),
    saveState: async (value) => {
      persisted.value = structuredClone(value);
      snapshots.push(structuredClone(value));
    },
    commandHandler: async (...args) => {
      calls.push(args);
      return commandHandler(...args);
    },
    send: async (value) => {
      sent.push(value);
      return send ? send(value) : { ok: true };
    },
    now: () => clock.value,
  };
  return { core: new BridgeCore(deps), deps, persisted, snapshots, calls, sent, clock };
}

async function pair(f) {
  await f.core.init();
  const { pairingCode } = await f.core.startPairing();
  assert.equal((await f.core.handleMessage(message('pair', `/pair ${pairingCode}`))).code, 'PAIRING_PENDING');
  assert.equal((await f.core.confirmPairing()).code, 'PAIRED');
}

test('weather handler is never invoked for an unpaired sender, nonowner, or group', async () => {
  const f = fixture();
  await f.core.init();
  assert.equal((await f.core.handleMessage(message('unpaired'))).code, 'NOT_PAIRED');
  await pair(f);
  const before = structuredClone(f.persisted.value);
  assert.equal((await f.core.handleMessage(message('intruder', '雷达 北京', 'other-openid'))).code, 'SENDER_DENIED');
  assert.equal((await f.core.handleMessage({ ...message('group'), kind: 'group' })).code, 'SCOPE_DENIED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.persisted.value, before);
});

test('paused owner requests do not invoke the weather data handler', async () => {
  const f = fixture();
  await pair(f);
  await f.core.setPaused(true);
  assert.equal((await f.core.handleMessage(message('paused'))).code, 'PAUSED');
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.core.status().dailyAttempts, 0);
  await f.core.setPaused(false);
  assert.equal((await f.core.handleMessage(message('resumed'))).code, 'SENT');
  assert.equal(f.calls.length, 1);
});

test('weather requests share the notification minute budget and stop before fetching', async () => {
  const f = fixture();
  await pair(f);
  for (let i = 0; i < CORE_LIMITS.minuteAttempts; i += 1) {
    assert.equal((await f.core.notify({ text: 'scheduled report', idempotencyKey: `minute-${i}` })).code, 'SENT');
  }
  assert.equal((await f.core.handleMessage(message('minute-blocked'))).code, 'RATE_LIMIT_MINUTE');
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, CORE_LIMITS.minuteAttempts);
  f.clock.value += 60_000;
  assert.equal((await f.core.handleMessage(message('minute-recovered'))).code, 'SENT');
  assert.equal(f.calls.length, 1);
});

test('daily notification budget also blocks weather fetching after the minute window passes', async () => {
  const f = fixture();
  await pair(f);
  for (let i = 0; i < CORE_LIMITS.dailyAttempts; i += 1) {
    assert.equal((await f.core.notify({ text: 'report', idempotencyKey: `daily-${i}` })).code, 'SENT');
    f.clock.value += 60_001;
  }
  assert.equal(f.core.status().minuteAttempts, 0);
  assert.equal((await f.core.handleMessage(message('day-blocked'))).code, 'RATE_LIMIT_REPLY_DAY');
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, CORE_LIMITS.dailyAttempts);
});

test('concurrent weather requests serialize before fetching and cannot overspend the shared budget', async () => {
  const f = fixture();
  await pair(f);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.core.handleMessage(message(`concurrent-${i}`))));
  assert.equal(results.filter((item) => item.code === 'SENT').length, CORE_LIMITS.minuteAttempts);
  assert.equal(results.filter((item) => item.code === 'RATE_LIMIT_MINUTE').length, 4 - CORE_LIMITS.minuteAttempts);
  assert.equal(results.filter((item) => item.code === 'BUSY').length, 4);
  assert.equal(f.calls.length, CORE_LIMITS.minuteAttempts);
  assert.equal(f.sent.length, CORE_LIMITS.minuteAttempts);
  assert.equal(f.core.status().dailyAttempts, CORE_LIMITS.minuteAttempts);
});

test('owner radar image is sent once with its verified reply target and remains deduplicated after restart', async () => {
  let f;
  f = fixture({ send: async () => {
    assert.equal(f.persisted.value.attempts.length, 1);
    assert.equal(f.persisted.value.deliveries[0].state, 'inFlight');
    return { ok: true };
  } });
  await pair(f);
  const request = message('private-incoming-id', '  雷达 北京  ');
  const results = await Promise.all([f.core.handleMessage(request), f.core.handleMessage(request)]);
  assert.deepEqual(results.map((item) => item.code), ['SENT', 'DUPLICATE']);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'雷达 北京');assert.match(f.calls[0][1].sessionKey,/^[a-f0-9]{64}$/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].ownerId, OWNER);
  assert.equal(f.sent[0].text, '');
  assert.deepEqual(f.sent[0].replyTarget, request.replyTarget);
  assert.deepEqual(f.sent[0].image, radarImage());
  f.core = new BridgeCore(f.deps);
  await f.core.init();
  assert.equal((await f.core.handleMessage(request)).code, 'DUPLICATE');
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.core.status().dailyAttempts, 1);
  assert.equal(f.persisted.value.deliveries[0].state, 'sent');
  for (const snapshot of f.snapshots) {
    const serialized = JSON.stringify(snapshot);
    for (const secret of [CAPTION, IMAGE_MARKER, '雷达 北京', 'private-incoming-id', 'replyTarget', 'image/png', '"buffer"', '"data"']) {
      assert.equal(serialized.includes(secret), false, `state must not persist ${secret}`);
    }
    assert.deepEqual(Object.keys(snapshot).sort(), [
      'version', 'ownerId', 'paused', 'pauseReason', 'attempts', 'deliveries', 'incoming', 'lastDeliveryCode', 'allowedGroups',
    ].sort());
  }
});

test('unknown owner command is ignored without a send or consumed budget', async () => {
  const f = fixture();
  await pair(f);
  assert.equal((await f.core.handleMessage(message('unknown', 'execute arbitrary command'))).code, 'IGNORED');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'execute arbitrary command');assert.match(f.calls[0][1].sessionKey,/^[a-f0-9]{64}$/);
  assert.equal(f.sent.length, 0);
  assert.equal(f.core.status().dailyAttempts, 0);
  assert.equal(f.persisted.value.deliveries.length, 0);
  assert.equal(JSON.stringify(f.persisted.value).includes('execute arbitrary'), false);
});

test('public text notification cannot smuggle a blank image send; internal media still shares dedup and quota', async () => {
  const f=fixture();await pair(f);
  assert.equal((await f.core.notify({text:'',image:radarImage(),idempotencyKey:'public-image'})).code,'INVALID_INPUT');
  assert.equal((await f.core.notifyImage({image:{buffer:Buffer.from('x'),mimeType:'image/png'},idempotencyKey:'bad-image'})).code,'INVALID_INPUT');
  assert.equal(f.sent.length,0);assert.equal(f.core.status().dailyAttempts,0);
  assert.equal((await f.core.notifyImage({image:radarImage(),idempotencyKey:'daily-image'})).code,'SENT');
  assert.equal(f.sent[0].text,'');assert.deepEqual(f.sent[0].image,radarImage());
  f.core=new BridgeCore(f.deps);await f.core.init();
  assert.equal((await f.core.notifyImage({image:radarImage(),idempotencyKey:'daily-image'})).code,'DUPLICATE');
  assert.equal(f.sent.length,1);assert.equal(f.core.status().dailyAttempts,1);
});

test('uncertain image send pauses further fetching, counts the attempt, and never retries the incoming ID', async () => {
  const f = fixture({ send: async () => {
    throw { code: 'QQ_SEND_FAILED', phase: 'send', messageAttempted: true, message: 'private upstream payload' };
  } });
  await pair(f);
  assert.deepEqual(await f.core.handleMessage(message('uncertain-image')), {
    ok: false, code: 'DELIVERY_UNCERTAIN', deliveryState: 'uncertain',
  });
  assert.equal(f.core.status().paused, true);
  assert.equal(f.core.status().dailyAttempts, 1);
  assert.equal(f.core.status().uncertainDeliveries, 1);
  assert.equal((await f.core.handleMessage(message('after-failure'))).code, 'PAUSED');
  f.core = new BridgeCore(f.deps);
  await f.core.init();
  await f.core.setPaused(false);
  assert.equal((await f.core.handleMessage(message('uncertain-image'))).code, 'DUPLICATE');
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(JSON.stringify(f.persisted.value).includes('private upstream'), false);
});

test('upload failure before a message attempt is rejected rather than uncertain, pauses, and retains quota', async () => {
  const f = fixture({ send: async () => {
    throw { code: 'QQ_UPLOAD_FAILED', phase: 'upload', messageAttempted: false, message: 'private upload response' };
  } });
  await pair(f);
  assert.deepEqual(await f.core.handleMessage(message('failed-upload')), {
    ok: false, code: 'PLATFORM_REJECTED', deliveryState: 'rejected',
  });
  assert.equal(f.core.status().paused, true);
  assert.equal(f.core.status().pauseReason, 'PLATFORM_REJECTED');
  assert.equal(f.core.status().dailyAttempts, 1);
  assert.equal(f.core.status().uncertainDeliveries, 0);
  assert.equal((await f.core.handleMessage(message('after-upload-failure'))).code, 'PAUSED');
  f.core = new BridgeCore(f.deps);
  await f.core.init();
  await f.core.setPaused(false);
  assert.equal((await f.core.handleMessage(message('failed-upload'))).code, 'DUPLICATE');
  assert.equal(f.core.status().dailyAttempts, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(JSON.stringify(f.persisted.value).includes('private upload'), false);
});
