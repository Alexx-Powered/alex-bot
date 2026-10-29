import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeCore } from '../src/core.mjs';

const png = () => ({ buffer: Buffer.from('89504e470d0a1a0a0000000049454e44ae426082','hex'), mimeType:'image/png' });
function fixture({send,limits={dailyAttempts:10,minuteAttempts:3,reservedNotifications:0}}={}) {
  const storage={value:null},clock={value:Date.parse('2026-10-29T01:00:00Z')},sent=[];
  const deps={limits,loadState:async()=>structuredClone(storage.value),saveState:async state=>{storage.value=structuredClone(state);},
    now:()=>clock.value,send:async request=>{sent.push(request);return send?send(request,sent.length):{ok:true};}};
  return {core:new BridgeCore(deps),deps,storage,clock,sent};
}
async function ready(f) {
  await f.core.init();
  const pair=await f.core.startPairing();
  await f.core.handleMessage({kind:'c2c',id:'pair-owner',senderId:'OWNER_PRIVATE',text:'/pair '+pair.pairingCode});
  await f.core.confirmPairing();
  const binding=await f.core.startGroupPairing({name:'本地测试群'});
  await f.core.handleMessage({kind:'group',groupId:'GROUP_PRIVATE',id:'bind-group',senderId:'GROUP_MEMBER',
    text:'/group-bind '+binding.groupPairingCode,replyTarget:{scope:'group',targetId:'GROUP_PRIVATE',msgId:'bind-group'}});
  await f.core.confirmGroupPairing({groupKey:f.core.status().pendingGroup.groupKey});
}

test('generated image broadcast uses the same in-memory image for owner and allowed group with no text or mentions',async()=>{
  const f=fixture();await ready(f);const image=png();
  const result=await f.core.notifyImageAllAllowed({image,idempotencyKey:'morning-image-test',text:'@someone',ownerId:'OTHER',groupId:'OTHER_GROUP'});
  assert.equal(result.code,'SENT');assert.equal(result.attempted,2);assert.equal(result.sent,2);
  assert.deepEqual(f.sent,[{ownerId:'OWNER_PRIVATE',text:'',image},{ownerId:'OWNER_PRIVATE',text:'',image,groupId:'GROUP_PRIVATE',proactiveGroup:true}]);
  assert.strictEqual(f.sent[0].image,image);assert.strictEqual(f.sent[1].image.buffer,image.buffer);
  assert.ok(f.sent.every(item=>!Object.hasOwn(item,'replyTarget')&&item.text===''));
  assert.equal(f.core.status().dailyAttempts,2);
  assert.doesNotMatch(JSON.stringify(result),/OWNER_PRIVATE|GROUP_PRIVATE|GROUP_MEMBER/);
  assert.doesNotMatch(JSON.stringify(f.storage.value),/image\/png|89504e47|morning-image-test|"buffer"|"text"/);
});

test('image broadcast validates the entire image before sending or claiming any destination',async()=>{
  const f=fixture();await ready(f);const before=structuredClone(f.storage.value);
  const invalid=[undefined,null,'https://example.test/image.png',{path:'C:/private.png',mimeType:'image/png'},
    {buffer:new Uint8Array(8),mimeType:'image/png'},{buffer:Buffer.alloc(7),mimeType:'image/png'},
    {buffer:Buffer.alloc(5*1024*1024+1),mimeType:'image/png'},{buffer:Buffer.alloc(8),mimeType:'image/gif'}];
  for(const image of invalid)assert.deepEqual(await f.core.notifyImageAllAllowed({image,idempotencyKey:'invalid-image'}),
    {ok:false,code:'INVALID_INPUT',results:[],attempted:0,sent:0});
  assert.equal(f.sent.length,0);assert.deepEqual(f.storage.value,before);
  assert.equal((await f.core.notifyImageAllAllowed({image:png(),idempotencyKey:'invalid-image'})).sent,2);
});

