import test from 'node:test';
import assert from 'node:assert/strict';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QQAdapter, QQAdapterError } from '../src/qq-adapter.mjs';

class FakeQQBot {
  handlers = new Map();
  calls = [];
  uploadCalls = [];
  mediaCalls = [];
  uploadError;
  uploadResult = { file_info: 'opaque-media-reference', file_uuid: 'private-upload-id', ttl: 3600 };
  api = { post: async (path, body) => {
    this.uploadCalls.push({ path, body });
    if (this.beforeUpload) await this.beforeUpload();
    if (this.uploadError) throw this.uploadError;
    return this.uploadResult;
  } };
  starts = 0;
  stops = 0;
  sendError;
  constructor(options) { this.options = options; }
  on(name, fn) { this.handlers.set(name, fn); }
  start() {
    this.starts++;
    return new Promise((resolve, reject) => { this.finish = resolve; this.fail = reject; });
  }
  stop() { this.stops++; this.finish?.(); }
  async emit(name, ...args) { await this.handlers.get(name)?.(...args); }
  async sendText(target, text) {
    this.calls.push({ target, text });
    if (this.sendError) throw this.sendError;
    return { id: 'sdk-response', sensitiveExtra: 'must not be returned' };
  }
  async send(options) {
    this.mediaCalls.push(options);
    if (this.sendError) throw this.sendError;
    return { id: 'sdk-image-response', sensitiveExtra: 'must not be returned' };
  }
}

function fixture(options = {}) {
  const bots = [], messages = [], statuses = [];
  let now = Date.parse('2026-10-28T10:00:00Z');
  const adapter = new QQAdapter({
    createBot: (options) => { const bot = new FakeQQBot(options); bots.push(bot); return bot; },
    now: () => now,
    onMessage: (message) => messages.push(message),
    onStatus: (status) => statuses.push(status),
    ...options,
  });
  return { adapter, bots, messages, statuses, advance(ms) { now += ms; }, async connect() {
    await adapter.connect({ appId: '123', appSecret: 'private-secret' });
    const bot = bots.at(-1);
    await bot.emit('ready', { token: 'private-ready-payload' });
    return bot;
  } };
}

function inbound(overrides = {}) {
  return {
    kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'OWNER_OPENID',
    messageId: 'msg-1', timestamp: '2026-10-28T10:00:00Z', content: 'hello',
    replyTarget: { scope: 'c2c', targetId: 'OWNER_OPENID', msgId: 'msg-1' },
    attachments: [{ url: 'https://example.invalid/private-media' }],
    ...overrides,
  };
}

test('connect returns while SDK lifecycle stays pending; no message is sent automatically', async () => {
  const f = fixture();
  const result = await f.adapter.connect({ appId: '123', appSecret: 'private-secret' });
  assert.equal(result.state, 'connecting');
  const bot = f.bots[0];
  assert.equal(bot.starts, 1);
  assert.deepEqual(bot.calls, []);
  assert.equal(bot.options.baseUrl, 'https://api.bot.qq.com');
  assert.equal(bot.options.tokenBaseUrl, 'https://api.bot.qq.com');
  assert.equal(bot.options.transport, 'websocket');
  assert.equal(bot.options.markdownSupport, false);
  assert.ok(Number.isInteger(bot.options.reconnect.maxAttempts) && bot.options.reconnect.maxAttempts <= 3);
  assert.equal(bot.options.intents, 1 << 25);
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x' }), { code: 'QQ_NOT_CONNECTED' });
  await bot.emit('ready', { appSecret: 'never-emit-this' });
  assert.deepEqual(f.adapter.status(), { state: 'connected', code: null });
  assert.doesNotMatch(JSON.stringify(f.statuses), /private|never-emit/);
  await f.adapter.disconnect();
});

