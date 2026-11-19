import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';
import {basicGroupFeatures,normalizeGroupFeatures,validGroupFeatures} from '../src/group-features.mjs';
import {GroupMorningService,groupMorningClock} from '../src/group-morning.mjs';

const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(count=1,{send,save,weather,campusReport,deadlineSignal,sleep,limits,
  features=()=>({...basicGroupFeatures(),morningWeather:true,morningCampus:true}),oneBotMode='normal'}={}) {
  let now=new Date('2026-11-02T23:30:00Z'),saved={
    version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:Array.from({length:count},(_,i)=>({id:'g'+i,name:'群'+i,features:features(i)})),grayGroups:[],
  };
  const sent=[];let generated=0,campus=0,waits=0;
  function makeCore() {
    return new BridgeCore({oneBotMode,limits,now:()=>now.getTime(),loadState:async()=>saved,saveState:async v=>{if(save)await save(v);saved=structuredClone(v);},
      send:async request=>{sent.push(request);return send?send(request):{ok:true,receiptHash:'a'.repeat(64)};}});
  }
  const core=makeCore();await core.init();
  const serviceFor=current=>new GroupMorningService({
    core:current,adapter:{status:()=>({state:'connected'})},now:()=>now,deadlineSignal,
    sleep:sleep??(async ms=>{waits++;now=new Date(now.getTime()+ms);}),
    morning:{create:async options=>{generated++;const report=weather?await weather(options):undefined;return report===undefined?{date:groupMorningClock(now).date,image}:report;}},
    campus:{run:async(...args)=>{campus++;const report=campusReport?await campusReport(...args):undefined;return report===undefined?{image}:report;}},
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
  release();await run;assert.equal(f.sent.length,0);assert.ok(f.counts().campus<=1);
});

test('uncertain sends pause and stop the remaining daily images',async()=>{
  const f=await fixture(1,{send:()=>({})});
  assert.equal((await f.service.run()).code,'DELIVERY_UNCERTAIN');
  assert.equal(f.sent.length,1);assert.equal(f.core.status().paused,true);
  assert.equal((await f.service.run()).code,'PAUSED');assert.equal(f.sent.length,1);
});

test('an official group permission denial only skips that group and preserves both reports for other groups and private replies',async t=>{
  const warning=t.mock.method(console,'warn',()=>{});
  const f=await fixture(2,{oneBotMode:null,limits:{minuteAttempts:10},send:request=>{
    if(request.groupId==='g0')throw Object.assign(Error('opaque permission response'),{code:'QQ_TARGET_PERMISSION_DENIED',bizCode:40034105});
    return {ok:true};
  }});
  const result=await f.service.run();
  assert.equal(result.code,'QQ_TARGET_PERMISSION_DENIED');
  assert.equal(result.attempted,3);assert.equal(result.sent,2);
  assert.deepEqual(f.sent.filter(r=>r.groupId).map(r=>[r.groupId,r.requiredFeature]),[
    ['g0','morningWeather'],['g1','morningWeather'],['g1','morningCampus'],
  ]);
  assert.deepEqual(result.failureNotice,{ok:true,code:'SENT'});
  assert.equal(warning.mock.callCount(),1);
  const line=warning.mock.calls[0].arguments[0];
  assert.match(line,/"groupName":"群0"/);assert.match(line,/"bizCode":40034105/);
  assert.doesNotMatch(line,/opaque permission response/);
  const beforeRepeat=f.sent.length;
  assert.equal((await f.service.run()).sent,0);
  assert.equal(f.sent.length,beforeRepeat);
  const reloaded=f.makeCore();await reloaded.init();
  assert.equal(reloaded.status().paused,false);
  assert.ok(f.saved().deliveries.some(row=>row.state==='rejected'&&row.code==='PERMISSION_DENIED'));
  const reply=await reloaded.handleMessage({kind:'c2c',senderId:'owner',id:'ping',text:'/ping',
    replyTarget:{scope:'c2c',targetId:'owner',msgId:'ping'}});
  assert.equal(reply.code,'SENT');
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
  assert.deepEqual(f.sent.map(s=>[s.groupId,s.requiredFeature]).sort(),[
    ['g0','morningWeather'],['g1','morningCampus'],['g2','morningWeather'],['g2','morningCampus'],
  ].sort());
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
    assert.deepEqual(f.sent.filter(s=>s.groupId).map(s=>s.requiredFeature),[failed==='weather'?'morningCampus':'morningWeather']);
    assert.deepEqual(result.failureNotice,{ok:true,code:'SENT'});
    assert.equal(f.sent.at(-1).groupId,undefined);assert.equal(f.sent.at(-1).ownerId,'owner');
  });
});

