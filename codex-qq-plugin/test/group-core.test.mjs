import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BridgeCore, CORE_LIMITS } from '../src/core.mjs';
import { WeatherCommands } from '../src/weather-commands.mjs';
import {parseStatusCommand} from '../src/public-status.mjs';

const OWNER = 'owner-private-openid';
const GROUP = 'group-openid-001';
const OTHER_GROUP = 'group-openid-002';
const NAME = '万通荆古帖v2.0';
const keyFor = id => createHash('sha256').update(`group:${id}`).digest('hex');
const image = { buffer: Buffer.alloc(16, 1), mimeType: 'image/png' };
const c2c = (text, id = 'private-message', senderId = OWNER) => ({ kind: 'c2c', id, senderId, text, replyTarget: { scope: 'c2c', targetId: senderId, msgId: id } });
const group = (text, id = 'group-message', groupId = GROUP, senderId = 'any-group-member') => ({ kind: 'group', groupId, id, senderId, text, replyTarget: { scope: 'group', targetId: groupId, msgId: id } });

function fixture({ initial = null, send: sendOverride, handler } = {}) {
  let state = structuredClone(initial);
  let now = Date.parse('2026-10-28T01:00:00Z');
  const sent = [], queries = [], snapshots = [];
  const core = new BridgeCore({
    loadState: async () => structuredClone(state),
    saveState: async value => { state = structuredClone(value); snapshots.push(structuredClone(value)); },
    send: async request => { sent.push(request); return sendOverride ? sendOverride(request) : { ok: true }; },
    now: () => now,
    commandHandler: async text => { queries.push(text); return handler ? handler(text) : { text: '', image }; },
  });
  return { core, sent, queries, snapshots, state: () => structuredClone(state), advance: ms => { now += ms; } };
}

async function pairOwner(f) {
  await f.core.init();
  const started = await f.core.startPairing();
  assert.equal((await f.core.handleMessage(c2c(`/pair ${started.pairingCode}`))).code, 'PAIRING_PENDING');
  assert.equal((await f.core.confirmPairing()).code, 'PAIRED');
}

