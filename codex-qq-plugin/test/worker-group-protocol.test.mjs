import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {ConversationAgent} from '../src/conversation-agent.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';

const fixture = fileURLToPath(new URL('./fixtures/group-protocol-worker.py', import.meta.url));
const config = {enabled: true, apiKey: 'offline-test', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com'};
const policy = {enabled: false, topics: [], instructions: '', maxChars: 500};

test('group gateway authorizes real LangGraph tools and receives request-scoped attachments', async t => {
  const home = await mkdtemp(join(tmpdir(), 'qq-group-protocol-'));
  const worker = new PythonAgentWorker({home, workerPath: fixture});
  t.after(async () => {
    worker.close();
    await rm(home, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  });
  const packets = [];
  const callbacks = [];
  const grants = [];
  let beforeFinish = () => {};
  const run = worker.run.bind(worker);
  worker.run = (packet, execute, finish, authorize, events) => {
    packets.push(packet);
    return run(packet, (...args) => {
      callbacks.push(args[0]);
      return execute(...args);
    }, result => {
      beforeFinish();
      return finish(result);
    }, (feature, tool) => {
      grants.push([feature, tool]);
      return authorize(feature, tool);
    }, events);
  };
  const agent = new ConversationAgent({
    worker, configStore: {read: async () => config}, modelBudget: {acquire: async () => ({ok: true})},
    policyLoader: async () => policy,
  });
  const context = (key, authorize = () => true) => ({
    scope: 'group', access: 'white', sessionKey: key, authorize, features: defaultGroupFeatures('white'),
  });
  const sources = async () => (await readFile(join(home, 'fixture-sources.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  const artifacts = () => readdir(join(home, '.private', 'worker-replies'));

  await t.test('model selects the radar source, Python publishes a PNG, Node reads it once', async () => {
    const reply = await agent.handle('帮忙看看东京那边的全球雷达', context('group-radar'));
    assert.equal(reply.requiredFeature, 'radar');
    assert.equal(reply.richMedia, true);
    assert.match(reply.text, /东京.*全球雷达拼图/u);
    assert.equal(reply.image.mimeType, 'image/png');
    assert.equal(reply.image.buffer.readUInt32BE(16), 1080);
    assert.equal(reply.image.buffer.readUInt32BE(20), 1370);
    assert.deepEqual(await sources(), [{source: 'radar', parameters: {target: '东京'}}]);
    assert.deepEqual(await artifacts(), []);
  });

  await t.test('LangGraph retries invalid model hours, executes only the corrected 48-hour choice and returns an MP4', async () => {
    const reply = await agent.handle('想看看从明天开始华北两天的云量变化，做成动画', context('group-forecast'));
    assert.equal(reply.requiredFeature, 'weather');
    assert.equal(reply.video.mimeType, 'video/mp4');
    assert.equal(reply.video.buffer.toString('ascii', 4, 8), 'ftyp');
    assert.ok(reply.video.buffer.includes(Buffer.from('avc1')));
    const [radar, forecast] = await sources();
    assert.equal(radar.source, 'radar');
    assert.equal(forecast.source, 'forecast');
    const beijingTomorrow = new Date(Date.parse(packets.at(-1).now) + 32 * 3600_000).toISOString().slice(0, 10);
    assert.equal(forecast.parameters.start, Date.parse(beijingTomorrow + 'T00:00:00+08:00') / 1000);
    assert.equal(forecast.parameters.layer, 'cloud_cover');
    assert.equal(forecast.parameters.hours, 48);
    assert.equal(forecast.parameters.name, '华北');
    assert.deepEqual(await artifacts(), []);
  });

  await t.test('a second group cannot reuse a previous grant, and in-flight revocation discards a reply', async () => {
    const denied = await agent.handle('帮忙看看伦敦那边的全球雷达',
      context('group-denied', (tier, feature) => feature !== 'radar'));
    assert.match(denied.text, /未开放/u);
    assert.equal(denied.image, undefined);
    assert.equal((await sources()).length, 2);
    let allowed = true;
    beforeFinish = () => { allowed = false; };
    const revoked = await agent.handle('帮忙看看纽约那边的全球雷达',
      context('group-revoked', (tier, feature) => feature !== 'radar' || allowed));
    beforeFinish = () => {};
    assert.match(revoked.text, /未开放/u);
    assert.equal(revoked.image, undefined);
    assert.deepEqual((await sources()).at(-1), {source: 'radar', parameters: {target: '纽约'}});
    assert.deepEqual(await artifacts(), []);
    assert.deepEqual(grants, [['radar', 'radar_image'], ['weather', 'cloud_video'],
      ['radar', 'radar_image'], ['radar', 'radar_image']]);
  });

  await t.test('Python rejects invalid deterministic arguments before a grant or data-source request', async () => {
    const payload = {type: 'execute', replyFormat: 'attachment-v1', name: 'cloud_video',
      args: {city: '华北', hours: 37}, context: context('group-invalid')};
    await assert.rejects(worker.run(payload, () => assert.fail('unexpected tool callback'),
      result => result, () => assert.fail('invalid hours reached the gateway')));
    assert.equal((await sources()).length, 3);
    assert.deepEqual(await artifacts(), []);
  });
  assert.ok(packets.every(packet => packet.replyFormat === 'attachment-v1'));
  assert.deepEqual(callbacks, []);
});
