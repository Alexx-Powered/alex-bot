import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {BridgeCore} from '../src/core.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {basicGroupFeatures,defaultGroupFeatures} from '../src/group-features.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversionToolbox} from '../src/conversion-tools.mjs';
import {APP_ROOT} from '../src/runtime-paths.mjs';

const groupId='qq_100001_g_200001',ownerId='qq_100001_u_100002';
const groupKey=createHash('sha256').update('group:'+groupId).digest('hex');
const message=(id,text)=>({kind:'group',groupId,senderId:'qq_100001_u_100003',id,text,mentioned:true,replyTarget:{scope:'group',targetId:groupId,msgId:id}});
function state(features=basicGroupFeatures()) {
  return {version:1,ownerId,paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,allowedGroups:[{id:groupId,name:'测试群',features}],grayGroups:[]};
}
async function fixture({handler,observe,features}={}) {
  let saved=state(features);const sent=[];
  const core=new BridgeCore({loadState:async()=>saved,saveState:async value=>{saved=structuredClone(value);},
    send:async value=>{sent.push(value);return {ok:true};},commandHandler:handler,observeMessage:observe});
  await core.init();
  return {core,sent,saved:()=>structuredClone(saved)};
}

test('hidden feature retains saved permission and stays out of the displayed catalog',async()=>{
  for(const budget of [false,true]){
    const f=await fixture({features:{...basicGroupFeatures(),budget}});
    assert.equal(f.core.status().groupFeatureCatalog.some(item=>item.key==='budget'),false);
    assert.equal(f.core.status().allowedGroups[0].features.budget,budget);
    const features={...f.core.status().allowedGroups[0].features,conversion:false};
    await f.core.setGroupFeatures({groupKey,features,enabled:true});
    assert.equal(f.core.canUseFeature(groupId,'budget'),budget);
    assert.equal(f.saved().allowedGroups[0].features.budget,budget);
  }
});

test('per-group switches persist, reject malformed masks and leave legacy defaults intact',async()=>{
  const f=await fixture();
  const features={...basicGroupFeatures(),weather:true,chat:false};
  assert.equal((await f.core.setGroupFeatures({groupKey,features,enabled:false})).code,'GROUP_FEATURES_SAVED');
  const restored=new BridgeCore({loadState:async()=>f.saved(),saveState:async()=>{},send:async()=>assert.fail()});
  await restored.init();assert.equal(restored.groupEnabled(groupId),false);
  assert.deepEqual(restored.status().allowedGroups[0].features,features);
  assert.equal((await f.core.setGroupFeatures({groupKey,features:{weather:true},enabled:true})).code,'INVALID_INPUT');
  const legacy=f.saved();delete legacy.allowedGroups[0].features;delete legacy.allowedGroups[0].enabled;
  const old=new BridgeCore({loadState:async()=>legacy,saveState:async()=>{},send:async()=>{}});
  await old.init();assert.deepEqual(old.status().allowedGroups[0].features,defaultGroupFeatures('white'));
});

test('closing a group during a query invalidates late replies before persistence queue drains',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),work=new Promise(r=>{release=r;});
  const f=await fixture({features:{...basicGroupFeatures(),weather:true},handler:async(_t,c)=>{
    entered();await work;assert.equal(c.allowsFeature('weather'),false);return {text:'result',requiredFeature:'weather'};
  }});
  const pending=f.core.handleMessage(message('1','北京天气'));await started;
  const update=f.core.setGroupFeatures({groupKey,features:basicGroupFeatures(),enabled:true});
  assert.equal(f.core.canUseFeature(groupId,'weather'),false);
  release();assert.equal((await pending).code,'GROUP_ACCESS_DENIED');await update;assert.equal(f.sent.length,0);
});

test('whole-group pause suppresses background observations and notification participation',async()=>{
  let observed=0;const f=await fixture({observe:()=>{observed++;}});
  await f.core.setGroupFeatures({groupKey,features:basicGroupFeatures(),enabled:false});
  assert.equal((await f.core.handleMessage(message('1','你好'))).code,'GROUP_DISABLED');
  assert.equal(observed,0);
  await f.core.notifyAllAllowed({text:'owner test',idempotencyKey:'owner-only'});
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].groupId,undefined);
});

test('disabled deterministic conversion never crosses into Python; an enabled conversion still runs real LangChain',async t=>{
  const worker=new PythonAgentWorker({home:APP_ROOT}),conversionTools=new ConversionToolbox(worker);
  t.after(()=>worker.close());
  let calls=0;
  const agent=new ConversationAgent({conversionTools:{handle:async(...args)=>{calls++;return conversionTools.handle(...args);}},
    toolbox:{handle:async()=>null},modelBudget:{acquire:async()=>assert.fail()},configStore:{read:async()=>({enabled:false})}});
  const context={scope:'group',access:'white',features:{...basicGroupFeatures(),conversion:false}};
  assert.match((await agent.handle('1马里换公里',context)).text,/未开放/);assert.equal(calls,0);
  context.features.conversion=true;
  assert.equal((await agent.handle('1马里换公里',context)).text,'1 马里 = 3.08 km');assert.equal(calls,1);
});

test('the admin console can bind only a current gateway group and integration tokens cannot manage it',async t=>{
  let saved=null,rows=[{id:groupId,name:'同名群 <安全文字>',number:'200001'}];
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>saved,saveState:async v=>{saved=structuredClone(v);}};
  const app=await createBridgeServer({port:0,store,oneBotProfile:{selfId:'100001',token:'c'.repeat(64),mode:'normal'},
    adapterFactory:()=>({status:()=>({state:'connected',protocol:'onebot11',mode:'normal'}),listGroups:async()=>rows,disconnect:async()=>{}})});
  t.after(()=>app.close());
  const pair=await app.core.startPairing();await app.core.handleMessage({kind:'c2c',id:'pair',senderId:ownerId,text:'/pair '+pair.pairingCode});await app.core.confirmPairing();
  const port=await app.listen();
  const request=(route,body,token=store.token)=>fetch('http://127.0.0.1:'+port+'/api/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await request('group/directory',undefined,store.integrationToken)).status,403);
  const directory=await(await request('group/directory')).json();assert.equal(directory.groups[0].groupKey,groupKey);
  assert.equal(app.core.status().groupCount,0);
  rows=[];assert.equal((await(await request('group/bind',{groupKey,features:basicGroupFeatures()})).json()).code,'GROUP_DIRECTORY_CHANGED');
  rows=[{id:groupId,name:'同名群 <安全文字>',number:'200001'}];
  assert.equal((await(await request('group/bind',{groupKey,features:basicGroupFeatures()})).json()).code,'GROUP_ALLOWED');
  assert.equal(app.core.status().allowedGroups[0].features.balance,false);
  assert.equal((await request('group/features',{groupKey,features:basicGroupFeatures(),enabled:false},store.integrationToken)).status,403);
  assert.equal((await(await request('group/features',{groupKey,features:basicGroupFeatures(),enabled:false})).json()).code,'GROUP_FEATURES_SAVED');
});

test('image understanding works independently when group model chat is disabled',async()=>{
  const agent=new ConversationAgent({modelBudget:{acquire:async()=>assert.fail()},
    socialService:{prepare:async()=>({media:{kind:'image',description:'图中是一条鱼',visible_text:'42'}})}});
  const features={...basicGroupFeatures(),chat:false,images:true};
  assert.deepEqual(await agent.handle('/识图',{scope:'group',access:'white',features}),{
    text:'图中是一条鱼\n42',requiredAccess:'chat',requiredFeature:'images',
  });
});