async function allowGroup(f, groupId = GROUP, name = NAME) {
  const started = await f.core.startGroupPairing({ name });
  assert.equal(started.code, 'GROUP_PAIRING_STARTED');
  assert.match(started.groupPairingCode, /^[a-f0-9]{32}$/);
  const candidate = await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`, `bind-${groupId}`, groupId));
  assert.equal(candidate.code, 'GROUP_PAIRING_PENDING');
  assert.equal((await f.core.confirmGroupPairing({ groupKey: candidate.groupKey })).code, 'GROUP_ALLOWED');
  return candidate.groupKey;
}

test('prefixed compact Guangzhou command reaches actual weather router and returns one group image', async () => {
  const weatherCalls=[], airCalls=[];
  const commands=new WeatherCommands({weather:async({city})=>{weatherCalls.push(city);return {city:{id:city}};},
    air:async({city})=>{airCalls.push(city);return {city:{id:city}};},weatherChart:()=>image});
  const f=fixture({handler:text=>commands.handle(text)}); await pairOwner(f); await allowGroup(f);
  assert.equal((await f.core.handleMessage(group('小难梁 发天气广州','guangzhou'))).code,'SENT');
  assert.deepEqual(weatherCalls,['guangzhou']); assert.deepEqual(airCalls,['guangzhou']);
  assert.equal(f.sent.length,1); assert.equal(f.sent[0].text,''); assert.deepEqual(f.sent[0].image,image);
  assert.equal(f.sent[0].replyTarget.scope,'group');
  assert.equal((await f.core.handleMessage(group('发天气广州','missing-prefix'))).code,'IGNORED');
  assert.equal(f.sent.length,1);
});

test('group pairing requires ready, paired owner and enabled sending', async () => {
  const f = fixture();
  assert.equal((await f.core.startGroupPairing({ name: NAME })).code, 'NOT_READY');
  await f.core.init();
  assert.equal((await f.core.startGroupPairing({ name: NAME })).code, 'NOT_PAIRED');
  assert.equal((await f.core.handleMessage(group('/ping'))).code, 'NOT_PAIRED');
  await pairOwner(f);
  await f.core.setPaused(true);
  assert.equal((await f.core.startGroupPairing({ name: NAME })).code, 'PAUSED');
  assert.equal(f.sent.length, 0);
});

test('rich-media caption flag reaches transport once in both private and whitelisted group replies',async()=>{
  const text='实时状态\n来源：https://liang.itsuyo.top/';
  const f=fixture({handler:async()=>({text,image,richMedia:true,requiredAccess:'white'})});await pairOwner(f);await allowGroup(f);
  assert.equal((await f.core.handleMessage(c2c('查滑动变祖器状态','status-private'))).code,'SENT');
  assert.equal((await f.core.handleMessage(group('大肥鱼 查滑动变祖器状态','status-group'))).code,'SENT');
  assert.equal(f.sent.length,2);
  for(const request of f.sent){assert.equal(request.richMedia,true);assert.equal(request.text,text);assert.deepEqual(request.image,image);}
});

test('group double fish wake and official mention route nickname liveness to DeepSeek status',async()=>{
  const routed=[];
  const f=fixture({handler:async text=>{const name=parseStatusCommand(text);routed.push(name);return {text:'DeepSeek状态',image,richMedia:true,requiredAccess:'white'};}});
  await pairOwner(f);await allowGroup(f);
  assert.equal((await f.core.handleMessage(group('大肥鱼 大肥鱼还活着吗','fish-alias-health'))).code,'SENT');
  assert.equal((await f.core.handleMessage({...group('大肥鱼还活着吗','fish-at-health'),mentioned:true})).code,'SENT');
  assert.deepEqual(routed,['deepseek_service_status','deepseek_service_status']);
  assert.equal(f.sent.length,2);
  assert.ok(f.sent.every(request=>request.richMedia===true));
});

test('unknown groups neither query nor reply, including owner sender and private pairing commands', async () => {
  const f = fixture(); await pairOwner(f);
  const before = f.state();
  for (const text of ['天气 北京', '梁祖 发 天气 北京', '小难梁 帮助', '大肥鱼 你好', '梁圣 /ping', '/ping', '/status', '/pause', '/pair ' + 'a'.repeat(32), '/group-bind ' + 'b'.repeat(32)]) {
    assert.equal((await f.core.handleMessage(group(text, text, GROUP, OWNER))).code, 'GROUP_DENIED');
  }
  assert.deepEqual(f.state(), before);
  assert.equal(f.sent.length, 0); assert.equal(f.queries.length, 0);
});

test('one local group code captures one memory-only candidate and requires exact hash confirmation', async () => {
  const f = fixture(); await pairOwner(f);
  const started = await f.core.startGroupPairing({ name: NAME });
  assert.equal(started.expiresAt, Date.parse('2026-10-28T01:05:00Z'));
  const before = f.state();
  assert.equal((await f.core.handleMessage(group('/group-bind ' + '0'.repeat(32)))).code, 'GROUP_DENIED');
  const captured = await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`));
  assert.equal(captured.code, 'GROUP_PAIRING_PENDING');
  assert.equal(captured.groupKey, keyFor(GROUP));
  assert.equal((await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`, 'replace', OTHER_GROUP))).code, 'GROUP_DENIED');
  assert.equal((await f.core.confirmGroupPairing({ groupKey: keyFor(OTHER_GROUP) })).code, 'GROUP_PAIRING_KEY_MISMATCH');
  assert.deepEqual(f.state(), before);
  const status = f.core.status();
  assert.equal(status.pendingGroupPairing, true);
  assert.equal(status.pendingGroup.groupKey, keyFor(GROUP));
  assert.equal(status.pendingGroup.name, NAME);
  for (const sensitive of [GROUP, 'any-group-member', started.groupPairingCode, OWNER]) assert.ok(!JSON.stringify(status).includes(sensitive));
  assert.equal((await f.core.confirmGroupPairing({ groupKey: captured.groupKey })).code, 'GROUP_ALLOWED');
  assert.deepEqual(f.state().allowedGroups, [{ id: GROUP, name: NAME }]);
  assert.equal(f.core.status().pendingGroup, null);
  assert.equal(f.core.status().groupCount, 1);
  assert.equal(f.sent.length, 0); assert.equal(f.queries.length, 0);
});

test('code and candidate expire at five minutes, restart discards unfinished pairing', async () => {
  for (const capture of [false, true]) {
    const f = fixture(); await pairOwner(f);
    const started = await f.core.startGroupPairing({ name: NAME });
    if (capture) await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`));
    const restarted = fixture({ initial: f.state() }); await restarted.core.init();
    assert.equal(restarted.core.status().pendingGroupPairing, false);
    assert.equal((await restarted.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`))).code, 'GROUP_DENIED');
    f.advance(CORE_LIMITS.pairingTtlMs);
    assert.equal(f.core.status().pendingGroupPairing, false);
    assert.equal(f.core.status().pendingGroup, null);
    const expired = capture ? await f.core.confirmGroupPairing({ groupKey: keyFor(GROUP) }) : await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`));
    assert.equal(expired.code, 'GROUP_PAIRING_EXPIRED');
    assert.equal(f.state().allowedGroups.length, 0);
  }
});

