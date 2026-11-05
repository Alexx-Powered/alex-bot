import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { BridgeCore } from '../src/core.mjs';
import { withHeavyWork } from '../src/heavy-work.mjs';

const owner = (id, text='发 云图 南京') => ({kind:'c2c', id, senderId:'owner', text,
  replyTarget:{scope:'c2c',targetId:'owner',msgId:id}});
const group = (id, text) => ({kind:'group', id, groupId:'group', senderId:'member', mentioned:true, text,
  replyTarget:{scope:'group',targetId:'group',msgId:id}});

async function setup({minuteAttempts=30, attempts=[], now=Date.now, handler=async text=>({text})}={}) {
  const calls=[], sends=[];
  const state={version:1,ownerId:'owner',paused:false,pauseReason:null,attempts,deliveries:[],incoming:[],
    lastDeliveryCode:null,allowedGroups:[{id:'group',name:'测试群'}]};
  const core=new BridgeCore({now,limits:{minuteAttempts},loadState:async()=>state,saveState:async()=>{},
    commandHandler:async(text,context)=>{calls.push(text);return handler(text,context);},
    send:async({replyTarget,text})=>{sends.push([replyTarget.msgId,text]);return {ok:true};}});
  await core.init();
  const receive=(msg,deadline=now()+300000)=>core.handleMessage(msg,deadline);
  return {core,calls,sends,receive};
}
const attempt=at=>({at,day:new Date(at+8*3600000).toISOString().slice(0,10)});

test('official group and private commands retain arrival order, including repeated text after an error',async()=>{
  const hold=Promise.withResolvers(), entered=Promise.withResolvers();
  let active=0;
  const f=await setup({handler:async text=>{
    assert.equal(++active,1);
    try{
      if(text==='first'){entered.resolve();await hold.promise;}
      if(text==='failed')throw Error('query failed');
      return {text};
    }finally{active--;}
  }});
  const first=f.receive(group('a','first'));await entered.promise;
  const backlog=[owner('b'),owner('c'),group('d','failed'),owner('e','天气 北京'),group('f','last')].map(m=>f.receive(m));
  await nextTurn();assert.deepEqual(f.calls,['first']);
  hold.resolve();
  assert.deepEqual((await Promise.all([first,...backlog])).map(r=>r.code),Array(6).fill('SENT'));
  assert.deepEqual(f.sends.map(([id])=>id),['a','b','c','d','e','f']);
  assert.deepEqual(f.calls,['first','发 云图 南京','发 云图 南京','failed','天气 北京','last']);
  assert.equal((await f.receive(owner('b'))).code,'DUPLICATE');
  assert.equal(f.sends.length,6);
});

test('rolling send limit delays the admitted command until capacity actually returns',async()=>{
  const start=Date.now(), prior=start-59800;
  const f=await setup({minuteAttempts:1,attempts:[attempt(prior)]});
  const pending=f.receive(owner('next'));
  await nextTurn();
  assert.deepEqual(f.calls,[]);
  assert.equal((await pending).code,'SENT');
  assert.ok(Date.now()>=prior+60000);
  assert.equal(f.core.status().minuteAttempts,1);
});

test('pause and group removal can cancel quota waits before any provider work',async()=>{
  for(const isGroup of [false,true]){
    const f=await setup({minuteAttempts:1,attempts:[attempt(Date.now())]});
    const pending=f.receive(isGroup?group('q','天气'):owner('q'));
    await nextTurn();
    if(isGroup)await f.core.removeAllowedGroup({groupKey:f.core.status().allowedGroups[0].groupKey});
    else {await f.core.setPaused(true);await f.core.setPaused(false);}
    assert.equal((await pending).code,isGroup?'GROUP_ACCESS_DENIED':'PAUSED');
    assert.deepEqual(f.calls,[]);assert.deepEqual(f.sends,[]);
  }
});

test('reply deadlines cancel expired queued work and suppress a result that expired during generation',async()=>{
  let now=Date.now();
  const hold=Promise.withResolvers(),entered=Promise.withResolvers();
  const f=await setup({now:()=>now,handler:async text=>{entered.resolve();await hold.promise;return {text};}});
  const first=f.receive(owner('first'),now+5000);await entered.promise;
  const second=f.receive(group('expired','天气'),now+6000);
  now+=6100;hold.resolve();
  assert.deepEqual((await Promise.all([first,second])).map(r=>r.code),['REQUEST_EXPIRED','REQUEST_EXPIRED']);
  assert.equal(f.calls.length,1);assert.deepEqual(f.sends,[]);
});

test('a queued heavy operation rechecks group permission when the render slot opens',async()=>{
  const hold=Promise.withResolvers(),entered=Promise.withResolvers();
  const background=withHeavyWork(()=>hold.promise);
  let renders=0;
  const f=await setup({handler:async()=>{entered.resolve();return withHeavyWork(async()=>{renders++;return {text:'天气'};});}});
  const command=f.receive(group('map','发 云图 南京'));await entered.promise;
  const remove=f.core.removeAllowedGroup({groupKey:f.core.status().allowedGroups[0].groupKey});
  hold.resolve();await background;
  assert.equal((await command).ok,false);await remove;
  assert.equal(renders,0);assert.deepEqual(f.sends,[]);
});

test('queue has bounded capacity and never spends the final send slot on a progress message',async()=>{
  const hold=Promise.withResolvers(),entered=Promise.withResolvers();
  const f=await setup({minuteAttempts:1,handler:async(_text,context)=>{
    entered.resolve();await hold.promise;
    assert.equal(await context.progress('campus-fetch'),true);return {text:'最终结果'};
  }});
  const first=f.receive(owner('first'));await entered.promise;
  const queued=Array.from({length:15},(_,i)=>f.receive(owner('more'+i),Date.now()+2000));
  assert.equal((await f.receive(owner('overflow'))).code,'BUSY');
  hold.resolve();assert.equal((await first).code,'SENT');
  assert.ok((await Promise.all(queued)).every(r=>r.code==='REQUEST_EXPIRED'));
  assert.deepEqual(f.sends,[['first','最终结果']]);
});