test('normalizes fresh c2c text only, filters every other scope and drops duplicate events', async () => {
  const f = fixture(); const bot = await f.connect();
  for (const kind of ['group', 'guild', 'dm']) await bot.emit('message', {}, inbound({ kind }));
  await bot.emit('message', {}, inbound({ senderIsBot: true }));
  await bot.emit('message', {}, inbound({ replyTarget: { scope: 'c2c', targetId: 'OTHER', msgId: 'msg-1' } }));
  await bot.emit('message', {}, inbound());
  await bot.emit('message', {}, inbound());
  assert.deepEqual(f.messages, [{ kind: 'c2c', id: 'msg-1', senderId: 'OWNER_OPENID', text: 'hello', replyTarget: { scope: 'c2c', targetId: 'OWNER_OPENID', msgId: 'msg-1' } }]);
  assert.deepEqual(bot.calls, []);
  await f.adapter.disconnect();
});

test('old, malformed or future platform timestamps cannot create reply authorization', async () => {
  const f = fixture(); const bot = await f.connect();
  for (const timestamp of [undefined, 'not-a-time', '2026-10-28T09:54:00Z', '2026-10-28T10:02:00Z']) {
    await bot.emit('message', {}, inbound({ timestamp }));
  }
  assert.equal(f.messages.length, 0);
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', replyTarget: inbound().replyTarget }), { code: 'QQ_REPLY_TARGET_INVALID' });
  assert.equal(bot.calls.length, 0);
  await f.adapter.disconnect();
});

test('proactive sends use the fixed owner destination and return no raw SDK payload', async () => {
  const f = fixture(); const bot = await f.connect();
  assert.deepEqual(await f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'report' }), { ok: true });
  assert.deepEqual(bot.calls, [{ target: { scope: 'c2c', targetId: 'OWNER_OPENID' }, text: 'report' }]);
  await f.adapter.disconnect();
});

test('reply target must be observed, fresh, c2c and belong to the same owner', async () => {
  const f = fixture(); const bot = await f.connect();
  await bot.emit('message', {}, inbound());
  const target = f.messages[0].replyTarget;
  await f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'reply', replyTarget: { ...target, extra: 'discard' } });
  assert.deepEqual(bot.calls[0].target, target);
  for (const replyTarget of [{ ...target, scope: 'group' }, { ...target, targetId: 'OTHER' }, { ...target, msgId: 'unseen' }, {}]) {
    await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', replyTarget }), { code: 'QQ_REPLY_TARGET_INVALID' });
  }
  f.advance(5 * 60 * 1000);
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', replyTarget: target }), { code: 'QQ_REPLY_TARGET_EXPIRED' });
  assert.equal(bot.calls.length, 1, 'invalid replies must not silently turn into proactive sends');
  await f.adapter.disconnect();
});

test('invalid destinations and empty or excessive text never reach SDK', async () => {
  const f = fixture(); const bot = await f.connect();
  for (const ownerId of ['', '*', '../other', 'x y', null, 'x'.repeat(129)]) {
    await assert.rejects(f.adapter.send({ ownerId, text: 'x' }), { code: 'QQ_OWNER_INVALID' });
  }
  for (const text of ['', '  ', null, 'x'.repeat(4001)]) {
    await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text }), { code: 'QQ_TEXT_INVALID' });
  }
  assert.equal(bot.calls.length, 0);
  assert.equal(bot.uploadCalls.length, 0);
  assert.equal(bot.mediaCalls.length, 0);
  await f.adapter.disconnect();
});

test('API failures expose numeric classification only and are never retried', async () => {
  const f = fixture(); const bot = await f.connect();
  bot.sendError = Object.assign(new Error('secret-token and private QQ text'), { httpStatus: 403, bizCode: 40034105, path: '/private-user-id' });
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'report' }), (error) => {
    assert.ok(error instanceof QQAdapterError);
    assert.equal(error.code, 'QQ_PERMISSION_DENIED');
    assert.equal(error.httpStatus, 403);
    assert.equal(error.bizCode, 40034105);
    assert.equal(error.cause, undefined);
    assert.equal(error.path, undefined);
    assert.doesNotMatch(error.message + JSON.stringify(error), /secret-token|private QQ|private-user/);
    return true;
  });
  assert.equal(bot.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.statuses), /secret-token|private QQ/);
  const diagnostic=f.adapter.diagnostics().lastSend;
  assert.equal(diagnostic.httpStatus,403);assert.equal(diagnostic.bizCode,40034105);
  assert.equal(diagnostic.phase,'send');assert.equal(diagnostic.scope,'c2c');
  assert.doesNotMatch(JSON.stringify(diagnostic),/secret-token|private QQ|private-user|OWNER_OPENID/);
  await f.adapter.disconnect();
});

