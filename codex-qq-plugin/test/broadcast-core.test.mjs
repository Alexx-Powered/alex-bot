import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCore } from '../src/core.mjs';

function fixture({ send } = {}) {
  const storage={value:null}, clock={value:Date.parse('2026-10-28T01:00:00Z')}, sent=[];
  const deps={limits:{dailyAttempts:20,minuteAttempts:3,reservedNotifications:0},loadState:async()=>structuredClone(storage.value),saveState:async state=>{storage.value=structuredClone(state);},
    now:()=>clock.value,send:async request=>{sent.push(request);return send?send(request,sent.length):{ok:true};}};
  return {core:new BridgeCore(deps),deps,storage,clock,sent};
}
async function ready(f, groups=1) {
  await f.core.init();
  const pair=await f.core.startPairing();
  await f.core.handleMessage({kind:'c2c',id:'owner-pair',senderId:'OWNER_PRIVATE_ID',text:'/pair '+pair.pairingCode});
  await f.core.confirmPairing();
  for(let i=0;i<groups;i++){
    const binding=await f.core.startGroupPairing({name:`测试群${i+1}`});
    await f.core.handleMessage({kind:'group',groupId:`GROUP_PRIVATE_${i}`,id:`bind-${i}`,senderId:'MEMBER_PRIVATE_ID',
      text:'/group-bind '+binding.groupPairingCode,replyTarget:{scope:'group',targetId:`GROUP_PRIVATE_${i}`,msgId:`bind-${i}`}});
    await f.core.confirmGroupPairing({groupKey:f.core.status().pendingGroup.groupKey});
  }
}
const message={text:'离线测试完成摘要',idempotencyKey:'operation-summary-1'};

test('broadcast fails closed before pairing and while paused',async()=>{
  const f=fixture();await f.core.init();
  assert.deepEqual(await f.core.notifyAllAllowed(message),{ok:false,code:'NOT_PAIRED',results:[],attempted:0,sent:0});
  await ready(f);await f.core.setPaused(true);
  const result=await f.core.notifyAllAllowed(message);
  assert.equal(result.code,'PAUSED');assert.equal(result.results.length,2);assert.equal(result.attempted,0);
  assert.ok(result.results.every(item=>item.code==='PAUSED'));assert.equal(f.sent.length,0);
});

test('broadcast enumerates only persisted owner and groups, uses distinct durable keys and no payload targets',async()=>{
  const f=fixture();await ready(f);
  const result=await f.core.notifyAllAllowed({...message,ownerId:'ATTACKER',groupId:'ATTACKER_GROUP',proactiveGroup:true});
  assert.deepEqual(result,{ok:true,code:'SENT',results:[{destination:'owner',ok:true,code:'SENT'},
    {destination:'测试群1',ok:true,code:'SENT'}],attempted:2,sent:2});
  assert.deepEqual(f.sent,[{ownerId:'OWNER_PRIVATE_ID',text:message.text},
    {ownerId:'OWNER_PRIVATE_ID',text:message.text,groupId:'GROUP_PRIVATE_0',proactiveGroup:true}]);
  assert.equal(f.storage.value.deliveries.length,2);
  assert.equal(new Set(f.storage.value.deliveries.map(entry=>entry.key)).size,2);
  assert.doesNotMatch(JSON.stringify(result),/OWNER_PRIVATE|GROUP_PRIVATE|MEMBER_PRIVATE/);
  assert.ok(!JSON.stringify(f.storage.value).includes(message.text));
  assert.ok(!JSON.stringify(f.storage.value).includes(message.idempotencyKey));
  const restarted=new BridgeCore(f.deps);await restarted.init();
  const duplicate=await restarted.notifyAllAllowed(message);
  assert.equal(duplicate.code,'DUPLICATE');assert.equal(duplicate.attempted,0);
  assert.ok(duplicate.results.every(item=>item.code==='DUPLICATE'&&item.deliveryState==='sent'));
  assert.equal(f.sent.length,2);
});

test('ordinary public notifications cannot smuggle proactive groups',async()=>{
  const f=fixture();await ready(f);
  assert.equal((await f.core.notify({...message,groupId:'GROUP_PRIVATE_0',proactiveGroup:true})).code,'SENT');
  assert.deepEqual(f.sent,[{ownerId:'OWNER_PRIVATE_ID',text:message.text}]);
});

test('broadcast preflights the entire minute allowance and never sends a partial budget fit',async()=>{
  const f=fixture();await ready(f);
  for(let i=0;i<2;i++)await f.core.notify({text:'earlier',idempotencyKey:`earlier-${i}`});
  const before=structuredClone(f.storage.value);
  const result=await f.core.notifyAllAllowed(message);
  assert.equal(result.code,'RATE_LIMIT_MINUTE');assert.equal(result.attempted,0);assert.equal(result.sent,0);
  assert.ok(result.results.every(item=>item.code==='RATE_LIMIT_MINUTE'));
  assert.deepEqual(f.storage.value,before);assert.equal(f.sent.length,2);
  f.clock.value+=60001;
  assert.equal((await f.core.notifyAllAllowed(message)).sent,2);
});