test('preparation starts at 07:25 and both preparation and delivery stop at 07:40 Beijing',()=>{
  for(const [stamp,canPrepare,inWindow] of [
    ['2026-11-02T23:24:59Z',false,false],['2026-11-02T23:25:00Z',true,false],
    ['2026-11-02T23:29:59Z',true,false],['2026-11-02T23:30:00Z',true,true],
    ['2026-11-02T23:39:59Z',true,true],['2026-11-02T23:40:00Z',false,false],
  ]) assert.deepEqual(groupMorningClock(new Date(stamp)),{date:'2026-11-03',canPrepare,inWindow});
});

test('07:25 prepares without sends or budget consumption and 07:30 reuses both images',async()=>{
  const weatherImage={buffer:Buffer.alloc(16,1),mimeType:'image/png'};
  const campusImage={buffer:Buffer.alloc(16,2),mimeType:'image/png'};
  const f=await fixture(1,{
    weather:async options=>{assert.equal(options.scheduledMorning,true);return {date:'2026-11-03',image:weatherImage};},
    campusReport:async(query,kind,options)=>{
      assert.deepEqual(query,{date:'2026-11-03'});assert.equal(kind,'report');
      assert.equal(options.scheduledMorning,true);assert.equal(options.authorize(),true);
      return {image:campusImage,data:{ok:true,date:'2026-11-03'}};
    },
  });
  f.setNow('2026-11-02T23:25:00Z');
  const prepared=await f.service.prepare();
  assert.equal(prepared.prepared,2);assert.equal(prepared.attempted,0);assert.equal(prepared.sent,0);
  assert.equal(f.sent.length,0);assert.equal(f.core.status().dailyAttempts,0);assert.deepEqual(f.saved().deliveries,[]);
  assert.equal((await f.service.run()).code,'MORNING_NOT_DUE');
  f.setNow('2026-11-02T23:30:00Z');assert.equal((await f.service.run()).sent,2);
  assert.equal(f.sent.find(s=>s.requiredFeature==='morningWeather').image,weatherImage);
  assert.equal(f.sent.find(s=>s.requiredFeature==='morningCampus').image,campusImage);
  await f.service.prepare();assert.equal((await f.service.run()).code,'DUPLICATE');
  assert.deepEqual(f.counts(),{generated:1,campus:1,waits:0});assert.equal(f.sent.length,2);
});

test('overlapping prepare and run calls share generation and submit each part once',async()=>{
  const weather=deferred(),campus=deferred();
  const f=await fixture(1,{weather:()=>weather.promise,campusReport:()=>campus.promise});
  f.setNow('2026-11-02T23:25:00Z');
  const p1=f.service.prepare(),p2=f.service.prepare();await flush();
  assert.deepEqual(f.counts(),{generated:1,campus:1,waits:0});assert.equal(f.sent.length,0);
  f.setNow('2026-11-02T23:30:00Z');const r1=f.service.run(),r2=f.service.run();
  campus.resolve();await flush();
  assert.deepEqual(f.sent.map(s=>s.requiredFeature),['morningCampus']);
  weather.resolve();await Promise.all([p1,p2,r1,r2]);
  assert.deepEqual(f.counts(),{generated:1,campus:1,waits:0});
  assert.equal(f.sent.length,2);assert.equal(f.saved().deliveries.length,2);
});

