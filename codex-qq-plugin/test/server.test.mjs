import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createCanvas} from '@napi-rs/canvas';
import { createBridgeServer } from '../src/server.mjs';

function memoryStore() {
  return { token:'a'.repeat(64), credentials:null, state:null,
    async init(){}, async readCredentials(){return this.credentials},
    async saveCredentials(c){this.credentials={...c}}, async loadState(){return structuredClone(this.state)},
    async saveState(s){this.state=structuredClone(s)} };
}

test('study image endpoint authenticates, limits images, stays owner-only and deduplicates',async()=>{
  const f=await fixture();
  const input={idempotencyKey:'study:'+'b'.repeat(64),pngBase64:createCanvas(1080,600).toBuffer('image/png').toString('base64')};
  try{
    assert.equal((await fetch(f.url+'/api/study-briefing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    await f.request('/api/connect',{});
    const pair=await(await f.request('/api/pair/start',{})).json();
    await f.receive({kind:'c2c',id:'c1',senderId:'owner',text:'/pair '+pair.pairingCode,replyTarget:{scope:'c2c',targetId:'owner',msgId:'c1'}});
    await f.request('/api/pair/confirm',{});
    assert.equal((await(await f.request('/api/study-briefing',{...input,groupId:'other'})).json()).ok,false);
    assert.equal((await(await f.request('/api/study-briefing',{...input,pngBase64:Buffer.from('not png').toString('base64')})).json()).ok,false);
    assert.equal(f.sent.length,0);
    assert.equal((await(await f.request('/api/study-briefing',input)).json()).code,'SENT');
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].ownerId,'owner');assert.equal(f.sent[0].groupId,undefined);assert.ok(f.sent[0].image.buffer.length);
    await f.request('/api/study-briefing',input);assert.equal(f.sent.length,1);
    await f.request('/api/pause',{paused:true});
    assert.equal((await(await f.request('/api/study-briefing',{...input,idempotencyKey:'study:'+'c'.repeat(64)})).json()).code,'PAUSED');
    assert.equal(f.sent.length,1);
  }finally{await f.app.close()}
});
async function fixture(weatherCommands) {
  const store=memoryStore(), sent=[];
  let receive;
  const app=await createBridgeServer({port:0,store,...(weatherCommands?{weatherCommands,morningReport:{plan:()=>({city:'beijing'}),create:()=>weatherCommands.briefing({cities:['beijing'],renderImage:true})}}:{}),adapterFactory:({onMessage})=>{
    receive=onMessage; let state='disconnected';
    return {status:()=>({state,code:null}),async connect(){state='connected'},async disconnect(){state='disconnected'},
      async send(data){if(state!=='connected')throw Object.assign(new Error('NOT_CONNECTED'),{code:'NOT_CONNECTED'});sent.push(data);return {id:'test'}}};
  }});
  const port=await app.listen(), url='http://127.0.0.1:'+port;
  const request=(route,data,headers={})=>fetch(url+route,{method:data===undefined?'GET':'POST',headers:{
    Authorization:'Bearer '+store.token,...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},
    ...(data===undefined?{}:{body:JSON.stringify(data)})});
  return {app,store,sent,request,url,receive};
}

test('loopback API rejects missing auth and cross-origin browser mutations',async()=>{
  const f=await fixture();try{
    assert.equal((await fetch(f.url+'/api/status')).status,401);
    assert.equal((await f.request('/api/pause',{paused:false},{Origin:'https://attacker.invalid'})).status,403);
    const badHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(f.url + '/api/status', { headers: { Host:'evil.invalid', Authorization:'Bearer '+f.store.token } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
    });
    assert.equal(badHostStatus,403);
    const health=await (await fetch(f.url+'/health')).json();
    assert.equal(health.service,'alex-codex-qq');assert.equal(JSON.stringify(health).includes('token'),false);
  }finally{await f.app.close()}
});
test('private credentials never appear in status and no connection is automatic',async()=>{
  const f=await fixture();try{
    const result=await (await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'})).json();
    assert.equal(result.ok,true);assert.equal(f.app.adapter.status().state,'disconnected');
    const status=await (await f.request('/api/status')).text();
    assert.equal(status.includes('dummy-secret'),false);assert.equal(status.includes('123456789'),false);
    assert.equal(f.sent.length,0);
    assert.equal((await f.request('/api/config',{appId:'1',appSecret:'short'})).status,400);
  }finally{await f.app.close()}
});
test('owner pairing requires local confirmation, rejects groups, then sends only fixed-owner notification',async()=>{
  const f=await fixture();try{
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    await f.request('/api/connect',{});
    const pair=await (await f.request('/api/pair/start',{})).json();
    assert.equal(pair.ok,true);assert.ok(pair.pairingCode);
    await f.receive({kind:'group',id:'g1',senderId:'owner',text:'/pair '+pair.pairingCode,replyTarget:{scope:'group',targetId:'group'}});
    assert.equal(f.app.core.status().pendingPairing,false);
    await f.receive({kind:'c2c',id:'c1',senderId:'owner',text:'/pair '+pair.pairingCode,replyTarget:{scope:'c2c',targetId:'owner',msgId:'c1'}});
    assert.equal(f.app.core.status().pendingPairing,true);assert.equal(f.sent.length,0);
    assert.equal((await (await f.request('/api/test-notify',{})).json()).ok,false);
    assert.equal((await (await f.request('/api/pair/confirm',{})).json()).ok,true);
    const result=await (await f.request('/api/notify',{text:'local test',idempotencyKey:'once',ownerId:'attacker'})).json();
    assert.equal(result.ok,true);assert.equal(f.sent.length,1);assert.equal(f.sent[0].ownerId,'owner');
    await f.request('/api/notify',{text:'local test',idempotencyKey:'once'});assert.equal(f.sent.length,1);
    await f.receive({kind:'c2c',id:'c2',senderId:'stranger',text:'/ping',replyTarget:{scope:'c2c',targetId:'stranger'}});
    assert.equal(f.sent.length,1);
    assert.equal((await f.request('/api/config',{appId:'987654321',appSecret:'different-secret'})).status,409);
    await f.request('/api/pause',{paused:true});
    assert.equal((await (await f.request('/api/test-notify',{})).json()).ok,false);
  }finally{await f.app.close()}
});
test('setup UI has restrictive CSP and JSON-only authenticated writes',async()=>{
  const f=await fixture();try{
    const page=await fetch(f.url+'/');
    assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.doesNotMatch(await page.text(),/dummy-secret/);
    const response=await fetch(f.url+'/api/connect',{method:'POST',headers:{Authorization:'Bearer '+f.store.token,'Content-Type':'text/plain'},body:'{}'});
    assert.equal(response.status,400);
    assert.equal((await f.request('/api/notify',{text:'x',idempotencyKey:'bad key'})).status,400);
  }finally{await f.app.close()}
});

test('disconnect cancels a pending credential read while other config writes stay locked',async()=>{
  const f=await fixture();
  let release;
  try {
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    const read=f.store.readCredentials.bind(f.store);
    let entered;
    const reading=new Promise(resolve=>{entered=resolve});
    f.store.readCredentials=async()=>{ entered(); await new Promise(resolve=>{release=resolve}); return read(); };
    const pending=f.request('/api/connect',{});
    await reading;
    assert.equal((await f.request('/api/config',{appId:'987654321',appSecret:'different-secret'})).status,409);
    assert.equal((await(await f.request('/api/disconnect',{})).json()).code,'DISCONNECTED');
    release(); release=null;
    assert.equal((await(await pending).json()).code,'CONNECT_CANCELLED');
    assert.equal(f.app.adapter.status().state,'disconnected');
  } finally { release?.(); await f.app.close(); }
});

test('pause and disconnect interrupt slow reports before any message or send budget is consumed', async (t) => {
  for (const control of ['/api/pause', '/api/disconnect']) await t.test(control, async () => {
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({briefing: async () => {
      entered(); await gate;
      return {date:new Date(Date.now()+8*3600000).toISOString().slice(0,10),cities:['beijing'],
        image:{buffer:Buffer.alloc(16),mimeType:'image/png'}};
    }});
    let pending;
    try {
      await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
      await f.request('/api/connect',{});
      const pair = await f.app.core.startPairing();
      await f.receive({kind:'c2c',id:'control-pair',senderId:'owner',text:'/pair '+pair.pairingCode});
      await f.app.core.confirmPairing();
      pending = f.request('/api/weather/briefing',{mode:'test'});
      await waiting;
      assert.equal((await f.request('/api/pause',{paused:false})).status,409);
      const stopped = await f.request(control,control==='/api/pause'?{paused:true}:{});
      assert.equal(stopped.status,200);
      assert.equal((await stopped.json()).code,control==='/api/pause'?'PAUSED':'DISCONNECTED');
      assert.equal(f.app.core.sendingEnabled(),false);
      assert.equal(f.app.core.status().paused,true);
      release();
      assert.equal((await(await pending).json()).code,'PAUSED');
      assert.equal(f.sent.length,0);
      assert.equal(f.app.core.status().dailyAttempts,0);
      // Safety controls cannot release another request's operation lock.
      assert.equal((await(await f.request('/api/pause',{paused:false})).json()).code,'RESUMED');
    } finally { release(); if(pending)await pending; await f.app.close(); }
  });
});

test('disconnect during adapter connection prevents a late connection from restoring transport', async () => {
  const f = await fixture();
  let release, entered, pending;
  const waiting = new Promise(resolve=>{entered=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  const connect = f.app.adapter.connect.bind(f.app.adapter);
  f.app.adapter.connect = async (...args)=>{entered();await gate;return connect(...args);};
  try {
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    pending = f.request('/api/connect',{});
    await waiting;
    assert.equal((await(await f.request('/api/disconnect',{})).json()).code,'DISCONNECTED');
    release();
    assert.equal((await(await pending).json()).code,'CONNECT_CANCELLED');
    assert.equal(f.app.adapter.status().state,'disconnected');
  } finally { release(); if(pending)await pending; await f.app.close(); }
});

test('weather preview is read-only; daily report deduplicates and respects pause',async()=>{
  let fetched=0, rendered, date=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const image={buffer:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(100000)]),mimeType:'image/png'};
  const f=await fixture({handle:async()=>null,briefing:async({cities,renderImage})=>{fetched++;rendered=renderImage;return {ok:true,text:'北京天气预报：仅用于离线验证',date,cities,image}}});
  try {
    const preview=await (await f.request('/api/weather/preview',{cities:['beijing']})).json();
    assert.equal(preview.ok,true);assert.equal(f.sent.length,0);assert.equal(rendered,false);
    assert.deepEqual(Object.keys(preview).sort(),['cities','date','ok','text']);assert.ok(JSON.stringify(preview).length<1000);
    assert.equal((await(await f.request('/api/weather/briefing',{})).json()).code,'NOT_PAIRED');
    assert.equal(fetched,1);
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    await f.request('/api/connect',{});
    const pairing=await(await f.request('/api/pair/start',{})).json();
    await f.receive({kind:'c2c',id:'weather-pair',senderId:'owner',text:'/pair '+pairing.pairingCode});
    await f.request('/api/pair/confirm',{});
    assert.equal((await(await f.request('/api/weather/briefing',{mode:'daily'})).json()).code,'SENT');
    assert.equal((await(await f.request('/api/weather/briefing',{mode:'daily'})).json()).code,'DUPLICATE');
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].ownerId,'owner');
    assert.equal(f.sent[0].text,'');assert.deepEqual(f.sent[0].image,image);
    assert.equal((await(await f.request('/api/notify',{text:'',image:{buffer:'untrusted',mimeType:'image/png'},idempotencyKey:'untrusted-image'})).json()).code,'INVALID_INPUT');
    date='2000-01-01';assert.equal((await f.request('/api/weather/briefing',{mode:'daily'})).status,500);assert.equal(f.sent.length,1);
    await f.request('/api/pause',{paused:true});const before=fetched;
    assert.equal((await(await f.request('/api/weather/briefing',{mode:'test'})).json()).code,'PAUSED');
    assert.equal(fetched,before);assert.equal(f.sent.length,1);
  } finally {await f.app.close();}
});

