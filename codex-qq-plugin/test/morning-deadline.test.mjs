import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';
import {QQAdapter} from '../src/qq-adapter.mjs';
import {basicGroupFeatures} from '../src/group-features.mjs';

const deadline=Date.parse('2026-11-03T07:40:00+08:00');
const image={buffer:Buffer.from([137,80,78,71,13,10,26,10]),mimeType:'image/png'};
async function fixture({send=async()=>({ok:true}),groups=1}={}){
  const clock={value:deadline-1000};
  let state={version:1,ownerId:'OWNER',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:Array.from({length:groups},(_,index)=>({id:'GROUP_'+index,name:'群'+index,features:{...basicGroupFeatures(),morningWeather:true}})),grayGroups:[]};
  const options={now:()=>clock.value,loadState:async()=>structuredClone(state),saveState:async value=>{state=structuredClone(value);},send};
  const core=new BridgeCore(options);await core.init();
  const notify=extra=>core.notifyImageAllAllowed({image,idempotencyKey:'group-morning-2026-11-03-weather',groupsOnly:true,
    requiredFeature:'morningWeather',groupTargets:core.captureMorningTargets(),deliveryDeadline:deadline,...extra});
  return {core,clock,notify,options,saved:()=>state};
}

test('morning image waiting behind a core operation expires before any upload or attempt',async()=>{
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),blocked=new Promise(resolve=>{release=resolve;});
  const sent=[];
  const f=await fixture({send:async request=>{sent.push(request);enter();await blocked;return {ok:true};}});
  const first=f.core.notify({text:'offline queue blocker',idempotencyKey:'blocker'});await entered;
  const morning=f.notify();f.clock.value=deadline;release();await first;
  const result=await morning;
  assert.equal(result.code,'REQUEST_EXPIRED');assert.equal(result.attempted,0);assert.equal(result.sent,0);
  assert.equal(sent.length,1);assert.equal(f.saved().attempts.length,1);
  assert.equal(f.saved().deliveries.length,1);assert.equal(f.core.status().paused,false);
});

test('deadline is checked separately before each group in the same broadcast',async()=>{
  const sent=[];let f;
  f=await fixture({groups:2,send:async request=>{sent.push(request);f.clock.value=deadline;return {ok:true};}});
  const result=await f.notify();
  assert.equal(result.code,'REQUEST_EXPIRED');assert.equal(result.attempted,1);assert.equal(result.sent,1);
  assert.deepEqual(result.results.map(row=>row.code),['SENT','REQUEST_EXPIRED']);
  assert.equal(sent.length,1);assert.equal(sent[0].deliveryDeadline,deadline);assert.equal(f.saved().deliveries.length,1);
});

test('deadline validation is bounded and omission retains the previous send contract',async()=>{
  const sent=[],f=await fixture({send:async request=>{sent.push(request);return {ok:true};}});
  for(const value of [null,'2026-11-03',NaN,Infinity,-1,deadline+.5,Number.MAX_SAFE_INTEGER]){
    assert.equal((await f.notify({deliveryDeadline:value})).code,'INVALID_INPUT');
    assert.equal(f.core.canDeliver({deliveryDeadline:value}),false);
  }
  assert.equal(sent.length,0);
  assert.equal(f.core.canDeliver({deliveryDeadline:deadline}),true);
  f.clock.value=deadline;assert.equal(f.core.canDeliver({deliveryDeadline:deadline}),false);
  assert.equal((await f.notify({deliveryDeadline:undefined})).code,'SENT');
  assert.equal(Object.hasOwn(sent[0],'deliveryDeadline'),false);
});

class FakeBot {
  handlers=new Map();uploads=[];messages=[];beforeUpload=async()=>{};
  on(event,callback){this.handlers.set(event,callback);}
  start(){return new Promise(resolve=>{this.finish=resolve;});}
  stop(){this.finish?.();}
  api={post:async(path,body)=>{this.uploads.push({path,body});await this.beforeUpload();return {file_info:'offline-fixture-reference'};}};
  async send(value){this.messages.push(value);return {id:'offline-message'};}
  async sendText(target,text){this.messages.push({target,text});return {id:'offline-message'};}
}

test('a media upload crossing 07:40 never submits a message and persists a settled expiry',async t=>{
  const bot=new FakeBot(),guards=[];let f;
  const adapter=new QQAdapter({createBot:()=>bot,now:()=>f.clock.value,canSend:request=>{
    guards.push(request);return f.core.canDeliver(request);
  }});
  t.after(()=>adapter.disconnect());
  f=await fixture({send:request=>adapter.send(request)});
  await adapter.connect({appId:'123',appSecret:'offline-fixture'});await bot.handlers.get('ready')();
  bot.beforeUpload=async()=>{f.clock.value=deadline;};
  const result=await f.notify();
  assert.equal(result.code,'REQUEST_EXPIRED');assert.equal(result.sent,0);assert.equal(result.attempted,1);
  assert.equal(bot.uploads.length,1);assert.equal(bot.uploads[0].body.srv_send_msg,false);assert.equal(bot.messages.length,0);
  assert.equal(guards.length,2);assert.ok(guards.every(request=>request.deliveryDeadline===deadline));
  assert.equal(f.core.status().paused,false);assert.equal(f.core.status().uncertainDeliveries,0);
  assert.equal(f.saved().deliveries[0].state,'rejected');assert.equal(f.saved().deliveries[0].code,'PLATFORM_REJECTED');
  const restarted=new BridgeCore(f.options);await restarted.init();
  assert.equal(restarted.status().lastDeliveryCode,'PLATFORM_REJECTED');assert.equal(restarted.status().paused,false);
});

test('adapter checks an already expired deadline before upload even without a host guard',async t=>{
  const bot=new FakeBot(),adapter=new QQAdapter({createBot:()=>bot,now:()=>deadline});t.after(()=>adapter.disconnect());
  await adapter.connect({appId:'123',appSecret:'offline-fixture'});await bot.handlers.get('ready')();
  await assert.rejects(adapter.send({ownerId:'OWNER',groupId:'GROUP',text:'',image,proactiveGroup:true,deliveryDeadline:deadline}),
    {code:'QQ_REQUEST_EXPIRED',messageAttempted:false,phase:'upload'});
  assert.equal(bot.uploads.length,0);assert.equal(bot.messages.length,0);
});