test('either ready part can send at 07:30 while the other preparation is unresolved',async t=>{
  for(const slow of ['weather','campus']) await t.test(slow,async()=>{
    const blocked=deferred();
    const f=await fixture(1,{[slow==='weather'?'weather':'campusReport']:()=>blocked.promise});
    f.setNow('2026-11-02T23:25:00Z');const preparing=f.service.prepare();await flush();
    assert.equal(f.sent.length,0);
    f.setNow('2026-11-02T23:30:00Z');const running=f.service.run();await flush();
    assert.deepEqual(f.sent.map(s=>s.requiredFeature),[slow==='weather'?'morningCampus':'morningWeather']);
    assert.equal(f.service.status().parts[slow].state,'preparing');
    blocked.resolve();await Promise.all([preparing,running]);assert.equal(f.sent.length,2);
  });
});

test('prepared images cannot be delivered after the window and a new day generates new images',async()=>{
  const f=await fixture();f.setNow('2026-11-02T23:25:00Z');await f.service.prepare();
  f.setNow('2026-11-02T23:40:00Z');
  assert.equal((await f.service.run()).code,'MORNING_NOT_DUE');
  assert.equal((await f.service.prepare()).code,'MORNING_NOT_DUE');assert.equal(f.sent.length,0);
  f.setNow('2026-11-03T23:25:00Z');await f.service.prepare();
  assert.equal(f.service.status().date,'2026-11-04');assert.equal(f.sent.length,0);
  f.setNow('2026-11-03T23:30:00Z');assert.equal((await f.service.run()).sent,2);
  assert.deepEqual(f.counts(),{generated:2,campus:2,waits:0});
});

test('an unresolved preparation reaches the cutoff and only the owner receives a failure log',async()=>{
  const blocked=deferred();
  const deadline=new AbortController();
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningWeather:true}),weather:()=>blocked.promise,
    deadlineSignal:ms=>{assert.equal(ms,15*60_000);return deadline.signal;}});
  f.setNow('2026-11-02T23:25:00Z');const preparing=f.service.prepare();await flush();
  f.setNow('2026-11-02T23:30:00Z');const running=f.service.run();await flush();
  f.setNow('2026-11-02T23:40:00Z');deadline.abort();
  assert.equal((await preparing).code,'MORNING_WINDOW_ENDED');
  const result=await running;
  assert.equal(result.code,'MORNING_WINDOW_ENDED');assert.equal(result.sent,0);
  assert.equal(f.service.status().parts.weather.state,'failed');
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].groupId,undefined);
  assert.match(f.sent[0].text,/MORNING_WINDOW_ENDED/);
  blocked.resolve();await flush();
  assert.equal(f.sent.length,1);assert.equal(f.counts().generated,1);
});

test('a late previous-day preparation cannot replace or send the new-day plan',async()=>{
  const old=deferred();let calls=0;
  const oldImage={buffer:Buffer.alloc(16,3),mimeType:'image/png'};
  const newImage={buffer:Buffer.alloc(16,4),mimeType:'image/png'};
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningWeather:true}),weather:async()=>{
    if(++calls===1){await old.promise;return {date:'2026-11-03',image:oldImage};}
    return {date:'2026-11-04',image:newImage};
  }});
  f.setNow('2026-11-02T23:25:00Z');const prior=f.service.prepare();await flush();
  f.setNow('2026-11-03T23:25:00Z');await f.service.prepare();
  f.setNow('2026-11-03T23:30:00Z');assert.equal((await f.service.run()).sent,1);
  old.resolve();await prior;
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].image,newImage);
  assert.equal(f.service.status().date,'2026-11-04');assert.equal(f.counts().generated,2);
});

