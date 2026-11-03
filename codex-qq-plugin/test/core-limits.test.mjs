import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BridgeCore, CORE_LIMITS } from '../src/core.mjs';
import {DEFAULT_WAKE_WORDS} from '../src/wake-words.mjs';

const NOW=Date.parse('2026-10-29T06:00:00Z');
const hash=value=>createHash('sha256').update(value).digest('hex');
const day=at=>new Date(at+8*3600_000).toISOString().slice(0,10);
const incoming=(id,text='查询')=>({kind:'c2c',id,text,senderId:'OWNER',replyTarget:{scope:'c2c',targetId:'OWNER',msgId:id}});
function state(count=0,{paused=false,groups=[]}={}){
  const attempts=Array.from({length:count},(_,i)=>{const at=NOW-8*3600_000+i*10_000;return {at,day:day(at)};});
  return {version:1,ownerId:'OWNER',paused,pauseReason:paused?'LOCAL_PAUSE':null,attempts,
    deliveries:attempts.map((entry,i)=>({key:hash(`old-key-${i}`),state:'sent',at:entry.at,code:'SENT'})),
    incoming:attempts.map((_,i)=>hash(`old-incoming-${i}`)),lastDeliveryCode:count?'SENT':null,allowedGroups:groups};
}
function fixture({initial=state(),limits,send,handler=async()=>({text:'回复'})}={}){
  const storage={value:structuredClone(initial)},clock={value:NOW},sent=[],calls=[];
  const deps={loadState:async()=>structuredClone(storage.value),saveState:async value=>{storage.value=structuredClone(value);},
    now:()=>clock.value,send:async request=>{sent.push(request);return send?send(request):{ok:true};},
    commandHandler:async(...args)=>{calls.push(args);return handler(...args);},...(limits===undefined?{}:{limits})};
  return {core:new BridgeCore(deps),deps,storage,clock,sent,calls};
}

test('default limit status is 200 daily, 3 minute and 10 reserved; returned limit snapshots cannot mutate it',async()=>{
  assert.equal(CORE_LIMITS.historySize,4096);
  const f=fixture();await f.core.init();
  assert.deepEqual(f.core.status().limits,{dailyAttempts:200,minuteAttempts:3,reservedNotifications:10,replyDailyAttempts:190});
  assert.equal(f.core.status().remainingDailyAttempts,200);
  const copy=f.core.status().limits;copy.dailyAttempts=999;
  assert.equal(f.core.status().limits.dailyAttempts,200);
  const override={dailyAttempts:25,minuteAttempts:2,reservedNotifications:5};
  const g=fixture({limits:override});override.dailyAttempts=1000;await g.core.init();
  assert.deepEqual(g.core.status().limits,{dailyAttempts:25,minuteAttempts:2,reservedNotifications:5,replyDailyAttempts:20});
});

test('reply 191 stops before fetching and the ten reserved sends remain available to active notifications',async()=>{
  const f=fixture();await f.core.init();
  for(let i=0;i<190;i++){
    assert.equal((await f.core.handleMessage(incoming(`reply-${i}`))).code,'SENT');
    f.clock.value+=60001;
  }
  assert.equal(f.core.status().dailyAttempts,190);assert.equal(f.core.status().remainingDailyAttempts,10);
  assert.equal((await f.core.handleMessage(incoming('reply-blocked'))).code,'RATE_LIMIT_REPLY_DAY');
  assert.equal((await f.core.handleMessage(incoming('ping-blocked','/ping'))).code,'RATE_LIMIT_REPLY_DAY');
  assert.equal(f.calls.length,190);assert.equal(f.sent.length,190);
  for(let i=0;i<9;i++){
    assert.equal((await f.core.notify({text:'主动通知',idempotencyKey:`notify-${i}`})).code,'SENT');
    f.clock.value+=60001;
  }
  assert.equal((await f.core.notifyImage({image:{buffer:Buffer.alloc(8),mimeType:'image/png'},idempotencyKey:'daily-report'})).code,'SENT');
  f.clock.value+=60001;
  assert.equal(f.core.status().dailyAttempts,200);assert.equal(f.core.status().remainingDailyAttempts,0);
  assert.equal((await f.core.notify({text:'超额',idempotencyKey:'over-200'})).code,'RATE_LIMIT_DAY');
  assert.equal(f.sent.length,200);assert.equal(f.core.status().paused,false);
  assert.ok(f.storage.value.attempts.every(entry=>Object.keys(entry).sort().join(',')==='at,day'));
});

