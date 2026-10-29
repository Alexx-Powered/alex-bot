import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridgeClient, projectWeatherError, projectNotify } from '../src/bridge-client.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parseResult = (result) => JSON.parse(result.content.find((item) => item.type === 'text').text);

test('weather error projection retains only fixed codes and safe bounded location choices', () => {
  const safe=Array.from({length:10},(_,i)=>`地点${i}（qweather-AB${i}）`);
  const payload={ok:false,code:'LOCATION_AMBIGUOUS',message:'BACKEND_SECRET',appSecret:'BACKEND_SECRET',
    suggestions:[null,{},'https://secret.invalid','bad\nsecret','x'.repeat(61),' padded',...safe]};
  const result=projectWeatherError(payload);
  assert.deepEqual(result,{ok:false,code:'LOCATION_AMBIGUOUS',suggestions:safe.slice(0,8)});
  assert.doesNotMatch(JSON.stringify(result),/BACKEND_SECRET|appSecret|https:|secret/);
  for(const code of ['LOCATION_NOT_FOUND','LOCATION_INPUT_INVALID','LOCATION_SOURCE_UNAVAILABLE','DAILY_CITY_RESTRICTED']) {
    assert.deepEqual(projectWeatherError({...payload,code}),{ok:false,code});
  }
  assert.equal(projectWeatherError({...payload,code:'ARBITRARY_BACKEND_CODE'}),null);
  assert.equal(projectWeatherError({...payload,ok:true}),null);
  assert.deepEqual(projectNotify({...payload,code:'ARBITRARY_BACKEND_CODE'}),{ok:false,code:'UNKNOWN'});
});