test('daily weather is restricted to Beijing before fetching or consuming the daily key', async () => {
  const calls=[];
  const date=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const image={buffer:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(100000)]),mimeType:'image/png'};
  const f=await fixture({handle:async()=>null,briefing:async args=>{calls.push(args);return {ok:true,date,cities:args.cities,text:'fixture',image};}});
  try {
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    await f.request('/api/connect',{});
    const pairing=await(await f.request('/api/pair/start',{})).json();
    await f.receive({kind:'c2c',id:'daily-city-pair',senderId:'owner',text:'/pair '+pairing.pairingCode});
    await f.request('/api/pair/confirm',{});
    const before=structuredClone(f.store.state);
    for (const cities of [['上海'],['beijing','上海'],[],null,'beijing',['qweather-101010100']]) {
      const response=await f.request('/api/weather/briefing',{mode:'daily',cities});
      assert.equal(response.status,200);
      assert.deepEqual(await response.json(),{ok:false,code:'DAILY_CITY_RESTRICTED'});
    }
    assert.deepEqual(await(await f.request('/api/weather/briefing',{cities:['广州']})).json(),{ok:false,code:'DAILY_CITY_RESTRICTED'});
    assert.equal(calls.length,0);assert.equal(f.sent.length,0);assert.deepEqual(f.store.state,before);
    assert.equal((await(await f.request('/api/weather/briefing',{})).json()).code,'SENT');
    for(const cities of [['beijing'],['北京'],['北京市']]) {
      assert.equal((await(await f.request('/api/weather/briefing',{mode:'daily',cities})).json()).code,'DUPLICATE');
    }
    assert.ok(calls.every(call=>call.cities.length===1&&call.cities[0]==='beijing'));
    assert.equal(f.sent.length,1);
    assert.equal((await(await f.request('/api/weather/briefing',{mode:'test',cities:['上海']})).json()).code,'SENT');
    assert.deepEqual(calls.at(-1).cities,['上海']);assert.equal(f.sent.length,2);
  } finally {await f.app.close();}
});