test('broadcast preflights the daily allowance, including exactly full twenty-attempt state',async()=>{
  const f=fixture();await ready(f);
  for(let i=0;i<19;i++){
    assert.equal((await f.core.notify({text:'earlier',idempotencyKey:`daily-${i}`})).code,'SENT');
    f.clock.value+=60001;
  }
  const before=structuredClone(f.storage.value);
  assert.equal((await f.core.notifyAllAllowed(message)).code,'RATE_LIMIT_DAY');
  assert.equal(f.sent.length,19);assert.deepEqual(f.storage.value,before);
  await f.core.notify({text:'last allowance',idempotencyKey:'daily-20'});f.clock.value+=60001;
  const result=await f.core.notifyAllAllowed(message);
  assert.equal(result.code,'RATE_LIMIT_DAY');assert.equal(result.attempted,0);assert.equal(result.sent,0);
  assert.equal(f.sent.length,20);assert.equal(f.core.status().dailyAttempts,20);
});

test('concurrent broadcasts share the serial queue and cannot exceed the shared allowance',async()=>{
  const f=fixture();await ready(f);
  const results=await Promise.all([f.core.notifyAllAllowed(message),f.core.notifyAllAllowed({...message,idempotencyKey:'second-operation'})]);
  assert.deepEqual(results.map(item=>item.code),['SENT','RATE_LIMIT_MINUTE']);assert.equal(f.sent.length,2);
});

test('owner failure pauses and stops all later destinations without retry',async()=>{
  const f=fixture({send:async()=>{throw new Error('SECRET_RAW_NETWORK_ERROR');}});await ready(f,2);
  const result=await f.core.notifyAllAllowed(message);
  assert.equal(result.code,'DELIVERY_UNCERTAIN');assert.equal(result.attempted,1);assert.equal(result.sent,0);
  assert.deepEqual(result.results.map(item=>item.code),['DELIVERY_UNCERTAIN','PAUSED','PAUSED']);
  assert.equal(result.results[0].deliveryState,'uncertain');assert.equal(f.core.status().paused,true);
  assert.equal(f.sent.length,1);assert.doesNotMatch(JSON.stringify(result),/SECRET_RAW/);
  const restarted=new BridgeCore(f.deps);await restarted.init();
  const retry=await restarted.notifyAllAllowed(message);
  assert.equal(retry.code,'PAUSED');assert.equal(retry.results[0].code,'DUPLICATE');
  assert.equal(retry.results[0].deliveryState,'uncertain');assert.equal(f.sent.length,1);
});

test('group rejection preserves owner success, pauses and stops later groups',async()=>{
  const f=fixture({send:async(_request,count)=>{if(count===2)throw Object.assign(new Error('private'),{httpStatus:403});return {ok:true};}});
  await ready(f,2);
  const result=await f.core.notifyAllAllowed(message);
  assert.equal(result.code,'PERMISSION_DENIED');assert.equal(result.sent,1);assert.equal(result.attempted,2);
  assert.deepEqual(result.results.map(item=>item.code),['SENT','PERMISSION_DENIED','PAUSED']);
  assert.equal(result.results[1].deliveryState,'rejected');assert.equal(f.sent.length,2);
});

test('pause requested during first delivery prevents the next destination',async()=>{
  let enter,release;
  const entered=new Promise(resolve=>{enter=resolve;});
  const f=fixture({send:async()=>{enter();await new Promise(resolve=>{release=resolve;});return {ok:true};}});await ready(f);
  const sending=f.core.notifyAllAllowed(message);await entered;
  const pausing=f.core.setPaused(true);release();
  const result=await sending;await pausing;
  assert.deepEqual(result.results.map(item=>item.code),['SENT','PAUSED']);assert.equal(f.sent.length,1);
});

test('removed groups are excluded from subsequent authorized broadcasts',async()=>{
  const f=fixture();await ready(f);
  await f.core.removeAllowedGroup({groupKey:f.core.status().allowedGroups[0].groupKey});
  const result=await f.core.notifyAllAllowed(message);
  assert.equal(result.results.length,1);assert.equal(result.results[0].destination,'owner');assert.equal(f.sent.length,1);
});

test('a crash before completion leaves the same per-target key uncertain and cannot duplicate it',async()=>{
  const f=fixture();await ready(f,0);
  await f.core.notifyAllAllowed(message);
  f.storage.value.deliveries[0].state='inFlight';f.storage.value.deliveries[0].code='SENDING';
  const restarted=new BridgeCore(f.deps);await restarted.init();
  const result=await restarted.notifyAllAllowed(message);
  assert.equal(result.code,'DUPLICATE');assert.equal(result.results[0].deliveryState,'uncertain');assert.equal(f.sent.length,1);
});
