import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {dispatchEvent} from '@tencent-connect/qqbot-nodejs/protocol';
import {QQAdapter} from '../src/qq-adapter.mjs';
import {BridgeCore} from '../src/core.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {basicGroupFeatures,defaultGroupFeatures} from '../src/group-features.mjs';

const key=id=>createHash('sha256').update('group:'+id).digest('hex');
const initial=()=>({version:1,ownerId:'PRIVATE_OWNER',paused:false,pauseReason:null,
  attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
  allowedGroups:[{id:'OFFICIAL_A',name:'原有群'}],grayGroups:[]});
const incoming=(groupId,id,text,mentioned=true)=>({kind:'group',groupId,id,text,mentioned,
  senderId:'GROUP_MEMBER_OPENID',replyTarget:{scope:'group',targetId:groupId,msgId:id}});

test('official group matching accepts a separate member OpenID, requires confirmation, and grants only the selected features',async()=>{
  let saved=initial();const sent=[];
  const core=new BridgeCore({loadState:async()=>saved,saveState:async value=>{saved=structuredClone(value);},
    send:async value=>{sent.push(value);},commandHandler:async()=>({text:'应答'})});
  await core.init();
  const started=await core.startGroupPairing({name:'新群备注'});
  assert.equal((await core.handleMessage(incoming('OFFICIAL_B','wrong','/group-bind '+'0'.repeat(32)))).code,'GROUP_DENIED');
  const candidate=await core.handleMessage(incoming('OFFICIAL_B','match','/group-bind '+started.groupPairingCode));
  assert.equal(candidate.code,'GROUP_PAIRING_PENDING');assert.equal(core.status().groupCount,1);
  assert.equal(sent.length,0);
  assert.equal((await core.confirmGroupPairing({groupKey:key('OFFICIAL_B'),features:{chat:true}})).code,'INVALID_INPUT');
  assert.equal(core.status().groupCount,1);
  assert.equal((await core.confirmGroupPairing({groupKey:key('OFFICIAL_C'),features:basicGroupFeatures()})).code,'GROUP_PAIRING_KEY_MISMATCH');
  assert.equal((await core.confirmGroupPairing({groupKey:candidate.groupKey,features:basicGroupFeatures()})).code,'GROUP_ALLOWED');
  assert.deepEqual(saved.allowedGroups[1].features,basicGroupFeatures());
  assert.equal(core.canUseFeature('OFFICIAL_B','weather'),false);
  assert.equal(core.canUseFeature('OFFICIAL_B','morningWeather'),false);
  assert.equal(core.canUseFeature('OFFICIAL_B','morningCampus'),false);
  assert.equal(core.canUseFeature('OFFICIAL_A','weather'),true);
  assert.equal(core.status().groupCount,2);
});