test('MCP stdio communicates only through the authenticated local owner bridge', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'alex-qq-mcp-'));
  await mkdir(join(home, '.private'));
  const tokenPath = join(home, '.private', 'admin-token');
  let expectedToken = 'a'.repeat(64);
  await writeFile(tokenPath, expectedToken);
  const requests = [];
  let mode = 'normal';
  const seen = new Set();
  const mock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (req.headers.authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401).end('secret-server-error-do-not-echo');
      return;
    }
    if (mode === 'timeout') return;
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://example.invalid/leak' }).end(); return; }
    if (mode === 'error') { res.writeHead(500).end('secret-server-error-do-not-echo'); return; }
    if (mode === 'oversize') { res.writeHead(200).end('x'.repeat(70_000)); return; }
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'location-ambiguity' && req.url.startsWith('/api/weather/')) {
      res.end(JSON.stringify({ok:false,code:'LOCATION_AMBIGUOUS',message:'BACKEND_SECRET',credentials:'BACKEND_SECRET',
        suggestions:['北京市·朝阳（qweather-101010300）','https://secret.invalid','bad\nsecret','辽宁省·朝阳市（qweather-101071201）']}));
      return;
    }
    if (mode === 'daily-city-restricted' && req.url === '/api/weather/briefing') {
      res.end(JSON.stringify({ok:false,code:'DAILY_CITY_RESTRICTED',message:'BACKEND_SECRET',suggestions:['do not copy']}));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      res.end(JSON.stringify({
        ok: true, version: '0.1.0', configured: true, appSecret: 'SECRET_FROM_STATUS',
        transport: { state: 'connected', code: 'OK', token: expectedToken },
        core: { paired: true, pendingPairing: false, paused: false, dailyAttempts: 1, minuteAttempts: 1, ownerHint: 'DO_NOT_EXPOSE_ID', credentials: { secret: 'SECRET_FROM_STATUS' } },
      }));
    } else if (req.method === 'POST' && req.url === '/api/weather/preview') {
      res.end(JSON.stringify({ok:true,text:'本地模拟天气图状态，不联网、不发送QQ。',date:'2026-10-28'}));
    } else if (req.method === 'POST' && req.url === '/api/notify') {
      const body = JSON.parse(raw);
      const duplicate = seen.has(body.idempotencyKey);
      seen.add(body.idempotencyKey);
      res.end(JSON.stringify({ ok: !duplicate, code: duplicate ? 'DUPLICATE' : 'SENT', ...(duplicate ? { deliveryState: 'sent' } : {}), appSecret: 'SECRET_FROM_NOTIFY' }));
    } else res.writeHead(404).end('{}');
  });
  let client;
  t.after(async () => {
    if (client) await client.close();
    mock.closeAllConnections();
    if (mock.listening) await new Promise((done) => mock.close(done));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((done, reject) => { mock.once('error', reject); mock.listen(19327, '127.0.0.1', done); });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, 'src', 'mcp.mjs')],
    cwd: projectRoot,
    env: { QQ_BRIDGE_HOME: home },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  client = new Client({ name: 'qq-mcp-test', version: '0.1.0' });
  await client.connect(transport);

  await t.test('tools declare one read and one owner-only send with no destination', async () => {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['qq_broadcast', 'qq_morning_test', 'qq_notify', 'qq_status', 'qq_weather_briefing', 'qq_weather_preview']);
    const notify = listed.tools.find((tool) => tool.name === 'qq_notify');
    assert.deepEqual(Object.keys(notify.inputSchema.properties).sort(), ['idempotencyKey', 'text']);
    assert.equal(notify.inputSchema.additionalProperties, false);
    assert.equal(notify.annotations.readOnlyHint, false);
    assert.equal(listed.tools.find((tool) => tool.name === 'qq_status').annotations.readOnlyHint, true);
  });

  await t.test('status is read only and strips credentials and identity hints', async () => {
    const result = await client.callTool({ name: 'qq_status', arguments: {} });
    assert.equal(result.isError, false);
    assert.equal(parseResult(result).core.paired, true);
    const serialized = JSON.stringify(result);
    assert.doesNotMatch(serialized, /SECRET_FROM_STATUS|DO_NOT_EXPOSE_ID|credentials|appSecret/);
    assert.ok(!serialized.includes(expectedToken));
    assert.equal(requests.at(-1).method, 'GET');
    assert.equal(requests.at(-1).url, '/api/status');
  });

  await t.test('weather preview passes arbitrary safe locations without a three-city whitelist',async()=>{
    const args={cities:['上海','辽宁 朝阳']};
    const result=await client.callTool({name:'qq_weather_preview',arguments:args});
    assert.equal(result.isError,false);assert.equal(parseResult(result).ok,true);
    assert.equal(requests.at(-1).url,'/api/weather/preview');assert.deepEqual(requests.at(-1).body,args);
    const before=requests.length;
    const invalid=await client.callTool({name:'qq_weather_preview',arguments:{cities:['https://127.0.0.1']}});
    assert.equal(invalid.isError,true);assert.equal(requests.length,before);
  });

  await t.test('weather tools preserve safe ambiguity choices and daily-city errors as MCP errors', async () => {
    mode='location-ambiguity';
    for(const name of ['qq_weather_preview','qq_weather_briefing']) {
      const result=await client.callTool({name,arguments:{cities:['朝阳'],...(name==='qq_weather_briefing'?{mode:'test'}:{})}});
      assert.equal(result.isError,true);
      assert.deepEqual(parseResult(result),{ok:false,code:'LOCATION_AMBIGUOUS',
        suggestions:['北京市·朝阳（qweather-101010300）','辽宁省·朝阳市（qweather-101071201）']});
      assert.doesNotMatch(JSON.stringify(result),/BACKEND_SECRET|credentials|https:|secret/);
    }
    mode='daily-city-restricted';
    const restricted=await client.callTool({name:'qq_weather_briefing',arguments:{cities:['上海'],mode:'daily'}});
    assert.equal(restricted.isError,true);
    assert.deepEqual(parseResult(restricted),{ok:false,code:'DAILY_CITY_RESTRICTED'});
    mode='normal';
  });

  await t.test('notify forwards only the intended text and idempotency key', async () => {
    const args = { text: '仅模拟服务测试，不发送真实 QQ。', idempotencyKey: 'test-send-1' };
    const result = await client.callTool({ name: 'qq_notify', arguments: args });
    assert.deepEqual(parseResult(result), { ok: true, code: 'SENT' });
    assert.deepEqual(requests.at(-1).body, args);
    const duplicate = await client.callTool({ name: 'qq_notify', arguments: args });
    assert.deepEqual(parseResult(duplicate), { ok: false, code: 'DUPLICATE', deliveryState: 'sent' });
  });

  await t.test('invalid or extra destination arguments never reach HTTP', async () => {
    for (const args of [
      { text: 'x', idempotencyKey: 'valid', destination: 'another-user' },
      { text: 'x'.repeat(1501), idempotencyKey: 'valid' },
      { text: ' ', idempotencyKey: 'valid' },
      { text: 'x', idempotencyKey: 'x'.repeat(101) },
      { text: 'x', idempotencyKey: 'space not allowed' },
    ]) {
      const before = requests.length;
      const result = await client.callTool({ name: 'qq_notify', arguments: args });
      assert.equal(result.isError, true);
      assert.equal(requests.length, before);
    }
  });

  await t.test('admin token is reread at call time after rotation', async () => {
    expectedToken = 'b'.repeat(64);
    await writeFile(tokenPath, expectedToken);
    const result = await client.callTool({ name: 'qq_status', arguments: {} });
    assert.equal(parseResult(result).ok, true);
    assert.equal(requests.at(-1).auth, `Bearer ${expectedToken}`);
  });

  await t.test('upstream error and redirect are sanitized and never followed', async () => {
    for (const selected of ['error', 'redirect']) {
      mode = selected;
      const before = requests.length;
      const result = await client.callTool({ name: 'qq_status', arguments: {} });
      assert.deepEqual(parseResult(result), { ok: false, code: 'BRIDGE_HTTP_ERROR' });
      assert.equal(requests.length, before + 1);
      assert.doesNotMatch(JSON.stringify(result), /secret-server-error|Bearer|https:/);
    }
    mode = 'normal';
  });

  await t.test('oversize responses are rejected without copying their contents', async () => {
    mode = 'oversize';
    const result = await client.callTool({ name: 'qq_status', arguments: {} });
    assert.deepEqual(parseResult(result), { ok: false, code: 'BRIDGE_INVALID_RESPONSE' });
    mode = 'normal';
  });

  await t.test('missing token fails locally; stalled HTTP has a total timeout', async () => {
    const before = requests.length;
    await assert.rejects(createBridgeClient({ home: join(home, 'absent') }).status(), { code: 'BRIDGE_NOT_INITIALIZED' });
    assert.equal(requests.length, before);
    mode = 'timeout';
    await assert.rejects(createBridgeClient({ home, timeoutMs: 50 }).status(), { code: 'BRIDGE_TIMEOUT' });
    mode = 'normal';
  });
  assert.equal(stderr, '');
});