test('restart loses only the preparation cache and persisted receipts still suppress duplicates',async()=>{
  const f=await fixture();f.setNow('2026-11-02T23:25:00Z');await f.service.prepare();
  assert.equal(f.sent.length,0);
  const restarted=f.makeCore();await restarted.init();const service=f.serviceFor(restarted);
  assert.deepEqual(service.status(),{date:null,parts:{}});
  f.setNow('2026-11-02T23:30:00Z');assert.equal((await service.run()).sent,2);
  assert.deepEqual(f.counts(),{generated:2,campus:2,waits:0});
  const again=f.makeCore();await again.init();assert.equal((await f.serviceFor(again).run()).code,'DUPLICATE');
  assert.equal(f.sent.length,2);assert.equal(f.counts().generated,2);
});

test('closing and reopening a prepared switch cannot revive its old target snapshot',async()=>{
  const f=await fixture();f.setNow('2026-11-02T23:25:00Z');await f.service.prepare();
  const group=f.core.status().allowedGroups[0];
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningWeather:false}});
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:group.features});
  f.setNow('2026-11-02T23:30:00Z');const result=await f.service.run();
  assert.equal(result.sent,1);assert.deepEqual(f.sent.map(s=>s.requiredFeature),['morningCampus']);
  await f.service.prepare();await f.service.run();
  assert.equal(f.sent.length,1);assert.equal(f.counts().generated,1);
});

test('no subscriptions cause no generation during either scheduled phase',async t=>{
  for(const count of [0,2]) await t.test(String(count),async()=>{
    const f=await fixture(count,{features:()=>basicGroupFeatures()});
    f.setNow('2026-11-02T23:25:00Z');assert.equal((await f.service.prepare()).code,'NO_MORNING_GROUPS');
    f.setNow('2026-11-02T23:30:00Z');assert.equal((await f.service.run()).code,'NO_MORNING_GROUPS');
    assert.deepEqual(f.counts(),{generated:0,campus:0,waits:0});assert.equal(f.sent.length,0);
  });
});

test('missing, failed and wrong-day reports never become sendable images',async t=>{
  const cases=[
    ['weather',null],['weather',{}],['weather',{date:'2026-11-02',image}],
    ['weather',{date:'2026-11-03',image,ok:false,code:'MORNING_DATA_INCOMPLETE'}],
    ['campus',null],['campus',{}],['campus',{image,data:{ok:false,date:'2026-11-03'}}],
    ['campus',{image,data:{ok:true,date:'2026-11-02'}}],
  ];
  for(const [index,[part,report]] of cases.entries()) await t.test(String(index)+' '+part,async()=>{
    const feature=part==='weather'?'morningWeather':'morningCampus';
    const f=await fixture(1,{features:()=>({...basicGroupFeatures(),[feature]:true}),
      [part==='weather'?'weather':'campusReport']:async()=>report});
    f.setNow('2026-11-02T23:25:00Z');assert.equal((await f.service.prepare()).ok,false);
    f.setNow('2026-11-02T23:30:00Z');const result=await f.service.run();
    assert.equal(result.ok,false);assert.equal(result.sent,0);assert.equal(result.attempted,0);
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].groupId,undefined);assert.equal(f.core.status().dailyAttempts,1);
    assert.equal(f.service.status().parts[part].state,'failed');
  });
});

test('non-retryable missing-weather-data failure produces a sanitized owner notice',async()=>{
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningWeather:true}),weather:async()=>{
    throw Object.assign(new Error('private upstream response'),{code:'MORNING_DATA_INCOMPLETE'});
  }});
  f.setNow('2026-11-02T23:25:00Z');assert.equal((await f.service.prepare()).code,'MORNING_DATA_INCOMPLETE');
  f.setNow('2026-11-02T23:30:00Z');const result=await f.service.run();
  assert.equal(result.code,'MORNING_DATA_INCOMPLETE');assert.equal(result.sent,0);
  assert.equal(f.counts().generated,1);assert.equal(f.core.status().dailyAttempts,1);
  assert.equal(JSON.stringify(result).includes('private upstream'),false);
  assert.match(f.sent[0].text,/MORNING_DATA_INCOMPLETE/);
  assert.doesNotMatch(f.sent[0].text,/private upstream/);
});