test('structured API rate-limit errors are recognized without inspecting sensitive message text', async () => {
  const f = fixture(); const bot = await f.connect();
  bot.sendError = Object.assign(new Error('opaque'), { httpStatus: 429, bizCode: 50002 });
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x' }), { code: 'QQ_RATE_LIMITED', kind: 'rate_limited' });
  assert.equal(bot.calls.length, 1);
  await f.adapter.disconnect();
});

test('fatal ban remains blocked despite later errors or ready events; no reconnect is scheduled by adapter', async () => {
  const f = fixture(); const bot = await f.connect();
  await bot.emit('disconnected', { code: 4915, reason: 'private gateway diagnostic', willReconnect: false });
  await bot.emit('error', new Error('another secret'));
  await bot.emit('ready', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.adapter.status(), { state: 'blocked', code: 'QQ_BOT_BANNED' });
  assert.equal(bot.starts, 1);
  assert.equal(bot.stops, 1);
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x' }), { code: 'QQ_NOT_CONNECTED' });
  assert.doesNotMatch(JSON.stringify(f.statuses), /private gateway|secret/);
  await f.adapter.disconnect();
});

test('bounded SDK reconnect exhaustion becomes a terminal state', async () => {
  const f = fixture(); const bot = await f.connect();
  bot.fail(Object.assign(new Error('raw forbidden diagnostic'), { code: 'GATEWAY_RETRY_EXHAUSTED' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.adapter.status(), { state: 'blocked', code: 'QQ_RECONNECT_EXHAUSTED' });
  assert.equal(bot.starts, 1);
  await f.adapter.disconnect();
});

test('old connections cannot deliver messages or overwrite the new connection status', async () => {
  const f = fixture(); const old = await f.connect();
  const current = await f.connect();
  await old.emit('disconnected', { code: 4915, willReconnect: false });
  await old.emit('message', {}, inbound());
  await old.emit('ready', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.adapter.status().state, 'connected');
  assert.equal(f.messages.length, 0);
  await current.emit('message', {}, inbound());
  assert.equal(f.messages.length, 1);
  await f.adapter.disconnect();
  await current.emit('ready', {});
  assert.deepEqual(f.adapter.status(), { state: 'disconnected', code: null });
});

test('connection failure cannot leak raw error data through status or returned errors', async () => {
  const statuses = [];
  const adapter = new QQAdapter({ createBot() { throw new Error('AppSecret=private'); }, onStatus: (s) => statuses.push(s) });
  await assert.rejects(adapter.connect({ appId: '123', appSecret: 'private' }), { code: 'QQ_CONNECT_FAILED', message: 'QQ_CONNECT_FAILED' });
  assert.deepEqual(adapter.status(), { state: 'error', code: 'QQ_CONNECT_FAILED' });
  assert.doesNotMatch(JSON.stringify(statuses), /AppSecret|private/);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iXcAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

test('empty-text image sends upload once, then send one owner-scoped media message without content', async () => {
  const f = fixture(); const bot = await f.connect();
  await bot.emit('message', {}, inbound());
  const replyTarget = f.messages[0].replyTarget;
  const response = await f.adapter.send({ ownerId: 'OWNER_OPENID', text: '', replyTarget, image: { buffer: PNG, mimeType: 'image/png' } });
  assert.deepEqual(response, { ok: true });
  assert.deepEqual(bot.uploadCalls, [{ path: '/v2/users/OWNER_OPENID/files', body: { file_type: 1, file_data: PNG.toString('base64'), srv_send_msg: false } }]);
  assert.deepEqual(bot.mediaCalls, [{ target: replyTarget, msgType: 7, media: { file_info: 'opaque-media-reference' } }]);
  assert.equal(bot.calls.length, 0, 'image replies must not send an extra text message');
  assert.doesNotMatch(JSON.stringify(response) + JSON.stringify(f.statuses), /opaque-media-reference|private-upload-id|iVBOR/);
  await f.adapter.disconnect();
});

test('JPEG proactive images omit a supplied caption and still address only the fixed C2C owner', async () => {
  const f = fixture(); const bot = await f.connect();
  await f.adapter.send({ ownerId: 'OWNER_OPENID', text: '曲线图', image: { buffer: JPEG, mimeType: 'image/jpeg' } });
  assert.equal(bot.uploadCalls[0].path, '/v2/users/OWNER_OPENID/files');
  assert.deepEqual(bot.mediaCalls, [{ target: { scope: 'c2c', targetId: 'OWNER_OPENID' }, msgType: 7, media: { file_info: 'opaque-media-reference' } }]);
  assert.equal(bot.uploadCalls[0].body.file_data, JPEG.toString('base64'));
  assert.equal(bot.calls.length, 0);
  await f.adapter.disconnect();
});

test('opt-in rich media sends caption and uploaded image in one C2C or group message',async()=>{
  for(const group of [false,true]){
    const f=fixture();const bot=await f.connect();
    const message=group?inbound({kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',groupOpenid:'GROUP',replyTarget:{scope:'group',targetId:'GROUP',msgId:'msg-1'}}):inbound();
    await bot.emit('message',{},message);
    const text='滑动变祖器：梁圣\n来源：https://liang.itsuyo.top/';
    await f.adapter.send({ownerId:'OWNER_OPENID',text,richMedia:true,image:{buffer:PNG,mimeType:'image/png'},replyTarget:f.messages[0].replyTarget,...(group?{groupId:'GROUP'}:{})});
    assert.equal(bot.uploadCalls.length,1);assert.equal(bot.uploadCalls[0].body.srv_send_msg,false);
    assert.equal(bot.mediaCalls.length,1);assert.equal(bot.calls.length,0);
    assert.equal(bot.mediaCalls[0].content,text);assert.equal(bot.mediaCalls[0].msgType,7);
    await f.adapter.disconnect();
  }
});

test('URL, paths, base64 strings, wrong MIME and invalid magic are rejected before upload', async () => {
  const f = fixture(); const bot = await f.connect();
  for (const image of [
    null, 'https://example.invalid/image.png', { url: 'https://example.invalid/image.png' },
    { localPath: 'C:/private.png' }, { buffer: PNG.toString('base64'), mimeType: 'image/png' },
    { buffer: new Uint8Array(PNG), mimeType: 'image/png' },
    { buffer: PNG, mimeType: 'image/png', url: 'https://example.invalid/image.png' },
    { buffer: PNG, mimeType: 'image/png', localPath: 'C:/private.png' },
    { buffer: PNG, mimeType: 'image/svg+xml' }, { buffer: PNG, mimeType: 'image/jpeg' },
    { buffer: JPEG, mimeType: 'image/png' }, { buffer: Buffer.from('not-an-image'), mimeType: 'image/png' },
    { buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00]), mimeType: 'image/jpeg' },
  ]) {
    await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: '', image }), { code: 'QQ_IMAGE_INVALID' });
  }
  assert.equal(bot.uploadCalls.length, 0);
  assert.equal(bot.mediaCalls.length, 0);
  assert.equal(bot.calls.length, 0);
  await f.adapter.disconnect();
});

test('5 MiB bound is enforced without SDK automatic chunking', async () => {
  const f = fixture(); const bot = await f.connect();
  const atLimit = Buffer.alloc(5 * 1024 * 1024); PNG.copy(atLimit);
  await f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: atLimit, mimeType: 'image/png' } });
  assert.equal(bot.uploadCalls.length, 1);
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: 'image/png' } }), { code: 'QQ_IMAGE_TOO_LARGE' });
  assert.equal(bot.uploadCalls.length, 1);
  await f.adapter.disconnect();
});