test('official SDK join appears in the console with every feature disabled and no outbound action',async()=>{
  let saved=initial();
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),async init(){},
    async readCredentials(){return {appId:'12345',appSecret:'fixture-secret'};},
    async loadState(){return structuredClone(saved);},async saveState(value){saved=structuredClone(value);}};
  const handlers=new Map();
  let finish;
  const bot={on:(name,fn)=>handlers.set(name,fn),start:()=>new Promise(resolve=>{finish=resolve;}),
    stop:()=>finish?.(),send:()=>assert.fail('Discovery must be silent')};
  const app=await createBridgeServer({port:0,store,campusService:{status:async()=>({enabled:false}),close(){}},
    conversationAgent:{handle:async()=>assert.fail('Disabled group must not use tools or chat')},
    adapterFactory:options=>new QQAdapter({...options,createBot:()=>bot})});
  const port=await app.listen();
  const request=async (route,body)=>{
    const response=await fetch(`http://127.0.0.1:${port}/api/${route}`,{
      method:body?'POST':'GET',headers:{Authorization:'Bearer '+store.token,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    assert.equal(response.status,200);
    return response.json();
  };
  const ts=Math.floor(Date.now()/1000);
  const join=async (type,groupId,timestamp=ts)=>{
    const event=dispatchEvent(type,{group_openid:groupId,op_member_openid:'SOME_MEMBER',timestamp},'fixture');
    assert.equal(event.action,'raw');
    await handlers.get('rawEvent')({eventType:event.type,data:event.data});
  };
  const say=async (groupId,id,content,type='GROUP_MESSAGE_CREATE',at=Date.now())=>{
    const {msg}=dispatchEvent(type,{id,group_openid:groupId,author:{member_openid:'SOME_MEMBER'},
      timestamp:new Date(at).toISOString(),content},'fixture');
    await handlers.get('message')({}, {...msg,replyTarget:{scope:'group',targetId:groupId,msgId:id}});
  };
  try{
    await app.adapter.connect(await store.readCredentials());
    handlers.get('ready')();
    await join('GROUP_MEMBER_ADD','NOT_A_BOT_JOIN');
    await join('GROUP_ADD_ROBOT','OLD_EVENT',ts-3600);
    assert.equal(app.adapter.diagnostics().lastGroupJoin.decision,'GROUP_JOIN_EXPIRED');
    const groupId='OFFICIAL_NEW';
    await Promise.all([join('GROUP_ADD_ROBOT',groupId,String(ts)),join('GROUP_ADD_ROBOT',groupId)]);
    const status=await request('status');
    const logPath='group/'+key(groupId)+'/delivery-log';
    assert.deepEqual(await request(logPath),{ok:true,code:'OK',entries:[]});
    const headers={Authorization:'Bearer '+store.integrationToken};
    assert.equal((await fetch('http://127.0.0.1:'+port+'/api/'+logPath,{headers})).status,403);
    assert.equal((await fetch('http://127.0.0.1:'+port+'/api/group/'+key('absent')+'/delivery-log',
      {headers:{Authorization:'Bearer '+store.token}})).status,404);
    assert.equal(status.core.groupCount,2);
    const group=status.core.allowedGroups.find(g=>g.groupKey===key(groupId));
    assert.match(group.name,/^新加入群 · [a-f0-9]{8}$/);
    assert.equal(group.enabled,false);
    assert.deepEqual(group.features,Object.fromEntries(Object.keys(defaultGroupFeatures('white')).map(k=>[k,false])));
    assert.equal(app.core.canDeliver({groupId,proactiveGroup:true}),false);
    assert.equal((await app.core.handleMessage(incoming(groupId,'test','/help'))).code,'GROUP_DISABLED');
    assert.equal(saved.attempts.length,0);
    assert.equal(saved.incoming.length,1);

    const features={...group.features,weather:true};
    assert.equal((await request('group/features',{groupKey:group.groupKey,enabled:true,features})).code,'GROUP_FEATURES_SAVED');
    await join('GROUP_ADD_ROBOT',groupId,ts+1);
    assert.equal(app.core.groupEnabled(groupId),true);
    assert.deepEqual(app.core.groupFeatures(groupId),features);

    assert.equal((await request('group/remove',{groupKey:group.groupKey})).ok,true);
    await say(groupId,'REMOVED_MESSAGE','已移除的群仍有消息');
    assert.equal(app.adapter.diagnostics().lastGroupObservation.decision,'GROUP_DISCOVERY_REMOVED');
    const restarted=new BridgeCore({loadState:store.loadState,saveState:store.saveState,send:async()=>assert.fail('No send')});
    await restarted.init();
    assert.equal((await restarted.recordOfficialGroupJoin({groupId,joinedAt:(ts+1)*1000,isCurrent:()=>true})).code,'DUPLICATE');
    assert.equal((await restarted.recordOfficialGroupJoin({groupId,joinedAt:Date.now(),messageId:'AFTER_RESTART',isCurrent:()=>true})).code,'GROUP_DISCOVERY_REMOVED');
    assert.equal(restarted.status().groupCount,1);

    await say('OLD_GROUP','OLD_MESSAGE','历史群消息','GROUP_MESSAGE_CREATE',Date.now()-3600_000);
    assert.equal(app.core.status().groupCount,1);
    await say('MISSED_JOIN','OBSERVED','/help','GROUP_AT_MESSAGE_CREATE');
    const discovered=(await request('status')).core.allowedGroups.find(g=>g.groupKey===key('MISSED_JOIN'));
    assert.equal(discovered.enabled,false);
    assert.deepEqual(discovered.features,group.features);
    assert.equal(app.adapter.diagnostics().lastGroupObservation.decision,'GROUP_JOIN_RECORDED');
    assert.doesNotMatch(JSON.stringify(app.adapter.diagnostics()),/MISSED_JOIN|SOME_MEMBER|OBSERVED|\/help/);

    const pairing=await app.core.startGroupPairing({name:'手动匹配的群'});
    await say('MANUAL_GROUP','PAIR','/group-bind '+pairing.groupPairingCode,'GROUP_AT_MESSAGE_CREATE');
    assert.equal((await request('group/confirm',{groupKey:key('MANUAL_GROUP'),features:basicGroupFeatures()})).ok,true);
    assert.equal(saved.attempts.length,0);

    await app.adapter.disconnect();
    await join('GROUP_ADD_ROBOT','STALE_CONNECTION');
    assert.equal(app.core.status().groupCount,3);
  }finally{await app.close();}
});

test('official SDK uses the live global dictionary for duplicate admission and per-group switches',async()=>{
  let saved=initial();saved.allowedGroups.push({id:'OFFICIAL_B',name:'另一个群'});
  const now=Date.parse('2026-11-03T01:00:00Z'),pending=[],queries=[];let core;
  const fake={handlers:new Map(),on(name,callback){this.handlers.set(name,callback);},
    start(){return new Promise(resolve=>{this.finish=resolve;});},stop(){this.finish?.();}};
  const adapter=new QQAdapter({createBot:()=>fake,now:()=>now,
    groupAddressed:(groupId,text)=>core.addressesGroupMessage(groupId,text),
    onMessage:message=>{const p=core.handleMessage(message);pending.push(p);return p;}});
  core=new BridgeCore({loadState:async()=>saved,saveState:async value=>{saved=structuredClone(value);},now:()=>now,
    send:async()=>({ok:true}),commandHandler:async text=>{queries.push(text);return {text:'回复'};}});
  await core.init();
  await core.changeWakeWord({operation:'add',text:'a+b',revision:core.status().wakeWordRevision});
  const word=core.status().wakeWords.at(-1);
  await core.setGroupWakeWords({groupKey:key('OFFICIAL_B'),disabledWakeWords:[word.id],revision:core.status().wakeWordRevision});
  await adapter.connect({appId:'12345',appSecret:'fixture-secret'});fake.handlers.get('ready')();
  const emit=async(type,id,groupId,content)=>{
    const event={id,group_openid:groupId,content,author:{member_openid:'GROUP_MEMBER_OPENID'},timestamp:new Date(now).toISOString()};
    const {msg}=dispatchEvent(type,event,'fixture');
    fake.handlers.get('message')({}, {...msg,replyTarget:{scope:'group',targetId:groupId,msgId:id}});
    await Promise.all(pending.splice(0));
  };
  try{
    await emit('GROUP_MESSAGE_CREATE','one','OFFICIAL_A','A+B 你好');
    await emit('GROUP_AT_MESSAGE_CREATE','one','OFFICIAL_A','A+B 你好');
    assert.deepEqual(queries,['你好']);
    await emit('GROUP_MESSAGE_CREATE','two','OFFICIAL_B','a+b 你好');
    assert.deepEqual(queries,['你好']);
    await emit('GROUP_AT_MESSAGE_CREATE','two','OFFICIAL_B','直接提问');
    assert.deepEqual(queries,['你好','直接提问']);
    await core.changeWakeWord({operation:'rename',id:word.id,text:'小鲸鱼',revision:core.status().wakeWordRevision});
    await emit('GROUP_MESSAGE_CREATE','three','OFFICIAL_A','小鲸鱼 新问题');
    await emit('GROUP_MESSAGE_CREATE','four','OFFICIAL_B','小鲸鱼 新问题');
    assert.deepEqual(queries,['你好','直接提问','新问题']);
    assert.deepEqual(core.status().allowedGroups[1].disabledWakeWords,[word.id]);
  }finally{await adapter.disconnect();}
});

test('official admin API preserves identity while saving words and confirming a least-privilege group',async()=>{
  let saved=initial(),status='connected';
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),
    async init(){},async readCredentials(){return {appId:'12345',appSecret:'fixture-secret'};},
    async loadState(){return structuredClone(saved);},async saveState(value){saved=structuredClone(value);}};
  const app=await createBridgeServer({port:0,store,campusService:{status:async()=>({enabled:false}),close(){}},
    adapterFactory:()=>({status:()=>({state:status}),async connect(){status='connected';},async disconnect(){status='disconnected';},async send(){assert.fail('No test sends');}})});
  const port=await app.listen();
  const request=(path,body,token=store.token)=>new Promise((resolve,reject)=>{
    const raw=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=http.request({host:'127.0.0.1',port,path:'/api/'+path,method:raw?'POST':'GET',headers:{Authorization:'Bearer '+token,...(raw?{'Content-Type':'application/json','Content-Length':raw.length}:{})}},res=>{
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,...JSON.parse(data)}));
    });req.on('error',reject);req.end(raw);
  });
  try{
    assert.equal((await request('wake-words/add',{text:'鲸鱼',revision:app.core.status().wakeWordRevision},store.integrationToken)).status,403);
    assert.equal((await request('group/start',{name:'未授权'},store.integrationToken)).status,403);
    assert.equal((await request('wake-words/add',{text:'鲸鱼',revision:app.core.status().wakeWordRevision})).code,'WAKE_WORDS_SAVED');
    const started=await request('group/start',{name:'新增群'});
    await app.core.handleMessage(incoming('OFFICIAL_B','candidate','/group-bind '+started.groupPairingCode));
    assert.equal((await request('group/confirm',{groupKey:key('OFFICIAL_B'),features:basicGroupFeatures(),account:'not-allowed'})).status,400);
    assert.equal((await request('group/confirm',{groupKey:key('OFFICIAL_B'),features:basicGroupFeatures()})).code,'GROUP_ALLOWED');
    assert.deepEqual(saved.allowedGroups[1].features,basicGroupFeatures());
    assert.equal(saved.ownerId,'PRIVATE_OWNER');assert.equal(saved.identityDomain,undefined);
    assert.equal(app.core.captureMorningTargets().length,0);
    assert.deepEqual(app.core.groupFeatures('OFFICIAL_A'),defaultGroupFeatures('white'));
    for (const part of ['morningWeather','morningCampus']) {
      assert.equal((await request('group/features',{groupKey:key('OFFICIAL_B'),enabled:true,
        features:{...basicGroupFeatures(),[part]:true}})).code,'GROUP_FEATURES_SAVED');
      const status=await request('status');
      assert.equal(status.groupMorning.enabledGroups,1);
      assert.equal(status.groupMorning.weatherGroups,Number(part==='morningWeather'));
      assert.equal(status.groupMorning.campusGroups,Number(part==='morningCampus'));
    }
    const settings={groupKey:key('OFFICIAL_B'),enabled:true,features:{...basicGroupFeatures(),chat:false}};
    const helpNote='本群优先使用天气查询。\n查询时带上地点。';
    assert.equal((await request('group/features',{...settings,helpNote},store.integrationToken)).status,403);
    for (const invalid of [null,'字'.repeat(241),'一\n二\n三\n四\n五\n六\n七','前\u0000后']) {
      assert.equal((await request('group/features',{...settings,helpNote:invalid})).code,'GROUP_HELP_NOTE_INVALID');
    }
    assert.equal(saved.groupHelpNotes,undefined);
    assert.equal((await request('group/features',{...settings,helpNote:'  '+helpNote.replace('\n','\r\n')+'  '})).code,'GROUP_FEATURES_SAVED');
    assert.equal((await request('group/features',settings)).code,'GROUP_FEATURES_SAVED');
    const restored=new BridgeCore({loadState:store.loadState,saveState:store.saveState,send:async()=>assert.fail('No send')});
    await restored.init();
    assert.equal(restored.status().allowedGroups[0].helpNote,undefined);
    assert.equal(restored.status().allowedGroups[1].helpNote,helpNote);
    assert.equal((await request('status',undefined,store.integrationToken)).core.allowedGroups[1].helpNote,undefined);
    assert.equal((await request('group/features',{...settings,helpNote:''})).code,'GROUP_FEATURES_SAVED');
    assert.equal((await request('status')).core.allowedGroups[1].helpNote,'');
  }finally{await app.close();}
});