test('only the failed report retries from 07:25 while its ready sibling can be delivered at 07:30',async t=>{
  for(const part of ['weather','campus'])await t.test(part,async()=>{
    const retry=deferred(),entered=deferred();
    let attempts=0;
    const failThenRecover=async()=>{
      if(++attempts===1){
        if(part==='weather')throw Object.assign(Error('source detail'),{code:'MORNING_DATA_INCOMPLETE',retryable:true});
        return {data:{ok:false,code:'CAMPUS_LOGIN_TIMEOUT'}};
      }
      entered.resolve();
      await retry.promise;
    };
    const f=await fixture(1,{[part==='weather'?'weather':'campusReport']:failThenRecover,sleep:async()=>{}});
    f.setNow('2026-11-02T23:25:00Z');
    const preparing=f.service.prepare();
    await entered.promise;
    assert.equal(f.sent.length,0);
    f.setNow('2026-11-02T23:30:00Z');
    const run=f.service.run();
    await flush();
    assert.deepEqual(f.sent.map(r=>r.requiredFeature),[part==='weather'?'morningCampus':'morningWeather']);
    retry.resolve();
    assert.equal((await preparing).prepared,2);
    assert.equal((await run).sent,2);
    assert.equal((await f.service.run()).code,'DUPLICATE');
    assert.equal(attempts,2);
  });
});

test('weather generation tries Visual Crossing and Previous Runs within the same four-attempt budget',async()=>{
  const sources=[];
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningWeather:true}),weather:async options=>{
    sources.push(options.visualCrossingWeather?'visual-crossing':options.backupWeather?'previous-runs':'primary');
    if(sources.length<4)throw Object.assign(Error('source unavailable'),{code:'MORNING_DATA_INCOMPLETE',retryable:true});
  }});
  f.setNow('2026-11-02T23:25:00Z');
  assert.equal((await f.service.prepare()).prepared,1);
  assert.deepEqual(sources,['previous-runs','visual-crossing','primary','previous-runs']);
  f.setNow('2026-11-02T23:30:00Z');
  assert.equal((await f.service.run()).sent,1);
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].groupId,'g0');
});

test('one initial attempt and three retries survive restart without repeating the owner notice',async()=>{
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningCampus:true}),
    campusReport:async()=>({data:{ok:false,code:'CAMPUS_LOGIN_TIMEOUT'}})});
  f.setNow('2026-11-02T23:25:00Z');
  assert.equal((await f.service.prepare()).code,'CAMPUS_LOGIN_TIMEOUT');
  assert.equal(f.counts().campus,4);assert.equal(f.sent.length,0);
  assert.deepEqual(f.saved().morningAttempts,{date:'2026-11-03',campus:{count:4,lastCode:'CAMPUS_LOGIN_TIMEOUT'}});
  f.setNow('2026-11-02T23:30:00Z');
  assert.deepEqual((await f.service.run()).failureNotice,{ok:true,code:'SENT'});
  assert.deepEqual((await f.service.run()).failureNotice,{ok:false,code:'DUPLICATE'});
  const restarted=f.makeCore();await restarted.init();
  const outcome=await f.serviceFor(restarted).run();
  assert.equal(outcome.code,'MORNING_RETRIES_EXHAUSTED');
  assert.deepEqual(outcome.failureNotice,{ok:false,code:'DUPLICATE'});
  assert.equal(f.counts().campus,4);assert.equal(f.sent.length,1);
  assert.match(f.sent[0].text,/三号楼自习简报（生成 4 次）\n.*CAMPUS_LOGIN_TIMEOUT/);
});

test('the owner receives the last safe failure code when restart precedes the dispatch entry',async()=>{
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningCampus:true}),
    campusReport:async()=>({data:{ok:false,code:'CAMPUS_SEARCH_TIMEOUT'}})});
  f.setNow('2026-11-02T23:25:00Z');await f.service.prepare();
  const restarted=f.makeCore();await restarted.init();
  f.setNow('2026-11-02T23:30:00Z');await f.serviceFor(restarted).run();
  assert.equal(f.counts().campus,4);assert.equal(f.sent.length,1);
  assert.match(f.sent[0].text,/MORNING_RETRIES_EXHAUSTED[^\n]*\n上次失败 [^\n]*CAMPUS_SEARCH_TIMEOUT/);
});