test('weather location errors expose only fixed codes and bounded safe suggestions', async () => {
  let failure;
  const f=await fixture({handle:async()=>null,briefing:async()=>{throw failure;}});
  try {
    await f.request('/api/config',{appId:'123456789',appSecret:'dummy-secret-not-real'});
    await f.request('/api/connect',{});
    const pairing=await(await f.request('/api/pair/start',{})).json();
    await f.receive({kind:'c2c',id:'location-error-pair',senderId:'owner',text:'/pair '+pairing.pairingCode});
    await f.request('/api/pair/confirm',{});
    const safe=Array.from({length:10},(_,i)=>`地点${i}（qweather-1010${i}）`);
    const suggestions=[null,{},'https://secret.invalid/token','secret\nvalue','x'.repeat(61),' leading',...safe];
    for (const code of ['LOCATION_AMBIGUOUS','LOCATION_NOT_FOUND','LOCATION_INPUT_INVALID','LOCATION_SOURCE_UNAVAILABLE']) {
      failure=Object.assign(new Error('BACKEND_SECRET_DO_NOT_LEAK'),{code,suggestions,credentials:'BACKEND_SECRET_DO_NOT_LEAK'});
      for (const route of ['/api/weather/preview','/api/weather/briefing']) {
        const response=await f.request(route,{cities:['朝阳'],mode:'test'});
        assert.equal(response.status,200);
        const result=await response.json();
        assert.deepEqual(result,{ok:false,code,...(code==='LOCATION_AMBIGUOUS'?{suggestions:safe.slice(0,8)}:{})});
        assert.doesNotMatch(JSON.stringify(result),/BACKEND_SECRET|credentials|https:|secret/);
      }
    }
    failure=Object.assign(new Error('BACKEND_SECRET_DO_NOT_LEAK'),{code:'ARBITRARY_BACKEND_CODE',suggestions});
    const generic=await f.request('/api/weather/preview',{cities:['上海']});
    assert.equal(generic.status,500);
    assert.deepEqual(await generic.json(),{ok:false,code:'OPERATION_FAILED'});
    assert.equal(f.sent.length,0);assert.equal(f.app.core.status().dailyAttempts,0);
  } finally {await f.app.close();}
});

