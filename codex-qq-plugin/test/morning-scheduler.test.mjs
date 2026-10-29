import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beijingClock,createMorningTick} from '../scripts/morning-scheduler.mjs';

test('Beijing 08:00 boundary independent of host timezone',()=>{
  assert.deepEqual(beijingClock(new Date('2026-10-28T23:59:59Z')),{date:'2026-10-29',due:false});
  assert.deepEqual(beijingClock(new Date('2026-10-29T00:00:00Z')),{date:'2026-10-29',due:true});
});
test('before 8 waits, late startup catches up, restarts dedupe, next day sends',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'alex-morning-'));
  try {
    let current=new Date('2026-10-28T23:59:00Z'),calls=0;
    const options={stateDir,now:()=>current,ensureService:async()=>{},client:{status:async()=>({configured:true,core:{paired:true,paused:false},transport:{state:'connected'}}),weatherBriefing:async args=>{calls++;assert.deepEqual(args,{mode:'daily'});return {ok:true,code:'SENT'};}}};
    const tick=createMorningTick(options);
    await tick();assert.equal(calls,0);
    current=new Date('2026-10-29T02:00:00Z');
    await Promise.all([tick(),tick()]);assert.equal(calls,1);
    await createMorningTick(options)();assert.equal(calls,1);
    current=new Date('2026-10-30T00:00:00Z');await tick();assert.equal(calls,2);
  }finally{await rm(stateDir,{recursive:true,force:true});}
});
test('paused/offline wait; uncertain send is not retried',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'alex-morning-'));
  try {
    let paused=true,offline=false,calls=0,starts=0;
    const tick=createMorningTick({stateDir,now:()=>new Date('2026-10-29T01:00:00Z'),ensureService:async()=>{starts++;},client:{status:async()=>{if(offline)throw Error();return {configured:true,core:{paired:true,paused},transport:{state:'connected'}};},weatherBriefing:async()=>{calls++;throw Object.assign(Error(),{code:'TIMEOUT'});}}});
    await tick();assert.equal(calls,0);
    offline=true;await tick();await tick();assert.equal(starts,1);
    offline=false;paused=false;await tick();await tick();assert.equal(calls,1);
  }finally{await rm(stateDir,{recursive:true,force:true});}
});

test('a full quota window does not consume the daily morning claim',async()=>{
  const stateDir=await mkdtemp(join(tmpdir(),'alex-morning-quota-'));
  try{
    let minuteAttempts=3,remainingDailyAttempts=198,calls=0;
    const tick=createMorningTick({stateDir,now:()=>new Date('2026-10-29T00:00:00Z'),ensureService:async()=>{},client:{status:async()=>({configured:true,core:{paired:true,paused:false,minuteAttempts,remainingDailyAttempts,limits:{minuteAttempts:3}},transport:{state:'connected'}}),weatherBriefing:async()=>{calls++;return {ok:true,code:'SENT'};}}});
    await tick();assert.equal(calls,0);minuteAttempts=0;remainingDailyAttempts=0;await tick();assert.equal(calls,0);
    remainingDailyAttempts=198;await tick();assert.equal(calls,1);await tick();assert.equal(calls,1);
  }finally{await rm(stateDir,{recursive:true,force:true});}
});