test('reservation is based on the total count and blocks both private and group handlers before fetching',async()=>{
  const f=fixture({initial:state(15,{groups:[{id:'GROUP',name:'测试群'}]}),limits:{dailyAttempts:20,minuteAttempts:3,reservedNotifications:5}});
  await f.core.init();
  assert.equal((await f.core.handleMessage(incoming('private'))).code,'RATE_LIMIT_REPLY_DAY');
  assert.equal((await f.core.handleMessage({kind:'group',groupId:'GROUP',id:'group',senderId:'MEMBER',text:'梁祖 查询',replyTarget:{scope:'group',targetId:'GROUP',msgId:'group'}})).code,'RATE_LIMIT_REPLY_DAY');
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
  assert.equal((await f.core.notify({text:'通知',idempotencyKey:'reserved'})).code,'SENT');
});

test('instance minute limits apply to private/group prefetch and the final sender',async()=>{
  const f=fixture({limits:{dailyAttempts:20,minuteAttempts:1,reservedNotifications:2},initial:state(0,{groups:[{id:'GROUP',name:'测试群'}]})});
  await f.core.init();await f.core.notify({text:'first',idempotencyKey:'first'});
  assert.equal((await f.core.handleMessage(incoming('private'))).code,'RATE_LIMIT_MINUTE');
  assert.equal((await f.core.handleMessage({kind:'group',groupId:'GROUP',id:'group',senderId:'MEMBER',text:'梁祖 查询',replyTarget:{scope:'group',targetId:'GROUP',msgId:'group'}})).code,'RATE_LIMIT_MINUTE');
  assert.equal((await f.core.notify({text:'second',idempotencyKey:'second'})).code,'RATE_LIMIT_MINUTE');
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,1);
});

test('failed reserved notifications count before send, stay paused across restart and are not refunded',async()=>{
  const f=fixture({initial:state(190),send:async()=>{throw Object.assign(new Error('private failure'),{httpStatus:403});}});await f.core.init();
  const result=await f.core.notify({text:'完成简报',idempotencyKey:'failed-summary'});
  assert.equal(result.code,'PERMISSION_DENIED');assert.equal(f.core.status().dailyAttempts,191);
  assert.equal(f.core.status().remainingDailyAttempts,9);assert.equal(f.core.status().paused,true);
  const restarted=new BridgeCore(f.deps);await restarted.init();
  assert.equal(restarted.status().paused,true);assert.equal(restarted.status().dailyAttempts,191);
  assert.equal((await restarted.notify({text:'完成简报',idempotencyKey:'failed-summary'})).code,'DUPLICATE');
  assert.equal(f.sent.length,1);
});

test('state with more than 256 attempts and 512 history entries restores without dropping records',async()=>{
  const original=state(600),f=fixture({initial:original,limits:{dailyAttempts:1000,minuteAttempts:10,reservedNotifications:100}});
  await f.core.init();
  assert.deepEqual(f.storage.value,{...original,grayGroups:[],wakeWords:DEFAULT_WAKE_WORDS,wakeWordRevision:0});
  assert.equal(f.core.status().dailyAttempts,600);assert.equal(f.core.status().remainingDailyAttempts,400);
  assert.equal((await f.core.notify({text:'new',idempotencyKey:'new'})).code,'SENT');
  assert.equal(f.storage.value.attempts.length,601);assert.equal(f.storage.value.deliveries.length,601);
  assert.deepEqual(f.storage.value.deliveries.slice(0,600),original.deliveries);
});