test('invalid image reply destination is rejected before uploading anything', async () => {
  const f = fixture(); const bot = await f.connect();
  await bot.emit('message', {}, inbound());
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: PNG, mimeType: 'image/png' }, replyTarget: { ...f.messages[0].replyTarget, targetId: 'OTHER' } }), { code: 'QQ_REPLY_TARGET_INVALID' });
  assert.equal(bot.uploadCalls.length, 0);
  await f.adapter.disconnect();
});

test('image upload rejection or timeout never sends a message or retries the upload', async (t) => {
  for (const [error, code] of [
    [Object.assign(new Error('private raw upload error'), { httpStatus: 403 }), 'QQ_PERMISSION_DENIED'],
    [Object.assign(new Error('private raw upload error'), { httpStatus: 429 }), 'QQ_RATE_LIMITED'],
    [Object.assign(new Error('private raw upload timeout'), { httpStatus: 0 }), 'QQ_UPLOAD_FAILED'],
  ]) {
    await t.test(code, async () => {
      const f = fixture(); const bot = await f.connect();
      bot.uploadError = error;
      await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: PNG, mimeType: 'image/png' } }), (failure) => {
        assert.equal(failure.code, code);
        assert.equal(failure.phase, 'upload');
        assert.equal(failure.messageAttempted, false);
        assert.doesNotMatch(failure.message + JSON.stringify(failure), /private raw/);
        return true;
      });
      assert.equal(bot.uploadCalls.length, 1);
      assert.equal(bot.mediaCalls.length, 0);
      assert.equal(bot.calls.length, 0);
      await f.adapter.disconnect();
    });
  }
});