test('authenticated group enrollment binds an observed group; public notifications remain owner-only', async () => {
  const queries = [];
  const f = await fixture({ handle: async text => { queries.push(text); return text === '发 天气 beijing' ? { text: 'weather fixture' } : null; } });
  const groupMessage = (id, text, groupId = 'PRIVATE_GROUP_OPENID') => ({ kind: 'group', id, groupId,
    senderId: 'MEMBER_OPENID', text, replyTarget: { scope: 'group', targetId: groupId, msgId: id } });
  try {
    assert.equal((await fetch(f.url + '/api/group/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"test"}' })).status, 401);
    assert.equal((await f.request('/api/group/start', { name: 'test' }, { Origin: 'https://attacker.invalid' })).status, 403);
    await f.request('/api/config', { appId: '123456789', appSecret: 'dummy-secret-not-real' });
    await f.request('/api/connect', {});
    const ownerPair = await (await f.request('/api/pair/start', {})).json();
    await f.receive({ kind: 'c2c', id: 'owner-pair', senderId: 'owner', text: '/pair ' + ownerPair.pairingCode });
    await f.request('/api/pair/confirm', {});
    assert.equal((await f.request('/api/group/start', { name: 'bad\nname' })).status, 400);
    await f.receive(groupMessage('before-enrollment', '梁祖 发 天气 北京'));
    assert.equal(f.sent.length, 0);
    assert.deepEqual(queries, []);
    const binding = await (await f.request('/api/group/start', { name: '万通荆古帖v2.0' })).json();
    assert.equal(binding.ok, true);
    assert.match(binding.groupPairingCode, /^[a-f0-9]{32}$/);
    await f.receive(groupMessage('group-bind', '/group-bind ' + binding.groupPairingCode));
    const status = await (await f.request('/api/status')).json();
    assert.equal(status.core.pendingGroup.name, '万通荆古帖v2.0');
    assert.equal(f.sent.length, 0);
    assert.ok(!JSON.stringify(status).includes('PRIVATE_GROUP_OPENID'));
    assert.ok(!JSON.stringify(status).includes(binding.groupPairingCode));
    const key = status.core.pendingGroup.groupKey;
    assert.equal((await (await f.request('/api/group/confirm', { groupKey: 'f'.repeat(64) })).json()).ok, false);
    assert.equal((await (await f.request('/api/group/confirm', { groupKey: key })).json()).ok, true);
    await f.receive(groupMessage('weather-without-alias', '发 天气 北京'));
    assert.equal(f.sent.length, 0); assert.deepEqual(queries, []);
    await f.receive(groupMessage('weather-in-group', '梁祖 发 天气 北京'));
    assert.equal(f.sent.length, 1);
    assert.deepEqual(queries, ['发 天气 beijing']);
    assert.equal(f.sent[0].groupId, 'PRIVATE_GROUP_OPENID');
    assert.equal(f.sent[0].replyTarget.scope, 'group');
    const notify = await (await f.request('/api/notify', { text: 'private Codex report', idempotencyKey: 'private-report', groupId: 'PRIVATE_GROUP_OPENID', replyTarget: groupMessage('fake', '').replyTarget })).json();
    assert.equal(notify.ok, true);
    assert.equal(f.sent[1].ownerId, 'owner');
    assert.equal(f.sent[1].groupId, undefined);
    assert.equal(f.sent[1].replyTarget, undefined);
    await f.receive(groupMessage('group-pause', '梁祖 /pause'));
    assert.equal(f.app.core.status().paused, false);
    await f.request('/api/group/start', { name: 'second group' });
    await f.request('/api/disconnect', {});
    assert.equal(f.app.core.status().pendingGroupPairing, false);
    assert.equal((await (await f.request('/api/group/remove', { groupKey: key })).json()).ok, true);
    assert.equal(f.app.core.status().groupCount, 0);
    await f.receive(groupMessage('after-removal', '梁祖 发 天气 北京'));
    assert.equal(f.sent.length, 2);
  } finally { await f.app.close(); }
});

