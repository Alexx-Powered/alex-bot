import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {BridgeCore} from '../src/core.mjs';
import {GroupConnections} from '../src/group-connections.mjs';

async function fixture() {
  let state={version:1,ownerId:'OWNER',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],
    lastDeliveryCode:null,allowedGroups:[{id:'OPENID_A',name:'同名群'},{id:'OPENID_B',name:'同名群'}],grayGroups:[]};
  const sent=[],wire=[],received=[];
  const official={status:()=>({state:'connected'}),send:async value=>{sent.push(value);return {ok:true};}};
  const store={loadState:async()=>structuredClone(state),saveState:async value=>{state=value;}};
  let router;
  const core=new BridgeCore({...store,send:request=>router.send(request)});await core.init();
  router=new GroupConnections({core,official,onMessage:(...args)=>{
    const job=core.handleMessage(...args);received.push(job);return job;
  }});
  router.socket={readyState:1,send:raw=>{
    const frame=JSON.parse(raw);wire.push(frame);
    if(frame.type==='deliver')queueMicrotask(()=>router.receive({type:'receipt',request:frame.request,outcome:'accepted',seq:'9007199254740996'}));
  }};
  const roster=()=>router.receive({type:'roster',account:'111',groups:[{number:'222',name:'同名群'},{number:'333',name:'同名群'}]});
  roster();
  const key=core.groupRoutes()[0].key;
  const officialEvent=(text,id='MSG')=>({kind:'group',groupId:'OPENID_A',senderId:'MEMBER',id,text,mentioned:true,
    replyTarget:{scope:'group',targetId:'OPENID_A',msgId:id}});
  const milkyEvent=(text,overrides={})=>router.receive({type:'message',account:'111',peer:'222',sender:'777',
    seq:'9007199254740993',at:Date.now(),text,mentioned:true,...overrides});
  const select=(channel,revision)=>core.selectGroupRoute({groupKey:key,channel,revision},(r,c)=>router.available(r,c));
  return {core,store,router,key,sent,wire,received,roster,officialEvent,milkyEvent,select};
}

test('opening a roster entry creates one disabled independent group, which can then receive and reply on Milky',async()=>{
  const {core,router,store,wire,sent,received,milkyEvent}=await fixture();
  const params={number:'222',rosterKey:router.summary().rosterKey};
  const [first,second]=await Promise.all([router.open(params),router.open(params)]);
  assert.equal(first.ok,true);assert.deepEqual(first,second);
  const group=core.status().allowedGroups.find(g=>g.groupKey===first.groupKey);
  assert.equal(group.name,'同名群');assert.equal(group.enabled,false);
  assert.ok(Object.values(group.features).every(value=>value===false));
  const route=core.groupRoutes().find(r=>r.key===first.groupKey);
  assert.equal(router.summary().groups.find(r=>r.groupKey===route.key).official,'unlinked');
  assert.equal(router.summary().directory.filter(g=>g.managed).length,1);
  assert.equal((await core.selectGroupRoute({groupKey:route.key,channel:'official',revision:route.revision},()=>true)).ok,false);
  milkyEvent('/ping');assert.equal(received.length,0);
  assert.equal((await core.setGroupFeatures({groupKey:route.key,enabled:true,features:{...group.features,conversion:true}})).ok,true);
  router.sync();assert.deepEqual(wire.at(-1).peers,['222']);
  milkyEvent('/ping');await Promise.all(received);
  assert.equal(wire.filter(f=>f.type==='deliver'&&f.peer==='222').length,1);
  assert.equal(sent.length,0);assert.equal(core.status().allowedGroups.length,3);
  const restored=new BridgeCore({...store,send:async()=>{}});await restored.init();
  assert.equal(restored.groupRoutes().find(r=>r.key===route.key).active,'milky');
  assert.equal(restored.groupEnabled(route.id),true);
  router.receive({type:'roster',account:'444',groups:[{number:'222',name:'同名群'}]});
  assert.equal((await router.open(params)).code,'GROUP_ROUTE_OFFLINE');
  assert.equal(router.summary().groups.find(r=>r.groupKey===route.key).milky,'otherAccount');
  assert.equal((await router.open({number:'555',rosterKey:router.summary().rosterKey})).ok,false);
  await core.removeAllowedGroup({groupKey:route.key});
  await assert.rejects(router.send({groupId:route.id,text:'old'}),{code:'QQ_SEND_CANCELLED'});
  assert.equal(sent.length,0);
});

