import test from 'node:test';
import assert from 'node:assert/strict';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QQAdapter } from '../src/qq-adapter.mjs';

const APP_ID = '12345';
const OWNER = 'C2C_OWNER';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iXcAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

class FakeBot {
  handlers = new Map();
  uploads = [];
  texts = [];
  media = [];
  api = { post: async (path, body) => {
    this.uploads.push({ path, body });
    await this.beforeUpload?.();
    if (this.uploadError) throw this.uploadError;
    return { file_info: 'opaque-file-info' };
  } };
  on(name, callback) { this.handlers.set(name, callback); }
  start() { return new Promise((resolve) => { this.finish = resolve; }); }
  stop() { this.finish?.(); }
  async emit(name, ...args) { await this.handlers.get(name)?.(...args); }
  async sendText(target, text) {
    this.texts.push({ target, text });
    if (this.sendError) throw this.sendError;
    return { id: 'fake-text' };
  }
  async send(options) {
    this.media.push(options);
    if (this.sendError) throw this.sendError;
    return { id: 'fake-media' };
  }
}

function fixture(options = {}) {
  const bots = [], messages = [], statuses = [];
  const clock = { value: Date.parse('2026-10-28T10:00:00Z') };
  const adapter = new QQAdapter({
    now: () => clock.value,
    createBot: () => { const bot = new FakeBot(); bots.push(bot); return bot; },
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  return { adapter, bots, messages, statuses, clock, async connect(appId = APP_ID) {
    await adapter.connect({ appId, appSecret: 'test-only-not-real' });
    const bot = bots.at(-1);
    await bot.emit('ready');
    return bot;
  } };
}

function group(groupId = 'GROUP_A', id = 'group-message', overrides = {}) {
  return {
    kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE', groupOpenid: groupId,
    senderId: 'GROUP_MEMBER', messageId: id, timestamp: '2026-10-28T10:00:00Z',
    content: '发 雷达 北京', replyTarget: { scope: 'group', targetId: groupId, msgId: id },
    attachments: [{ url: 'https://example.invalid/private-attachment' }],
    raw: { credential: 'not-a-real-private-marker' }, ...overrides,
  };
}

const request = (message, extra = {}) => ({
  ownerId: OWNER, groupId: message.groupOpenid, text: '回复', replyTarget: message.replyTarget, ...extra,
});
const groupWireTarget = (groupId = 'GROUP_A') => ({ scope: 'group', targetId: groupId });

test('group access is checked before and after upload while gray conversion text remains deliverable', async () => {
  let tier = 'white';
  const checks = [];
  const f = fixture({ canSend: input => {
    checks.push(input);
    return input.groupId === 'GROUP_A' && (input.requiredAccess === 'chat' || tier === 'white');
  } });
  const bot = await f.connect();
  try {
    const event = group();
    await bot.emit('message', {}, event);
    bot.beforeUpload = async () => { tier = 'gray'; };
    await assert.rejects(f.adapter.send(request(event, {
      text: '', requiredAccess: 'white', image: { buffer: PNG, mimeType: 'image/png' },
    })), { code: 'QQ_SEND_CANCELLED', messageAttempted: false });
    assert.deepEqual(checks, Array.from({ length: 2 }, () => ({ groupId: 'GROUP_A', proactiveGroup: false, requiredAccess: 'white' })));
    assert.equal(bot.uploads.length, 1);
    assert.equal(bot.media.length, 0);
    await f.adapter.send(request(event, { text: '1 马里 = 3.08 公里', requiredAccess: 'chat' }));
    assert.equal(bot.texts.length, 1);
    await assert.rejects(f.adapter.send(request(event, { requiredAccess: 'white' })), { code: 'QQ_SEND_CANCELLED', messageAttempted: false });
    assert.equal(bot.texts.length, 1);
  } finally { await f.adapter.disconnect(); }
});

test('platform group @ event with already-stripped text produces only the normalized group contract', async () => {
  const f = fixture(); const bot = await f.connect();
  const event = group();
  await bot.emit('message', {}, event);
  assert.deepEqual(f.messages, [{
    kind: 'group', groupId: 'GROUP_A', id: 'group-message', senderId: 'GROUP_MEMBER',
    text: '发 雷达 北京', replyTarget: { scope: 'group', targetId: 'GROUP_A', msgId: 'group-message' },
  }]);
  assert.doesNotMatch(JSON.stringify(f.messages) + JSON.stringify(f.statuses), /private-attachment|private-marker|attachments|rawEventType/);
  assert.deepEqual(await f.adapter.send(request(event)), { ok: true });
  assert.deepEqual(bot.texts, [{ target: groupWireTarget(), text: '回复' }]);
  assert.notEqual(event.senderId, OWNER, 'group member and C2C owner IDs need not be equal');
  await f.adapter.disconnect();
});

test('only this connection AppID mention prefix is stripped; inner and other-person mentions survive', async () => {
  const f = fixture(); const bot = await f.connect();
  const cases = [
    [`  <@!${APP_ID}> 发 雷达 北京`, '发 雷达 北京'],
    [`<@${APP_ID}>发 天气 北京`, '发 天气 北京'],
    ['<@!OTHER_PERSON> 发 雷达 北京', '<@!OTHER_PERSON> 发 雷达 北京'],
    [`发 雷达 北京 <@!${APP_ID}>`, `发 雷达 北京 <@!${APP_ID}>`],
    [`<@!${APP_ID}9> 发 雷达 北京`, `<@!${APP_ID}9> 发 雷达 北京`],
    [`<@!${APP_ID}> <@!OTHER_PERSON> 发 雷达 北京`, '<@!OTHER_PERSON> 发 雷达 北京'],
  ];
  for (const [i, [content, text]] of cases.entries()) {
    await bot.emit('message', {}, group('GROUP_A', `prefix-${i}`, { content }));
    assert.equal(f.messages.at(-1).text, text);
  }
  await bot.emit('message', {}, group('GROUP_A', 'empty', { content: `<@!${APP_ID}>  ` }));
  assert.equal(f.messages.length, cases.length);
  await f.adapter.disconnect();
});

test('unknown event types, bot senders and malformed group targets grant no reply authorization', async () => {
  const f = fixture(); const bot = await f.connect();
  const rejected = [
    { rawEventType: 'UNSUPPORTED_GROUP_EVENT', content: `<@!${APP_ID}> 发 雷达 北京` },
    { rawEventType: undefined, content: `<@!${APP_ID}> 发 雷达 北京` },
    { rawEventType: 'C2C_MESSAGE_CREATE' },
    { senderIsBot: true },
    { groupOpenid: undefined },
    { groupOpenid: '../GROUP_A' },
    { replyTarget: { scope: 'c2c', targetId: 'GROUP_A', msgId: 'group-message' } },
    { replyTarget: { scope: 'group', targetId: 'OTHER_GROUP', msgId: 'group-message' } },
    { replyTarget: { scope: 'group', targetId: 'GROUP_A', msgId: 'different-message' } },
    { timestamp: '2026-10-28T09:54:00Z' },
    { timestamp: '2026-10-28T10:02:00Z' },
  ];
  for (const overrides of rejected) await bot.emit('message', {}, group('GROUP_A', 'group-message', overrides));
  assert.equal(f.messages.length, 0);
  await assert.rejects(f.adapter.send(request(group())), { code: 'QQ_REPLY_TARGET_INVALID' });
  assert.equal(bot.texts.length + bot.media.length + bot.uploads.length, 0);
  await f.adapter.disconnect();
});

test('official plain group events are accepted without mentions and text is preserved for core prefix filtering', async () => {
  const f = fixture(); const bot = await f.connect();
  const event = group('GROUP_A', 'plain-command', { rawEventType: 'GROUP_MESSAGE_CREATE', content: '梁祖 发 雷达 华北' });
  await bot.emit('message', {}, event);
  assert.deepEqual(f.messages[0], { kind: 'group', groupId: 'GROUP_A', id: 'plain-command', senderId: 'GROUP_MEMBER',
    text: '梁祖 发 雷达 华北', replyTarget: event.replyTarget });
  await f.adapter.send(request(event, { text: '回复' }));
  assert.deepEqual(bot.texts[0], { target: groupWireTarget(), text: '回复' });
  await bot.emit('message', {}, group('GROUP_A', 'literal-mention', { rawEventType: 'GROUP_MESSAGE_CREATE', content: `<@!${APP_ID}> 梁祖 发 雷达 华北` }));
  assert.equal(f.messages.at(-1).text, `<@!${APP_ID}> 梁祖 发 雷达 华北`);
  await f.adapter.disconnect();
});

test('same message ID in two groups and C2C is independently observed, deduplicated and addressed', async () => {
  const f = fixture(); const bot = await f.connect();
  const a = group('GROUP_A', 'same-id'), b = group('GROUP_B', 'same-id');
  const c = {
    kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'GROUP_A', messageId: 'same-id',
    timestamp: a.timestamp, content: '私聊', replyTarget: { scope: 'c2c', targetId: 'GROUP_A', msgId: 'same-id' },
  };
  for (const event of [a, b, c, a, b, c]) await bot.emit('message', {}, event);
  assert.equal(f.messages.length, 3);
  await f.adapter.send(request(a));
  await f.adapter.send(request(b));
  await f.adapter.send({ ownerId: c.senderId, text: '私聊回复', replyTarget: c.replyTarget });
  assert.deepEqual(bot.texts.map((item) => item.target), [groupWireTarget('GROUP_A'), groupWireTarget('GROUP_B'), c.replyTarget]);
  await assert.rejects(f.adapter.send(request(group('GROUP_C', 'same-id'))), { code: 'QQ_REPLY_TARGET_INVALID' });
  await assert.rejects(f.adapter.send({ ownerId: OWNER, text: 'x', replyTarget: { scope: 'c2c', targetId: OWNER, msgId: 'same-id' } }), { code: 'QQ_REPLY_TARGET_INVALID' });
  await f.adapter.disconnect();
});

test('independent group sends still require explicit groupId and a matching observed command target', async () => {
  const f = fixture(); const bot = await f.connect();
  const event = group();
  await bot.emit('message', {}, event);
  const invalidReplies = [
    { ownerId: OWNER, text: 'x', replyTarget: event.replyTarget },
    request(event, { replyTarget: undefined }), request(event, { replyTarget: null }),
    request(event, { replyTarget: { scope: 'group', targetId: 'GROUP_A' } }),
    request(event, { replyTarget: { ...event.replyTarget, msgId: 'not-observed' } }),
    request(event, { replyTarget: { ...event.replyTarget, scope: 'c2c' } }),
    request(event, { groupId: 'OTHER_GROUP' }),
  ];
  for (const input of invalidReplies) await assert.rejects(f.adapter.send(input), { code: 'QQ_REPLY_TARGET_INVALID' });
  for (const groupId of [null, '', '*', '../GROUP_A', 'x y', 'x'.repeat(129)]) {
    await assert.rejects(f.adapter.send(request(event, { groupId })), { code: 'QQ_GROUP_INVALID' });
  }
  assert.equal(bot.texts.length + bot.media.length + bot.uploads.length, 0);
  await f.adapter.disconnect();
});

test('expired group authorization blocks independent messages after five minutes', async () => {
  const f = fixture(); const bot = await f.connect(); const event = group();
  await bot.emit('message', {}, event);
  f.clock.value += 5 * 60_000;
  await assert.rejects(f.adapter.send(request(event)), { code: 'QQ_REPLY_TARGET_EXPIRED' });
  assert.equal(bot.texts.length + bot.media.length + bot.uploads.length, 0);
  await f.adapter.disconnect();
});

test('group image upload uses group path and fixed filename, disables auto-send, and omits message content', async (t) => {
  for (const [buffer, mimeType, fileName] of [[PNG, 'image/png', 'weather.png'], [JPEG, 'image/jpeg', 'weather.jpg']]) {
    await t.test(mimeType, async () => {
      const f = fixture(); const bot = await f.connect(); const event = group();
      await bot.emit('message', {}, event);
      assert.deepEqual(await f.adapter.send(request(event, { text: '', image: { buffer, mimeType } })), { ok: true });
      assert.deepEqual(bot.uploads, [{ path: '/v2/groups/GROUP_A/files', body: {
        file_type: 1, file_data: buffer.toString('base64'), srv_send_msg: false, file_name: fileName,
      } }]);
      assert.deepEqual(bot.media, [{ target: groupWireTarget(), msgType: 7, media: { file_info: 'opaque-file-info' } }]);
      assert.equal(bot.texts.length, 0);
      await f.adapter.disconnect();
    });
  }
});

test('bad group images never upload or send and cannot use caller-provided filenames', async () => {
  const f = fixture(); const bot = await f.connect(); const event = group();
  await bot.emit('message', {}, event);
  for (const image of [
    { buffer: Buffer.from('not-an-image'), mimeType: 'image/png' },
    { buffer: PNG, mimeType: 'image/png', file_name: '../private.png' },
    { url: 'https://example.invalid/private.png' },
  ]) await assert.rejects(f.adapter.send(request(event, { text: '', image })), { code: 'QQ_IMAGE_INVALID' });
  assert.equal(bot.texts.length + bot.media.length + bot.uploads.length, 0);
  await f.adapter.disconnect();
});

test('group upload and send failures remain distinct and neither stage retries', async (t) => {
  for (const phase of ['upload', 'send']) await t.test(phase, async () => {
    const f = fixture(); const bot = await f.connect(); const event = group();
    await bot.emit('message', {}, event);
    bot[phase === 'upload' ? 'uploadError' : 'sendError'] = new Error('private response');
    await assert.rejects(f.adapter.send(request(event, { text: '', image: { buffer: PNG, mimeType: 'image/png' } })), (error) => {
      assert.equal(error.phase, phase);
      assert.equal(error.messageAttempted, phase === 'send');
      assert.equal(error.code, phase === 'send' ? 'QQ_SEND_FAILED' : 'QQ_UPLOAD_FAILED');
      assert.doesNotMatch(error.message + JSON.stringify(error), /private response/);
      return true;
    });
    assert.equal(bot.uploads.length, 1);
    assert.equal(bot.media.length, phase === 'send' ? 1 : 0);
    assert.equal(bot.texts.length, 0);
    await f.adapter.disconnect();
  });
});

test('group authorization expiry during upload prevents the final independent message', async () => {
  const f = fixture(); const bot = await f.connect(); const event = group();
  await bot.emit('message', {}, event);
  bot.beforeUpload = () => { f.clock.value += 5 * 60_000; };
  await assert.rejects(f.adapter.send(request(event, { text: '', image: { buffer: PNG, mimeType: 'image/png' } })), {
    code: 'QQ_REPLY_TARGET_EXPIRED', phase: 'send', messageAttempted: false,
  });
  assert.equal(bot.uploads.length, 1);
  assert.equal(bot.media.length + bot.texts.length, 0);
  await f.adapter.disconnect();
});

test('connection replacement clears group authorization and blocks completion of an old upload', async () => {
  const f = fixture(); const old = await f.connect(); const event = group();
  await old.emit('message', {}, event);
  old.beforeUpload = async () => { await f.connect('67890'); };
  await assert.rejects(f.adapter.send(request(event, { text: '', image: { buffer: PNG, mimeType: 'image/png' } })), {
    code: 'QQ_CONNECTION_CHANGED', phase: 'send', messageAttempted: false,
  });
  const current = f.bots.at(-1);
  await assert.rejects(f.adapter.send(request(event)), { code: 'QQ_REPLY_TARGET_INVALID' });
  await current.emit('message', {}, group('GROUP_A', 'new-message', { content: `<@!${APP_ID}> 发 雷达 北京` }));
  assert.equal(f.messages.at(-1).text, `<@!${APP_ID}> 发 雷达 北京`, 'old AppID mention is no longer stripped');
  assert.equal(old.media.length + old.texts.length + current.media.length + current.texts.length + current.uploads.length, 0);
  await f.adapter.disconnect();
});

test('installed SDK sends group media without reply references; a 403 never retries or falls back to passive', async (t) => {
  for (const denied of [false, true]) await t.test(denied ? 'proactive permission rejected' : 'proactive accepted', async () => {
    const real = new QQBot({ appId: 'test-only', appSecret: 'test-only', logger: { info() {}, warn() {}, error() {}, debug() {} } });
    const requests = [];
    real.tokenManager.getAccessToken = async () => 'fake-token';
    real.apiClient.request = async (_token, method, path, body) => {
      requests.push({ method, path, body });
      if (path.endsWith('/files')) return { file_info: 'sdk-file-info' };
      if (denied) throw Object.assign(new Error('private permission response'), { httpStatus: 403 });
      return { id: 'fake-independent-message' };
    };
    let bot;
    const adapter = new QQAdapter({ now: () => Date.parse('2026-10-28T10:00:00Z'), createBot: () => {
      bot = new FakeBot(); bot.api = real.api; bot.send = real.send.bind(real); return bot;
    } });
    await adapter.connect({ appId: APP_ID, appSecret: 'test-only' });
    await bot.emit('ready');
    const event = group(); await bot.emit('message', {}, event);
    const sending = adapter.send(request(event, { text: '', image: { buffer: PNG, mimeType: 'image/png' },
      replyTarget: { ...event.replyTarget, eventId: 'private-event-id', message_reference: { message_id: event.messageId }, memberId: event.senderId },
    }));
    if (denied) await assert.rejects(sending, { code: 'QQ_PERMISSION_DENIED', httpStatus: 403, phase: 'send', messageAttempted: true });
    else assert.deepEqual(await sending, { ok: true });
    assert.equal(requests.length, 2, 'one upload and one independent send only, including on permission rejection');
    assert.equal(requests[0].path, '/v2/groups/GROUP_A/files');
    assert.equal(requests[0].body.file_name, 'weather.png');
    assert.equal(requests[0].body.srv_send_msg, false);
    assert.equal(requests[1].path, '/v2/groups/GROUP_A/messages');
    assert.deepEqual(Object.keys(requests[1].body).sort(), ['media', 'msg_seq', 'msg_type']);
    assert.equal(requests[1].body.msg_type, 7);
    assert.deepEqual(requests[1].body.media, { file_info: 'sdk-file-info' });
    assert.doesNotMatch(JSON.stringify(requests[1].body), /msg_id|event_id|reference|content|mentions|GROUP_MEMBER|C2C_OWNER|private-event-id|@/);
    await adapter.disconnect();
  });
});

test('installed SDK group text has no reply reference or injected mention and rejects 403 without fallback', async () => {
  const real = new QQBot({ appId: 'test-only', appSecret: 'test-only', markdownSupport: false,
    logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const requests = [];
  real.tokenManager.getAccessToken = async () => 'fake-token';
  real.apiClient.request = async (_token, method, path, body) => {
    requests.push({ method, path, body });
    throw Object.assign(new Error('private permission response'), { httpStatus: 403 });
  };
  let bot;
  const adapter = new QQAdapter({ now: () => Date.parse('2026-10-28T10:00:00Z'), createBot: () => {
    bot = new FakeBot(); bot.sendText = real.sendText.bind(real); return bot;
  } });
  await adapter.connect({ appId: APP_ID, appSecret: 'test-only' }); await bot.emit('ready');
  const event = group(); await bot.emit('message', {}, event);
  await assert.rejects(adapter.send(request(event, { text: '预报数据暂不可用。' })), {
    code: 'QQ_PERMISSION_DENIED', httpStatus: 403, phase: 'send', messageAttempted: true,
  });
  assert.deepEqual(requests, [{ method: 'POST', path: '/v2/groups/GROUP_A/messages',
    body: { content: '预报数据暂不可用。', msg_type: 0 } }]);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /msg_id|event_id|reference|mentions|GROUP_MEMBER|C2C_OWNER|@/);
  await adapter.disconnect();
});