test('the private failure notice waits for a local minute quota without re-sending the report',async()=>{
  const f=await fixture(1,{limits:{minuteAttempts:1},campusReport:async()=>({data:{ok:false,code:'CAMPUS_AUTH_FAILED'}})});
  const outcome=await f.service.run();
  assert.equal(outcome.sent,1);assert.deepEqual(outcome.failureNotice,{ok:true,code:'SENT'});
  assert.equal(f.sent.length,2);assert.equal(f.sent[0].groupId,'g0');assert.equal(f.sent[1].groupId,undefined);
  assert.equal(f.counts().waits,60);
});

test('revoking a subscription during backoff cancels its retry and private failure notice',async()=>{
  const waiting=deferred(),backoff=deferred();
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningCampus:true}),
    sleep:async()=>{waiting.resolve();await backoff.promise;},
    campusReport:async()=>({data:{ok:false,code:'CAMPUS_LOGIN_TIMEOUT'}})});
  f.setNow('2026-11-02T23:25:00Z');const preparing=f.service.prepare();await waiting.promise;
  const group=f.core.status().allowedGroups[0];
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,morningCampus:false}});
  await f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:group.features});
  backoff.resolve();assert.equal((await preparing).code,'MORNING_CANCELLED');
  f.setNow('2026-11-02T23:30:00Z');assert.equal((await f.service.run()).code,'MORNING_CANCELLED');
  assert.equal(f.counts().campus,1);assert.equal(f.sent.length,0);
});

test('a successful submission started before cutoff is not reported as a failure',async()=>{
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningWeather:true}),send:()=>{
    f.setNow('2026-11-02T23:40:01Z');return {ok:true,receiptHash:'a'.repeat(64)};
  }});
  f.setNow('2026-11-02T23:39:59Z');
  assert.equal((await f.service.run()).code,'SENT');assert.equal(f.sent.length,1);
});

test('pausing after preparation still prevents all actual sends',async()=>{
  const f=await fixture();f.setNow('2026-11-02T23:25:00Z');await f.service.prepare();
  await f.core.setPaused(true);f.setNow('2026-11-02T23:30:00Z');
  assert.equal((await f.service.run()).code,'PAUSED');assert.equal(f.sent.length,0);
  assert.equal(f.core.status().dailyAttempts,0);
});

test('an unrelated chat setting save preserves campus preparation but still blocks actual delivery until saved',async()=>{
  const collecting=deferred(),collected=deferred(),saving=deferred(),saved=deferred();
  let blockSave=false,authorize;
  const f=await fixture(1,{features:()=>({...basicGroupFeatures(),morningCampus:true}),
    save:async()=>{if(blockSave){saving.resolve();await saved.promise;}},
    campusReport:async(_query,_kind,options)=>{authorize=options.authorize;collecting.resolve();await collected.promise;},
  });
  f.setNow('2026-11-02T23:25:00Z');const prepared=f.service.prepare();await collecting.promise;
  const group=f.core.status().allowedGroups[0];blockSave=true;
  const editing=f.core.setGroupFeatures({groupKey:group.groupKey,enabled:true,features:{...group.features,chat:false}});
  await saving.promise;
  assert.equal(authorize(),true);
  assert.equal(f.core.canDeliver({groupId:'g0',requiredFeature:'morningCampus',proactiveGroup:true}),false);
  collected.resolve();f.setNow('2026-11-02T23:30:00Z');const running=f.service.run();await flush();
  assert.equal(f.sent.length,0);
  blockSave=false;saved.resolve();await editing;await prepared;
  assert.equal((await running).sent,1);
  assert.deepEqual(f.sent.map(s=>s.requiredFeature),['morningCampus']);assert.equal(f.counts().campus,1);
});