test('verified pairing absorbs only an untouched ordinary entry and preserves independently configured groups',async()=>{
  for(const edited of [false,true]){
    const {core,router,key,officialEvent,milkyEvent}=await fixture();
    const opened=await router.open({number:'222',rosterKey:router.summary().rosterKey});
    const settings=core.status().allowedGroups.find(g=>g.groupKey===opened.groupKey);
    if(edited)await core.setGroupFeatures({...settings,enabled:false,helpNote:'仅供本群'});
    assert.equal(router.startPair({groupKey:key,number:'222'}).ok,true);
    const {command}=router.summary().pairing;
    router.observeOfficial(officialEvent(command),Date.now()+300000);milkyEvent(command);
    const confirmed=await router.confirm({groupKey:key,command});
    assert.equal(confirmed.code,edited?'GROUP_ROUTE_HAS_SETTINGS':'GROUP_ROUTE_LINKED');
    assert.equal(core.groupRoutes().length,edited?3:2);
    assert.equal(core.groupRoutes()[0].peer,edited?undefined:'222');
  }
});

test('dual group proof, persisted selection, actual reply routing, media, scoped permissions and offline failure',async()=>{
  const f=await fixture(),{core,router,key}=f;
  assert.equal((await f.select('milky',0)).ok,false);
  assert.equal(router.startPair({groupKey:key,number:'222'}).ok,true);
  const {command}=router.summary().pairing;
  router.observeOfficial(f.officialEvent(command),Date.now()+300000);
  f.milkyEvent(command,{peer:'333'});
  assert.equal((await router.confirm({groupKey:key,command})).code,'GROUP_ROUTE_UNVERIFIED');
  f.milkyEvent(command);
  assert.equal((await router.confirm({groupKey:key,command})).ok,true);
  assert.equal(core.groupRoutes()[0].active,'official');
  assert.equal((await f.select('milky',1)).ok,true);
  router.sync();
  assert.deepEqual(f.wire.at(-1).peers,['222']);
  assert.equal((await core.handleMessage(f.officialEvent('/ping'))).code,'IGNORED');
  f.milkyEvent('/ping',{sender:'111'});f.milkyEvent('/ping',{peer:'333'});f.milkyEvent('/ping',{account:'444'});
  assert.equal(f.received.length,0);
  f.milkyEvent('/ping');f.milkyEvent('/ping');await Promise.all(f.received);
  const deliveries=f.wire.filter(m=>m.type==='deliver');
  assert.equal(deliveries.length,1);assert.equal(f.sent.length,0);
  assert.deepEqual(deliveries[0].parts,[{type:'text',text:'连接正常（固定测试回复）'}]);
  assert.equal(deliveries[0].peer,'222');
  const existing=core.status().allowedGroups[0].features;
  await assert.rejects(router.send({groupId:'OPENID_A',text:'未订阅',proactiveGroup:true,requiredFeature:'morningWeather'}),
    {code:'QQ_SEND_CANCELLED'});
  assert.equal((await core.setGroupFeatures({groupKey:key,enabled:true,features:{...existing,morningWeather:true}})).ok,true);
  const png=Buffer.from('89504e470d0a1a0a','hex');
  await router.send({groupId:'OPENID_A',text:'天气',image:{buffer:png,mimeType:'image/png'},richMedia:true,
    proactiveGroup:true,requiredFeature:'morningWeather'});
  assert.deepEqual(f.wire.at(-1).parts,[{type:'text',text:'天气'},{type:'image',base64:png.toString('base64')}]);
  const video=Buffer.alloc(32);video.writeUInt32BE(24);video.write('ftyp',4);
  await router.send({groupId:'OPENID_A',text:'天气视频',video:{buffer:video,mimeType:'video/mp4'},proactiveGroup:true,requiredFeature:'morningWeather'});
  assert.deepEqual(f.wire.at(-1).parts,[{type:'video',base64:video.toString('base64')}]);
  assert.equal((await f.select('official',1)).code,'GROUP_ROUTE_CHANGED');
  const restored=new BridgeCore({...f.store,send:async()=>{}});await restored.init();
  assert.equal(restored.groupRoutes()[0].active,'milky');assert.equal(restored.groupRoutes()[1].active,'official');
  router.receive({type:'offline'});
  await assert.rejects(router.send({groupId:'OPENID_A',text:'x'}),{code:'QQ_SERVICE_UNAVAILABLE'});
  assert.equal(f.sent.length,0);
  assert.equal((await f.select('official',2)).ok,true);
  assert.equal((await core.handleMessage(f.officialEvent('/ping','AFTER_SWITCH'))).code,'SENT');
  assert.equal(f.sent.length,1);
  await core.removeAllowedGroup({groupKey:key});
  assert.equal(Object.values((await f.store.loadState()).groupLinks).length,0);
  await tick();
});

