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
  }finally{await app.close();}
});
