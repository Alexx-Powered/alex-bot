import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';
import {basicGroupFeatures,normalizeGroupFeatures} from '../src/group-features.mjs';
import {GroupMorningService,groupMorningClock} from '../src/group-morning.mjs';

const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
async function fixture(count=1,{send,weather}={}) {
  let now=new Date('2026-11-02T23:30:00Z'),saved={
    version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:Array.from({length:count},(_,i)=>({id:'g'+i,name:'群'+i,features:{...basicGroupFeatures(),morningReport:true}})),grayGroups:[],
  };
  const sent=[];let generated=0,campus=0,waits=0;
  function makeCore() {
    return new BridgeCore({oneBotMode:'normal',now:()=>now.getTime(),loadState:async()=>saved,saveState:async v=>{saved=structuredClone(v);},
      send:async request=>{sent.push(request);return send?send(request):{ok:true,receiptHash:'a'.repeat(64)};}});
  }
  const core=makeCore();await core.init();
  const serviceFor=current=>new GroupMorningService({
    core:current,adapter:{status:()=>({state:'connected'})},now:()=>now,
    sleep:async ms=>{waits++;now=new Date(now.getTime()+ms);},
    morning:{create:async()=>{generated++;if(weather)await weather();return {date:groupMorningClock(now).date,image};}},
    campus:{run:async()=>{campus++;return {image};}},
  });
  return {core,service:serviceFor(core),serviceFor,makeCore,sent,saved:()=>saved,
    setNow:value=>{now=new Date(value);},counts:()=>({generated,campus,waits})};
}

test('morning window is Beijing 07:30; afternoon enable never catches up',async()=>{
  assert.equal(groupMorningClock(new Date('2026-11-02T23:29:59Z')).inWindow,false);
  assert.equal(groupMorningClock(new Date('2026-11-02T23:30:00Z')).inWindow,true);
  const f=await fixture();f.setNow('2026-11-03T06:30:00Z');
  assert.equal((await f.service.run()).code,'MORNING_NOT_DUE');assert.equal(f.counts().generated,0);assert.equal(f.sent.length,0);
});

test('daily sends two images only to opted-in groups and restart cannot duplicate receipts',async()=>{
  const f=await fixture();const result=await f.service.run();
  assert.equal(result.sent,2);assert.deepEqual(f.sent.map(s=>s.groupId),['g0','g0']);
  assert.ok(f.sent.every(s=>s.requiredFeature==='morningReport'));
  const reloaded=f.makeCore();await reloaded.init();
  assert.equal((await f.serviceFor(reloaded).run()).code,'DUPLICATE');
  assert.equal(f.sent.length,2);assert.equal(f.counts().generated,1);
});

test('legacy broadcast flag does not subscribe a group to scheduled reports',()=>{
  const {morningReport,...features}=basicGroupFeatures();
  const migrated=normalizeGroupFeatures({...features,notifications:true});
  assert.equal(migrated.morningReport,false);assert.equal('notifications' in migrated,false);
});

test('closing the daily switch while generating prevents all group sends',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  const f=await fixture(1,{weather:async()=>{entered();await blocked;}});
  const run=f.service.run();await started;
  const group=f.core.status().allowedGroups[0];
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningReport:false}});
  release();await run;assert.equal(f.sent.length,0);assert.equal(f.counts().campus,0);
});

test('uncertain sends pause and stop the remaining daily images',async()=>{
  const f=await fixture(1,{send:()=>({})});
  assert.equal((await f.service.run()).code,'DELIVERY_UNCERTAIN');
  assert.equal(f.sent.length,1);assert.equal(f.core.status().paused,true);
  assert.equal((await f.service.run()).code,'PAUSED');assert.equal(f.sent.length,1);
});

test('multiple groups wait for an unconsumed quota window without resending any image',async()=>{
  const f=await fixture(4);const result=await f.service.run();
  assert.equal(result.sent,8);assert.equal(f.counts().generated,1);assert.ok(f.counts().waits>=60);
  for (const id of ['g0','g1','g2','g3']) assert.equal(f.sent.filter(s=>s.groupId===id).length,2);
});

test('an already delivered weather image is skipped when only the campus part remains',async()=>{
  const f=await fixture();
  await f.core.notifyImageAllAllowed({image,idempotencyKey:'group-morning-2026-11-03-weather',groupsOnly:true,requiredFeature:'morningReport',groupTargets:f.core.captureMorningTargets()});
  const result=await f.service.run();
  assert.equal(result.sent,1);assert.equal(f.counts().generated,0);assert.equal(f.sent.length,2);
});