test('automatic group identification requires one peer, preserves remarks, and remembers verified names offline',async()=>{
  const {core,router,key,store,officialEvent,milkyEvent}=await fixture();
  async function prove(peers){
    assert.equal(router.startPair({groupKey:key,number:''}).ok,true);
    const {command}=router.summary().pairing;
    router.observeOfficial(officialEvent(command),Date.now()+300000);
    for(const peer of peers)milkyEvent(command,{peer});
    return router.confirm({groupKey:key,command});
  }
  assert.equal((await prove(['222','333'])).code,'GROUP_ROUTE_UNVERIFIED');
  assert.equal((await prove(['222'])).ok,true);
  await core.rememberGroupNames([{key,name:'官方识别名'}],'official');
  assert.equal(core.status().allowedGroups[0].name,'同名群');
  router.receive({type:'offline'});
  const group=router.summary().groups[0];
  assert.equal(group.number,'222');
  assert.deepEqual(group.names,{milky:'同名群',official:'官方识别名'});
  const saved=await store.loadState();
  saved.allowedGroups[0].name='新加入群 · '+key.slice(0,8);
  await store.saveState(saved);
  const restored=new BridgeCore({...store,send:async()=>{}});await restored.init();
  assert.equal(restored.status().allowedGroups[0].name,'官方识别名');
});

test('per-group membership follows genuine events, rejects stale checks and never treats a name as a binding',async()=>{
  const {core,router,key}=await fixture();
  const at=Date.now();router.now=()=>at;
  await core.rememberGroupNames([{key,name:'同名群'}],'official');
  assert.equal(router.summary().groups[0].candidates.length,2);
  assert.equal(router.summary().groups[0].milky,'candidate');
  assert.equal(router.summary().groups[0].official,'unknown');
  let finish;
  router.official.groupMembership=()=>new Promise(resolve=>{finish=resolve;});
  const job=router.refreshMembership();
  router.observePresence('OPENID_A','absent',at);
  finish({state:'present',proactive:true});await job;
  router.observePresence('OPENID_A','present',at-100);
  assert.equal(router.summary().groups[0].official,'absent');
  router.now=()=>at+200;
  router.observePresence('OPENID_A','present',at+200);
  assert.equal(router.summary().groups[0].official,'present');
  router.receive({type:'roster_error'});
  assert.equal(router.summary().groups[0].milky,'unknown');
  router.receive({type:'roster',account:'111',groups:[]});
  assert.equal(router.summary().groups[0].milky,'absent');
  router.officialDisconnected();
  assert.equal(router.summary().groups[0].official,'unknown');
});

test('console probe sends once after the listener is armed and binds only after the operator confirms the number',async()=>{
  const {core,router,key,wire,sent,milkyEvent,select}=await fixture();
  router.official.groupMembership=async()=>({state:'present',proactive:true});
  await router.refreshMembership();
  assert.equal(router.startProbe({groupKey:key}).code,'GROUP_PROBE_STARTED');
  assert.equal(sent.length,0);
  const {command}=wire.at(-1).verification;
  assert.ok(!JSON.stringify(router.summary()).includes(command));
  for(let i=0;i<2;i++)router.receive({type:'probe_ready',account:'111',command});
  await tick();
  assert.equal(sent.length,1);assert.equal(sent[0].groupId,'OPENID_A');
  assert.equal(sent[0].text,command);
  assert.equal(core.canDeliver({...sent[0]}),false);
  milkyEvent(command);
  await new Promise(resolve=>setTimeout(resolve,2650));
  const proof=router.summary().pairing;
  assert.equal(proof.matched,true);assert.equal(proof.number,'222');
  assert.equal(core.groupRoutes()[0].peer,undefined);
  assert.equal((await router.confirm({groupKey:key,command:proof.command})).ok,true);
  assert.equal(core.groupRoutes()[0].active,'official');
  assert.equal((await select('milky',1)).ok,true);
  router.receive({type:'roster',account:'111',groups:[{number:'222',name:'同名群'}]});
  assert.equal(router.summary().groups[1].milky,'absent');
  router.receive({type:'roster',account:'111',groups:[{number:'222',name:'同名群'},{number:'444',name:'其他'}]});
  assert.equal(router.summary().groups[1].milky,'unverified');
  router.receive({type:'roster',account:'111',groups:[{number:'333',name:'同名群'}]});
  assert.equal(router.summary().groups[0].milky,'absent');
  router.observePresence('OPENID_A','absent',Date.now());
  assert.equal((await select('official',2)).code,'GROUP_ROUTE_OFFLINE');
});