test('upload success is not message success; a failed media send is not retried', async () => {
  const f = fixture(); const bot = await f.connect();
  bot.sendError = new Error('network lost after send with private reference');
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: PNG, mimeType: 'image/png' } }), (failure) => {
    assert.equal(failure.code, 'QQ_SEND_FAILED');
    assert.equal(failure.phase, 'send');
    assert.equal(failure.messageAttempted, true);
    assert.doesNotMatch(failure.message + JSON.stringify(failure), /private reference/);
    return true;
  });
  assert.equal(bot.uploadCalls.length, 1);
  assert.equal(bot.mediaCalls.length, 1);
  await f.adapter.disconnect();
});

test('malformed upload response cannot produce a media message', async () => {
  const f = fixture(); const bot = await f.connect();
  bot.uploadResult = { file_info: '', secret: 'private-upload-response' };
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: PNG, mimeType: 'image/png' } }), { code: 'QQ_UPLOAD_RESPONSE_INVALID', phase: 'upload', messageAttempted: false });
  assert.equal(bot.mediaCalls.length, 0);
  await f.adapter.disconnect();
});

test('a local pause during upload cancels the final media send without retrying', async () => {
  let enabled = true;
  const f = fixture({canSend:()=>enabled});
  const bot = await f.connect();
  try {
    bot.beforeUpload = async()=>{enabled=false;};
    await assert.rejects(f.adapter.send({ownerId:'OWNER_OPENID',text:'',image:{buffer:PNG,mimeType:'image/png'}}),
      {code:'QQ_SEND_CANCELLED',phase:'send',messageAttempted:false});
    assert.equal(bot.uploadCalls.length,1);
    assert.equal(bot.mediaCalls.length,0);
    assert.equal(bot.calls.length,0);
    await assert.rejects(f.adapter.send({ownerId:'OWNER_OPENID',text:'paused'}),
      {code:'QQ_SEND_CANCELLED',messageAttempted:false});
    assert.equal(bot.calls.length,0);
  } finally { await f.adapter.disconnect(); }
});

test('reply expiry during upload stops before media send and never falls back to proactive', async () => {
  const f = fixture(); const bot = await f.connect();
  await bot.emit('message', {}, inbound());
  bot.beforeUpload = async () => f.advance(5 * 60 * 1000);
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: PNG, mimeType: 'image/png' }, replyTarget: f.messages[0].replyTarget }), { code: 'QQ_REPLY_TARGET_EXPIRED', phase: 'send', messageAttempted: false });
  assert.equal(bot.uploadCalls.length, 1);
  assert.equal(bot.mediaCalls.length, 0);
  await f.adapter.disconnect();
});