test('old twenty-send state migrates to higher defaults without clearing counters, keys or pause',async()=>{
  const original=state(20,{paused:true});const f=fixture({initial:original});await f.core.init();
  assert.deepEqual(f.storage.value,{...original,grayGroups:[],wakeWords:DEFAULT_WAKE_WORDS,wakeWordRevision:0});assert.equal(f.core.status().paused,true);
  assert.equal(f.core.status().dailyAttempts,20);assert.equal(f.core.status().remainingDailyAttempts,180);
  assert.equal((await f.core.notify({text:'no unpause',idempotencyKey:'new'})).code,'PAUSED');assert.equal(f.sent.length,0);
  // A lower configured limit remains a quota decision, never invalidates larger existing state.
  const lowered=new BridgeCore({...f.deps,limits:{dailyAttempts:10,minuteAttempts:1,reservedNotifications:0}});await lowered.init();
  assert.equal(lowered.status().dailyAttempts,20);assert.equal(lowered.status().remainingDailyAttempts,0);
  assert.equal(lowered.status().paused,true);assert.deepEqual(f.storage.value,{...original,grayGroups:[],wakeWords:DEFAULT_WAKE_WORDS,wakeWordRevision:0});
});

test('all constructor limit fields are validated before any state I/O',()=>{
  for(const limits of [null,[],new Date(),Object.create({dailyAttempts:200}),{unknown:1},
    {dailyAttempts:9},{dailyAttempts:1001},{dailyAttempts:200.5},{dailyAttempts:'200'},
    {minuteAttempts:0},{minuteAttempts:31},{minuteAttempts:1.5},{minuteAttempts:NaN},
    {reservedNotifications:-1},{reservedNotifications:101},{reservedNotifications:1.5},
    {dailyAttempts:10,reservedNotifications:10},{dailyAttempts:20,reservedNotifications:20},
    {dailyAttempts:undefined}]){
    assert.throws(()=>fixture({limits}),{message:'INVALID_CORE_LIMITS'});
  }
  assert.doesNotThrow(()=>fixture({limits:{dailyAttempts:10,minuteAttempts:1,reservedNotifications:0}}));
  assert.doesNotThrow(()=>fixture({limits:{dailyAttempts:1000,minuteAttempts:10,reservedNotifications:100}}));
});

test('broadcast uses configured full daily allowance including reserved capacity, with atomic preflight',async()=>{
  const groups=[{id:'GROUP',name:'测试群'}];
  const good=fixture({initial:state(10,{groups}),limits:{dailyAttempts:12,minuteAttempts:2,reservedNotifications:3}});await good.core.init();
  assert.equal((await good.core.handleMessage(incoming('reply'))).code,'RATE_LIMIT_REPLY_DAY');
  const result=await good.core.notifyAllAllowed({text:'授权摘要',idempotencyKey:'operation'});
  assert.equal(result.code,'SENT');assert.equal(result.sent,2);assert.equal(good.core.status().dailyAttempts,12);
  const overDay=fixture({initial:state(11,{groups}),limits:{dailyAttempts:12,minuteAttempts:2,reservedNotifications:3}});await overDay.core.init();
  assert.equal((await overDay.core.notifyAllAllowed({text:'授权摘要',idempotencyKey:'operation'})).code,'RATE_LIMIT_DAY');assert.equal(overDay.sent.length,0);
  const overMinute=fixture({initial:state(0,{groups}),limits:{dailyAttempts:12,minuteAttempts:1,reservedNotifications:3}});await overMinute.core.init();
  assert.equal((await overMinute.core.notifyAllAllowed({text:'授权摘要',idempotencyKey:'operation'})).code,'RATE_LIMIT_MINUTE');assert.equal(overMinute.sent.length,0);
});

test('attempt retention still removes only entries older than 48 hours when a new attempt is recorded',async()=>{
  const raw=state();
  raw.attempts=[NOW-48*3600_000-1,NOW-48*3600_000,NOW-25*3600_000].map(at=>({at,day:day(at)}));
  const f=fixture({initial:raw});await f.core.init();assert.equal(f.storage.value.attempts.length,3);
  await f.core.notify({text:'retention',idempotencyKey:'retention'});
  assert.deepEqual(f.storage.value.attempts.map(entry=>entry.at),[NOW-48*3600_000,NOW-25*3600_000,NOW]);
});

test('fixed storage ceilings continue to fail closed above 4096 entries',async()=>{
  for(const field of ['attempts','deliveries','incoming']){
    const raw=state();const large=state(4097);raw[field]=large[field];
    const f=fixture({initial:raw});await assert.rejects(f.core.init(),{message:'STATE_INVALID'});assert.equal(f.sent.length,0);
  }
});