test('image broadcast preflights minute quota for all destinations and sends none when only one slot remains',async()=>{
  const f=fixture();await ready(f);
  for(let i=0;i<2;i++)await f.core.notify({text:'earlier',idempotencyKey:'earlier-'+i});
  const before=structuredClone(f.storage.value);
  const result=await f.core.notifyImageAllAllowed({image:png(),idempotencyKey:'minute-image'});
  assert.equal(result.code,'RATE_LIMIT_MINUTE');assert.equal(result.attempted,0);assert.equal(result.sent,0);
  assert.equal(f.sent.length,2);assert.deepEqual(f.storage.value,before);
  f.clock.value+=60001;
  assert.equal((await f.core.notifyImageAllAllowed({image:png(),idempotencyKey:'minute-image'})).sent,2);
});

test('image broadcast preflights day quota without partial delivery or durable key claim',async()=>{
  const f=fixture();await ready(f);
  for(let i=0;i<9;i++){await f.core.notify({text:'earlier',idempotencyKey:'day-'+i});f.clock.value+=60001;}
  const before=structuredClone(f.storage.value);
  const result=await f.core.notifyImageAllAllowed({image:png(),idempotencyKey:'day-image'});
  assert.equal(result.code,'RATE_LIMIT_DAY');assert.equal(result.attempted,0);assert.equal(result.sent,0);
  assert.equal(f.sent.length,9);assert.deepEqual(f.storage.value,before);
});

test('same image broadcast key survives restart and is shared with text broadcasts',async()=>{
  const f=fixture();await ready(f);const key='same-logical-operation';
  assert.equal((await f.core.notifyImageAllAllowed({image:png(),idempotencyKey:key})).sent,2);
  const restarted=new BridgeCore(f.deps);await restarted.init();
  const duplicate=await restarted.notifyImageAllAllowed({image:png(),idempotencyKey:key});
  assert.equal(duplicate.code,'DUPLICATE');assert.equal(duplicate.attempted,0);
  assert.ok(duplicate.results.every(item=>item.code==='DUPLICATE'&&item.deliveryState==='sent'));
  assert.equal((await restarted.notifyAllAllowed({text:'changed body',idempotencyKey:key})).code,'DUPLICATE');
  assert.equal(f.sent.length,2);
});

test('public text broadcast ignores image payloads and still rejects empty text',async()=>{
  const f=fixture();await ready(f);const image=png();
  assert.equal((await f.core.notifyAllAllowed({text:'',image,idempotencyKey:'text-smuggle'})).code,'INVALID_INPUT');
  assert.equal(f.sent.length,0);
  const result=await f.core.notifyAllAllowed({text:'authorized summary',image,idempotencyKey:'text-smuggle'});
  assert.equal(result.sent,2);assert.ok(f.sent.every(item=>!Object.hasOwn(item,'image')&&item.text==='authorized summary'));
});

test('owner image send failure consumes one attempt, pauses, stops the group and never repeats an uncertain delivery',async()=>{
  const f=fixture({send:async()=>{throw new Error('RAW_PRIVATE_ERROR');}});await ready(f);
  const request={image:png(),idempotencyKey:'failed-image'};
  const result=await f.core.notifyImageAllAllowed(request);
  assert.equal(result.code,'DELIVERY_UNCERTAIN');assert.equal(result.attempted,1);assert.equal(result.sent,0);
  assert.deepEqual(result.results.map(item=>item.code),['DELIVERY_UNCERTAIN','PAUSED']);
  assert.equal(f.core.status().dailyAttempts,1);assert.equal(f.core.status().paused,true);assert.equal(f.sent.length,1);
  assert.doesNotMatch(JSON.stringify(result),/RAW_PRIVATE_ERROR/);
  const restarted=new BridgeCore(f.deps);await restarted.init();
  const again=await restarted.notifyImageAllAllowed(request);
  assert.deepEqual(again.results.map(item=>item.code),['DUPLICATE','PAUSED']);
  assert.equal(again.results[0].deliveryState,'uncertain');assert.equal(f.sent.length,1);
});

test('unpaired and paused image broadcasts cannot send',async()=>{
  const f=fixture();await f.core.init();const request={image:png(),idempotencyKey:'blocked-image'};
  assert.equal((await f.core.notifyImageAllAllowed(request)).code,'NOT_PAIRED');
  await ready(f);await f.core.setPaused(true);
  assert.equal((await f.core.notifyImageAllAllowed(request)).code,'PAUSED');assert.equal(f.sent.length,0);
});