test('pause, owner pause, disconnect cancellation and explicit group cancellation clear candidates', async () => {
  for (const cancel of [f => f.core.setPaused(true), f => f.core.cancelPairing(), f => f.core.cancelGroupPairing(), f => f.core.handleMessage(c2c('/pause'))]) {
    const f = fixture(); await pairOwner(f);
    const started = await f.core.startGroupPairing({ name: NAME });
    await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`));
    await cancel(f);
    assert.equal(f.core.status().pendingGroupPairing, false);
    assert.equal(f.core.status().pendingGroup, null);
    if (f.core.status().paused) await f.core.setPaused(false);
    assert.equal((await f.core.confirmGroupPairing({ groupKey: keyFor(GROUP) })).code, 'NO_GROUP_PAIRING_CANDIDATE');
    assert.equal((await f.core.handleMessage(group(`/group-bind ${started.groupPairingCode}`))).code, 'GROUP_DENIED');
  }
});

test('allowlisted group accepts any member with matching observed group target and only replies in that group', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f);
  const bad = group('梁祖 发 天气 北京'); bad.replyTarget.targetId = OTHER_GROUP;
  assert.equal((await f.core.handleMessage(bad)).code, 'GROUP_REPLY_TARGET_INVALID');
  assert.equal((await f.core.handleMessage({ ...group('梁祖 发 天气 北京'), replyTarget: { scope: 'c2c', targetId: OWNER, msgId: 'group-message' } })).code, 'GROUP_REPLY_TARGET_INVALID');
  assert.equal((await f.core.handleMessage({ ...group('梁祖 发 天气 北京'), replyTarget: { scope: 'group', targetId: GROUP, msgId: 'wrong' } })).code, 'GROUP_REPLY_TARGET_INVALID');
  assert.equal(f.queries.length, 0);
  assert.equal((await f.core.handleMessage(group('梁祖 发 天气 北京', 'weather', GROUP, 'another-member'))).code, 'SENT');
  assert.deepEqual(f.queries, ['发 天气 北京']);
  assert.equal(f.sent[0].groupId, GROUP); assert.equal(f.sent[0].ownerId, OWNER);
  assert.deepEqual(f.sent[0].replyTarget, { scope: 'group', targetId: GROUP, msgId: 'weather' });
  assert.ok(f.sent[0].image); assert.equal(f.state().ownerId, OWNER);
  assert.equal((await f.core.handleMessage(c2c('/ping', 'intruder', 'another-member'))).code, 'SENDER_DENIED');
});

test('group admin commands do nothing and fixed help exposes no private settings or daily automation', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f);
  const before = f.state();
  for (const command of ['/pause', '/status', '/pair abc', '/group-bind ' + 'a'.repeat(32), '/resume', '/notify']) {
    assert.equal((await f.core.handleMessage(group(`梁祖 ${command}`, command, GROUP, OWNER))).code, 'IGNORED');
  }
  assert.deepEqual(f.state(), before);
  for (const command of ['帮助', '菜单', '/help']) assert.equal((await f.core.handleMessage(group(`梁嗨 ${command}`, command))).code, 'SENT');
  assert.equal(f.queries.length, 0);
  for (const sent of f.sent) {
    assert.match(sent.text, /发 天气 城市或区县/); assert.match(sent.text, /发 雷达/); assert.match(sent.text, /雷达目录/); assert.match(sent.text, /发 雾霾 城市或区县/);
    for (const alias of ['梁圣', '梁祖', '梁嗨', '小难梁', '大肥鱼']) assert.ok(sent.text.includes(alias));
    assert.match(sent.text, /直接@机器人，无需前缀/);
    assert.ok(!/pause|status|08|每日|已配对|本人/.test(sent.text));
    assert.equal(sent.groupId, GROUP);
  }
});

test('all five leading aliases accept whitespace separators and strip exactly one prefix', async () => {
  const f = fixture({ handler: async () => null }); await pairOwner(f); await allowGroup(f);
  const inputs = [
    ['梁圣 发 天气 北京', '发 天气 北京'],
    ['  梁祖  发 雷达 华北  ', '发 雷达 华北'],
    ['梁嗨\t雷达目录 河北', '雷达目录 河北'],
    ['小难梁\u3000\n发 雾霾 北京', '发 雾霾 北京'],
    ['大肥鱼 你好呀~', '你好呀~'],
    ['大肥鱼\u3000帮我换算1马里', '帮我换算1马里'],
    ['梁祖 梁嗨 发 天气 北京', '梁嗨 发 天气 北京'],
  ];
  for (let i = 0; i < inputs.length; i++) await f.core.handleMessage(group(inputs[i][0], `alias-${i}`));
  assert.deepEqual(f.queries, inputs.map(([, command]) => command));
  assert.equal(f.state().incoming.length, inputs.length);
  assert.equal(f.sent.length, 0);
});

test('trusted mentions allow commands without an alias, preserve single-prefix stripping and stay deduplicated', async () => {
  const f=fixture({handler:async()=>null});await pairOwner(f);await allowGroup(f);
  const mentioned=(text,id)=>({...group(text,id),mentioned:true});
  await f.core.handleMessage(mentioned('今天去哪自习？','direct-at'));
  await f.core.handleMessage(mentioned('梁祖 梁嗨 你好','at-and-prefix'));
  await f.core.handleMessage(group('大肥鱼 正常前缀','prefix-only'));
  assert.deepEqual(f.queries,['今天去哪自习？','梁嗨 你好','正常前缀']);
  const before=f.state(),writes=f.snapshots.length;
  assert.equal((await f.core.handleMessage(mentioned('今天去哪自习？','direct-at'))).code,'DUPLICATE');
  for(const value of [undefined,false,'true',1,{}]){
    assert.equal((await f.core.handleMessage({...group('不带前缀的普通消息','ordinary-'+String(value)),mentioned:value})).code,'IGNORED');
  }
  assert.equal((await f.core.handleMessage(mentioned('  ','empty-at'))).code,'IGNORED');
  assert.deepEqual(f.state(),before);assert.equal(f.snapshots.length,writes);assert.equal(f.queries.length,3);
  const restarted=fixture({initial:f.state(),handler:async()=>null});await restarted.core.init();
  assert.equal((await restarted.core.handleMessage(mentioned('今天去哪自习？','direct-at'))).code,'DUPLICATE');
});

test('mentions do not bypass unknown-group, pause, private management or send limits',async()=>{
  const f=fixture();await pairOwner(f);await allowGroup(f);
  const mentioned=(text,id,groupId=GROUP)=>({...group(text,id,groupId),mentioned:true});
  assert.equal((await f.core.handleMessage(mentioned('你好','unknown',OTHER_GROUP))).code,'GROUP_DENIED');
  for(const [index,text] of ['/pause','/status','/group-bind '+ 'a'.repeat(32)].entries()){
    assert.equal((await f.core.handleMessage(mentioned(text,'control-'+index))).code,'IGNORED');
  }
  await f.core.setPaused(true);
  assert.equal((await f.core.handleMessage(mentioned('/ping','paused'))).code,'PAUSED');
  await f.core.setPaused(false);
  for(let i=0;i<3;i++)assert.equal((await f.core.handleMessage(mentioned('/ping','ping-'+i))).code,'SENT');
  assert.equal((await f.core.handleMessage(mentioned('天气 北京','over-limit'))).code,'RATE_LIMIT_MINUTE');
  assert.equal(f.queries.length,0);assert.equal(f.sent.length,3);
});

test('mentioned gray-group requests retain chat access and cannot send white-only core results',async()=>{
  const f=fixture({handler:async text=>text==='基础聊天'?{text:'鱼来啦',requiredAccess:'chat'}:{text:'核心账户结果',requiredAccess:'white',sensitive:true}});
  await pairOwner(f);const key=await allowGroup(f);
  assert.equal((await f.core.setGroupAccess({groupKey:key,access:'gray'})).code,'GROUP_ACCESS_CHANGED');
  assert.equal((await f.core.handleMessage({...group('基础聊天','gray-chat'),mentioned:true})).code,'SENT');
  assert.equal((await f.core.handleMessage({...group('查DeepSeek余额','gray-balance'),mentioned:true})).code,'GROUP_ACCESS_DENIED');
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].requiredAccess,'chat');assert.equal(f.core.groupAccess(GROUP),'gray');
});

test('unaddressed conversation, malformed aliases, bare mentions and empty commands have no side effects', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f);
  const before = f.state(), writes = f.snapshots.length;
  const ignored = [
    '发 天气 北京', '帮助', '菜单', '/help', '/ping',
    '梁圣发 天气 北京', '梁祖发 雷达 华北', '梁海 发 天气 北京', '小难梁呀 发 天气 北京',
    '请 梁祖 发 天气 北京', '天气 北京 梁圣',
    '大肥鱼你好', '请 大肥鱼 发 天气 北京', '我喜欢大肥鱼', '大肥鱼儿 你好',
    '梁圣', '梁祖 ', '梁嗨\t\n ', ' 小难梁\u3000 ', '大肥鱼', '大肥鱼 ', '', ' \n ',
    '@亚历克斯 发 雷达 华北', '@亚历克斯 梁祖 发 雷达 华北', '<@!bot> 发 天气 北京',
  ];
  for (const text of ignored) assert.equal((await f.core.handleMessage(group(text, 'reusable-id'))).code, 'IGNORED');
  assert.deepEqual(f.state(), before); assert.equal(f.snapshots.length, writes);
  assert.equal(f.queries.length, 0); assert.equal(f.sent.length, 0);
  assert.equal((await f.core.handleMessage(group('梁祖 发 天气 北京', 'reusable-id'))).code, 'SENT');
  assert.deepEqual(f.queries, ['发 天气 北京']);
  assert.equal(f.core.status().minuteAttempts, 1);
});

test('owner C2C commands retain their original text and do not require a group alias', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f);
  assert.equal((await f.core.handleMessage(c2c('发 天气 北京', 'private-weather'))).code, 'SENT');
  assert.equal((await f.core.handleMessage(c2c('梁祖 发 天气 北京', 'private-unmodified'))).code, 'SENT');
  assert.deepEqual(f.queries, ['发 天气 北京', '梁祖 发 天气 北京']);
  assert.equal((await f.core.handleMessage(c2c('/ping', 'private-ping'))).code, 'SENT');
  for (const sent of f.sent) {
    assert.equal(sent.ownerId, OWNER); assert.equal(sent.groupId, undefined);
    assert.equal(sent.replyTarget.scope, 'c2c');
  }
});

test('private notification APIs ignore smuggled group destinations and remain owner C2C', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f);
  const destinations = { groupId: GROUP, ownerId: 'attacker', target: OTHER_GROUP, replyTarget: { scope: 'group', targetId: GROUP, msgId: 'stolen' } };
  assert.equal((await f.core.notify({ text: 'Codex 本人通知', idempotencyKey: 'notify', ...destinations })).code, 'SENT');
  assert.equal((await f.core.notifyImage({ image, idempotencyKey: 'daily-weather', ...destinations })).code, 'SENT');
  for (const sent of f.sent) {
    assert.equal(sent.ownerId, OWNER);
    assert.equal(Object.hasOwn(sent, 'groupId'), false);
    assert.equal(Object.hasOwn(sent, 'replyTarget'), false);
    assert.equal(Object.hasOwn(sent, 'target'), false);
  }
});

test('deduplication scopes identical message IDs by group and C2C, persists across restart', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f); await allowGroup(f, OTHER_GROUP, '另一群');
  const messages = [group('梁圣 /ping', 'same', GROUP), group('小难梁 /ping', 'same', OTHER_GROUP), c2c('/ping', 'same')];
  for (const message of messages) assert.equal((await f.core.handleMessage(message)).code, 'SENT');
  assert.equal(f.sent.length, 3);
  const expectedPrivateKey = createHash('sha256').update('incoming:c2c:same').digest('hex');
  assert.ok(f.state().incoming.includes(expectedPrivateKey));
  const restarted = fixture({ initial: f.state() }); await restarted.core.init();
  for (const message of messages) assert.equal((await restarted.core.handleMessage(message)).code, 'DUPLICATE');
  assert.equal(restarted.sent.length, 0);
  assert.equal(restarted.core.status().groupCount, 2);
});

test('group queries and owner notifications share minute allowance and serialized sending', async () => {
  let active = 0, maxActive = 0;
  const f = fixture({ send: async () => { active++; maxActive = Math.max(active, maxActive); await Promise.resolve(); active--; return { ok: true }; } });
  await pairOwner(f); await allowGroup(f);
  const outcomes = await Promise.all([
    f.core.handleMessage(group('梁祖 发 天气 北京', 'one')),
    f.core.notify({ text: '本人通知', idempotencyKey: 'private' }),
    f.core.handleMessage(group('梁嗨 /ping', 'two')),
    f.core.handleMessage(group('小难梁 发 雷达 北京大兴', 'three')),
  ]);
  assert.deepEqual(outcomes.map(r => r.code), ['SENT', 'SENT', 'SENT', 'RATE_LIMIT_MINUTE']);
  assert.equal(maxActive, 1); assert.deepEqual(f.queries, ['发 天气 北京']);
  assert.equal(f.core.status().minuteAttempts, 3);
});

test('daily cap is shared across group replies and owner notices, before additional weather fetching', async () => {
  const f = fixture(); await pairOwner(f); await allowGroup(f);
  for (let i = 0; i < CORE_LIMITS.dailyAttempts; i++) {
    const sent = i % 2 || i >= CORE_LIMITS.dailyAttempts - CORE_LIMITS.reservedNotifications
      ? await f.core.notify({ text: '本人通知', idempotencyKey: `daily-${i}` })
      : await f.core.handleMessage(group('梁祖 /ping', `daily-${i}`));
    assert.equal(sent.code, 'SENT'); f.advance(61_000);
  }
  assert.equal((await f.core.handleMessage(group('梁祖 发 天气 北京', 'over-limit'))).code, 'RATE_LIMIT_REPLY_DAY');
  assert.equal((await f.core.notify({ text: '超额', idempotencyKey: 'over-limit' })).code, 'RATE_LIMIT_DAY');
  assert.equal(f.queries.length, 0); assert.equal(f.sent.length, CORE_LIMITS.dailyAttempts);
});

test('uncertain group delivery pauses all sending, consumes its key and cancels unfinished group pairing', async () => {
  const f = fixture({ send: async () => { throw new Error('secret network diagnostics'); } });
  await pairOwner(f); await allowGroup(f);
  await f.core.startGroupPairing({ name: '待绑定群' });
  assert.equal((await f.core.handleMessage(group('梁祖 /ping'))).code, 'DELIVERY_UNCERTAIN');
  assert.equal(f.core.status().paused, true); assert.equal(f.core.status().pendingGroupPairing, false);
  assert.equal((await f.core.notify({ text: '本人通知', idempotencyKey: 'after-failure' })).code, 'PAUSED');
  await f.core.setPaused(false);
  assert.equal((await f.core.handleMessage(group('梁祖 /ping'))).code, 'DUPLICATE');
  assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify(f.state()).includes('secret network'));
});

test('legacy state migrates empty whitelist; persisted whitelist rejects malformed, duplicate and excessive entries', async () => {
  const f = fixture(); await pairOwner(f);
  const legacy = f.state(); delete legacy.allowedGroups;
  const migrated = fixture({ initial: legacy }); await migrated.core.init();
  assert.equal(migrated.state().version, 1); assert.deepEqual(migrated.state().allowedGroups, []);
  const invalid = [null, {}, [{ id: GROUP, name: NAME }, { id: GROUP, name: '重复' }], [{ id: GROUP, name: NAME, senderId: OWNER }], [{ id: '../group', name: NAME }], [{ id: GROUP, name: 'bad\nname' }], [{ id: GROUP, name: '' }], Array.from({ length: 11 }, (_, i) => ({ id: `group-${i}`, name: `群${i}` }))];
  for (const allowedGroups of invalid) {
    const bad = fixture({ initial: { ...legacy, allowedGroups } });
    await assert.rejects(bad.core.init(), /STATE_INVALID/);
  }
});

test('whitelist removal is persisted and immediately prevents further queries; maximum is ten', async () => {
  const f = fixture(); await pairOwner(f); const key = await allowGroup(f);
  assert.equal((await f.core.removeAllowedGroup({ groupKey: GROUP })).code, 'INVALID_INPUT');
  assert.equal((await f.core.removeAllowedGroup({ groupKey: keyFor(OTHER_GROUP) })).code, 'GROUP_NOT_FOUND');
  assert.equal((await f.core.removeAllowedGroup({ groupKey: key })).code, 'GROUP_REMOVED');
  assert.equal((await f.core.handleMessage(group('梁祖 发 天气 北京'))).code, 'GROUP_DENIED');
  assert.deepEqual(f.state().allowedGroups, []);
  const full = f.state(); full.allowedGroups = Array.from({ length: 10 }, (_, i) => ({ id: `group-${i}`, name: `群${i}` }));
  const g = fixture({ initial: full }); await g.core.init();
  assert.equal((await g.core.startGroupPairing({ name: NAME })).code, 'GROUP_LIMIT_REACHED');
  assert.equal(g.core.status().groupCount, 10);
  assert.equal(f.sent.length, 0); assert.equal(f.queries.length, 0);
});