test('connection replacement during upload cannot send using either old or new App identity', async () => {
  const f = fixture(); const old = await f.connect();
  old.beforeUpload = async () => { await f.connect(); };
  await assert.rejects(f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: PNG, mimeType: 'image/png' } }), { code: 'QQ_CONNECTION_CHANGED', phase: 'send', messageAttempted: false });
  assert.equal(old.uploadCalls.length, 1);
  assert.equal(old.mediaCalls.length, 0);
  assert.equal(f.bots.at(-1).mediaCalls.length, 0);
  assert.deepEqual(f.adapter.status(), { state: 'connected', code: null });
  await f.adapter.disconnect();
});

test('validated image bytes are fixed before asynchronous upload begins', async () => {
  const f = fixture(); const bot = await f.connect();
  const mutable = Buffer.from(PNG);
  bot.beforeUpload = async () => { mutable.fill(0); };
  await f.adapter.send({ ownerId: 'OWNER_OPENID', text: 'x', image: { buffer: mutable, mimeType: 'image/png' } });
  assert.equal(bot.uploadCalls[0].body.file_data, PNG.toString('base64'));
  await f.adapter.disconnect();
});

test('installed SDK sends empty-text images with no content field and one request per phase without retries', async () => {
  // No SDK start() or actual network: exercise its real public REST call chain
  // with token and HTTP primitives replaced by deterministic in-memory fakes.
  const realSdk = new QQBot({ appId: 'test-only', appSecret: 'test-only', logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const requests = [];
  realSdk.tokenManager.getAccessToken = async () => 'fake-token';
  realSdk.apiClient.request = async (_token, method, path, body) => {
    requests.push({ method, path, body });
    if (path.endsWith('/files')) return { file_info: 'sdk-file-info' };
    throw Object.assign(new Error('simulated no-response'), { httpStatus: 0 });
  };
  let fake;
  const adapter = new QQAdapter({ createBot: (options) => {
    fake = new FakeQQBot(options);
    fake.api = realSdk.api;
    fake.send = realSdk.send.bind(realSdk);
    return fake;
  } });
  await adapter.connect({ appId: 'test-only', appSecret: 'test-only' });
  await fake.emit('ready');
  await assert.rejects(adapter.send({ ownerId: 'OWNER_OPENID', text: '', image: { buffer: PNG, mimeType: 'image/png' } }), { code: 'QQ_SEND_FAILED', phase: 'send', messageAttempted: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].path, '/v2/users/OWNER_OPENID/files');
  assert.equal(requests[0].body.srv_send_msg, false);
  assert.equal(requests[1].path, '/v2/users/OWNER_OPENID/messages');
  assert.equal(requests[1].body.msg_type, 7);
  assert.deepEqual(requests[1].body.media, { file_info: 'sdk-file-info' });
  assert.equal(Object.hasOwn(requests[1].body, 'content'), false);
  assert.equal(JSON.stringify(requests[1].body).includes('"content"'), false);
  await adapter.disconnect();
});

test('installed Tencent SDK serializes rich media content together with file_info in one messages request',async()=>{
  const sdk=new QQBot({appId:'offline',appSecret:'offline',logger:{info(){},warn(){},error(){},debug(){}}});
  sdk.tokenManager.getAccessToken=async()=>'offline-token';
  const requests=[];sdk.apiClient.request=async(_token,method,url,body)=>{
    requests.push({method,url,body});return url.endsWith('/files')?{file_info:'offline-file'}:{id:'offline-message'};
  };
  let bot;const adapter=new QQAdapter({createBot:options=>{
    bot=new FakeQQBot(options);bot.api=sdk.api;bot.send=sdk.send.bind(sdk);return bot;
  }});
  try{
    await adapter.connect({appId:'offline',appSecret:'offline'});await bot.emit('ready');
    const caption='实时状态\n来源：https://liang.itsuyo.top/';
    await adapter.send({ownerId:'OWNER_OPENID',text:caption,richMedia:true,image:{buffer:PNG,mimeType:'image/png'}});
    assert.equal(requests.length,2);assert.equal(requests[0].body.srv_send_msg,false);
    assert.deepEqual(requests[1].body,{msg_type:7,content:caption,media:{file_info:'offline-file'},msg_seq:1});
  }finally{await adapter.disconnect();}
});
