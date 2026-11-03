import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';
import {basicGroupFeatures,normalizeGroupFeatures,validGroupFeatures} from '../src/group-features.mjs';
import {GroupMorningService,groupMorningClock} from '../src/group-morning.mjs';

const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
async function fixture(count=1,{send,weather,campusReport,features=()=>({...basicGroupFeatures(),morningWeather:true,morningCampus:true})}={}) {
  let now=new Date('2026-11-02T23:30:00Z'),saved={
    version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:Array.from({length:count},(_,i)=>({id:'g'+i,name:'群'+i,features:features(i)})),grayGroups:[],
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
    campus:{run:async()=>{campus++;if(campusReport)await campusReport();return {image};}},
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
  assert.deepEqual(f.sent.map(s=>s.requiredFeature),['morningWeather','morningCampus']);
  const reloaded=f.makeCore();await reloaded.init();
  assert.equal((await f.serviceFor(reloaded).run()).code,'DUPLICATE');
  assert.equal(f.sent.length,2);assert.equal(f.counts().generated,1);
});

test('legacy broadcast flag does not subscribe a group to scheduled reports',()=>{
  const {morningWeather,morningCampus,...features}=basicGroupFeatures();
  const migrated=normalizeGroupFeatures({...features,notifications:true});
  assert.equal(migrated.morningWeather,false);assert.equal(migrated.morningCampus,false);assert.equal('notifications' in migrated,false);
});

test('closing the daily switch while generating prevents all group sends',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  const f=await fixture(1,{weather:async()=>{entered();await blocked;}});
  const run=f.service.run();await started;
  const group=f.core.status().allowedGroups[0];
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningWeather:false,morningCampus:false}});
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
  await f.core.notifyImageAllAllowed({image,idempotencyKey:'group-morning-2026-11-03-weather',groupsOnly:true,requiredFeature:'morningWeather',groupTargets:f.core.captureMorningTargets()});
  const result=await f.service.run();
  assert.equal(result.sent,1);assert.equal(f.counts().generated,0);assert.equal(f.sent.length,2);
});

test('each 07:30 switch independently selects generation, delivery and persisted settings',async t=>{
  for (const [morningWeather,morningCampus] of [[false,false],[true,false],[false,true],[true,true]]) {
    await t.test(JSON.stringify({morningWeather,morningCampus}),async()=>{
      const features={...basicGroupFeatures(),morningWeather,morningCampus};
      const f=await fixture(1,{features:()=>features});
      await f.service.run();
      assert.equal(f.counts().generated,Number(morningWeather));assert.equal(f.counts().campus,Number(morningCampus));
      assert.deepEqual(f.sent.map(s=>s.requiredFeature),[
        ...(morningWeather?['morningWeather']:[]),...(morningCampus?['morningCampus']:[]),
      ]);
      const reload=f.makeCore();await reload.init();
      assert.deepEqual(reload.status().allowedGroups[0].features,features);
      assert.equal(reload.captureMorningTargets('morningWeather').length,Number(morningWeather));
      assert.equal(reload.captureMorningTargets('morningCampus').length,Number(morningCampus));
    });
  }
});

test('groups receive only the selected part, and old combined consent migrates to both',async()=>{
  const f=await fixture(3,{features:i=>({...basicGroupFeatures(),morningWeather:i!==1,morningCampus:i!==0})});
  assert.equal((await f.service.run()).sent,4);
  assert.deepEqual(f.sent.map(s=>[s.groupId,s.requiredFeature]),[
    ['g0','morningWeather'],['g1','morningCampus'],['g2','morningWeather'],['g2','morningCampus'],
  ]);
  const {morningWeather,morningCampus,...ordinary}=basicGroupFeatures();
  for (const enabled of [false,true]) {
    const old={...ordinary,morningReport:enabled};assert.equal(validGroupFeatures(old),true);
    const legacy=await fixture(1,{features:()=>old});
    const migrated=legacy.core.status().allowedGroups[0].features;
    assert.deepEqual(migrated,{...ordinary,morningWeather:enabled,morningCampus:enabled});
    assert.equal((await legacy.service.run()).sent,enabled?2:0);
  }
  assert.equal(validGroupFeatures({...basicGroupFeatures(),morningReport:true}),false);
  const partial={...basicGroupFeatures()};delete partial.morningCampus;
  assert.equal(validGroupFeatures(partial),false);
});

test('closing only weather while generating leaves the campus subscription running',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  const f=await fixture(1,{weather:async()=>{entered();await blocked;}});
  const run=f.service.run();await started;
  const group=f.core.status().allowedGroups[0];
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningWeather:false}});
  release();assert.equal((await run).sent,1);
  assert.deepEqual(f.sent.map(s=>s.requiredFeature),['morningCampus']);
});

test('re-enabling a switch cannot revive its stale generation or add an uncaptured subscription',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningWeather:true}),weather:async()=>{entered();await blocked;}});
  const run=f.service.run();await started;
  const group=f.core.status().allowedGroups[0];
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningWeather:false}});
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningCampus:true}});
  release();await run;
  assert.equal(f.sent.length,0);assert.equal(f.counts().campus,0);
});

test('a generation failure in one report does not suppress the other enabled report',async t=>{
  for (const failed of ['weather','campus']) await t.test(failed,async()=>{
    const fail=async()=>{throw Error('FIXTURE_SOURCE_FAILURE');};
    const f=await fixture(1,{[failed==='weather'?'weather':'campusReport']:fail});
    const result=await f.service.run();
    assert.equal(result.ok,false);assert.equal(result.sent,1);assert.equal(result.failedParts[0].part,failed);
    assert.deepEqual(f.sent.map(s=>s.requiredFeature),[failed==='weather'?'morningCampus':'morningWeather']);
  });
});
