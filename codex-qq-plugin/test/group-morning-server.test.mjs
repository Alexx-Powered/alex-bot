import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeServer} from '../src/server.mjs';
import {basicGroupFeatures} from '../src/group-features.mjs';
import {Telemetry,measureSpan,setTraceOperation} from '../src/telemetry.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('slow 07:25 preparation does not lock 07:30 dispatch or status; fixed integration route rejects parameters',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-morning-http-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  let now=new Date('2026-11-07T07:25:00+08:00'),entered,release,calls=0;
  const started=new Promise(r=>entered=r),blocked=new Promise(r=>release=r),sent=[];
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,
    saveState:async()=>{},loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,
      attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
      allowedGroups:[{id:'group',name:'fixture',features:{...basicGroupFeatures(),morningWeather:true,morningCampus:true}}],grayGroups:[]})};
  const app=await createBridgeServer({home,port:0,store,groupMorningNow:()=>now,
    morningReport:{create:async options=>{assert.equal(options.scheduledMorning,true);calls++;entered();await blocked;return {date:'2026-11-07',image};}},
    campusService:{status:async()=>({}),close(){},run:async()=>({image,data:{ok:true,date:'2026-11-07'}})},
    adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async r=>{sent.push(r);return {ok:true};}})});
  try {
    const port=await app.listen();
    const request=(route,body={},token=store.integrationToken)=>fetch('http://127.0.0.1:'+port+'/api/'+route,
      {method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await request('group/morning/prepare',{scheduledMorning:true})).status,400);
    const prepare=request('group/morning/prepare');await started;
    assert.equal(sent.length,0);
    assert.equal((await (await request('group/morning/run')).json()).code,'MORNING_NOT_DUE');
    now=new Date('2026-11-07T07:30:00+08:00');
    const dispatch=request('group/morning/run');
    for(let i=0;i<100&&!sent.length;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(sent.length,1,'ready campus leaves while weather preparation is still pending');
    const status=await fetch('http://127.0.0.1:'+port+'/api/status',{headers:{Authorization:'Bearer '+store.token}});
    assert.equal(status.status,200);
    release();
    assert.equal((await (await prepare).json()).code,'MORNING_PREPARED');
    assert.equal((await (await dispatch).json()).sent,2);
    assert.equal(calls,1);assert.equal(sent.length,2);
    assert.equal((await (await request('group/morning/run')).json()).code,'DUPLICATE');
    let monitoring;
    for(let i=0;i<100;i++){
      monitoring=await app.monitoring.status();
      if(monitoring.langsmith.pending===0&&monitoring.local.lastCode==='SAVED')break;
      await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(monitoring.langsmith.pending,0);
    assert.equal(monitoring.local.lastCode,'SAVED');
  } finally {release();await app.close();}
});

test('morning retries export independent LangSmith roots, including failure details and inputs',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-morning-trace-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  const date='2026-11-07',payloads=[];
  let now=Date.parse(date+'T07:25:00+08:00'),weatherAttempts=0,campusAttempts=0;
  const secret='never-forward-test-group-or-provider-value';
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,
    saveState:async()=>{},loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,
      attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
      allowedGroups:[{id:secret,name:secret,features:{...basicGroupFeatures(),morningWeather:true,morningCampus:true}}],grayGroups:[]})};
  const telemetry=new Telemetry({home,now:()=>now,configStore:{read:async()=>({
    enabled:true,endpoint:'https://api.smith.langchain.com',apiKey:'only-for-fixture',project:'fixture',
  })},fetchImpl:async(_url,request)=>{payloads.push(JSON.parse(request.body));return {ok:true};}});
  const app=await createBridgeServer({home,port:0,store,telemetry,groupMorningNow:()=>now,
    groupMorningSleep:async()=>{},
    morningReport:{create:async options=>{assert.equal(options.retrySources,false);setTraceOperation('weather.report');weatherAttempts++;
      return measureSpan('weather_fetch',async()=>{
        if(weatherAttempts===1)throw Object.assign(Error(secret),{code:'MORNING_DATA_INCOMPLETE',retryable:true,
          morningQuality:{missing:['air.pm25',secret]}});
        return {date,image};
      });}},
    campusService:{status:async()=>({}),close(){},run:async()=>{campusAttempts++;return {data:{ok:false,code:'CAMPUS_LOGIN_TIMEOUT',secret}};}},
    adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},
      send:async()=>{await measureSpan('qq_media_upload',async()=>{});return {ok:true};}})});
  try{
    const port=await app.listen();
    const request=async route=>(await fetch('http://127.0.0.1:'+port+'/api/group/morning/'+route,{
      method:'POST',headers:{Authorization:'Bearer '+store.integrationToken,'Content-Type':'application/json'},body:'{}',
    })).json();
    const prepared=await request('prepare');
    assert.equal(prepared.code,'CAMPUS_LOGIN_TIMEOUT');assert.equal(prepared.prepared,1);
    now=Date.parse(date+'T07:30:00+08:00');
    const outcome=await request('run');
    assert.equal(outcome.code,'CAMPUS_LOGIN_TIMEOUT');assert.equal(outcome.attempted,1);assert.equal(outcome.sent,1);
    assert.deepEqual(outcome.failureNotice,{ok:true,code:'SENT'});
    assert.equal(weatherAttempts,2);assert.equal(campusAttempts,4);
    let monitoring;
    for(let i=0;i<100;i++){
      monitoring=await telemetry.status();
      if(monitoring.langsmith.pending===0&&monitoring.local.lastCode==='SAVED')break;
      await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(monitoring.langsmith.sent,6);
    assert.equal(monitoring.summary.count,0);
    const prepare=payloads.find(r=>r.name==='qq.morning.prepare'),dispatch=payloads.find(r=>r.name==='qq.morning.dispatch');
    assert.deepEqual(prepare.inputs,{date,event:'morning.prepare'});
    assert.match(prepare.error,/CAMPUS_LOGIN_TIMEOUT/);
    assert.deepEqual(prepare.outputs.failedParts,[{part:'campus',code:'CAMPUS_LOGIN_TIMEOUT'}]);
    assert.equal(dispatch.outputs.sent,1);
    assert.deepEqual(dispatch.outputs.failureNotice,{ok:true,code:'SENT'});
    assert.match(dispatch.error,/CAMPUS_LOGIN_TIMEOUT/);
    const fetchRun=payloads.find(r=>r.name==='weather_fetch'&&r.trace_id===prepare.id);
    assert.equal(fetchRun.parent_run_id,payloads.find(r=>r.name==='morning_weather_prepare'&&r.trace_id===prepare.id).id);
    assert.match(fetchRun.error,/MORNING_DATA_INCOMPLETE.*air\.pm25/);
    const retries=payloads.filter(r=>r.name==='qq.morning.retry');
    assert.equal(new Set(retries.map(r=>r.trace_id)).size,4);
    for(const root of retries){
      assert.equal(root.parent_run_id,undefined);assert.equal(root.id,root.trace_id);
      assert.deepEqual(root.inputs,{date,part:root.inputs.part,retry:root.inputs.retry,event:'morning.retry'});
      assert.ok(payloads.some(r=>r.name==='morning_'+root.inputs.part+'_prepare'&&r.parent_run_id===root.id));
    }
    const weatherRetry=retries.find(r=>r.inputs.part==='weather');
    assert.equal(weatherRetry.inputs.retry,1);assert.equal(weatherRetry.outputs.ok,true);assert.equal(weatherRetry.error,undefined);
    const campusRetries=retries.filter(r=>r.inputs.part==='campus');
    assert.deepEqual(campusRetries.map(r=>r.inputs.retry),[1,2,3]);
    for(const run of campusRetries){assert.equal(run.outputs.ok,false);assert.match(run.error,/CAMPUS_LOGIN_TIMEOUT/);}
    assert.ok(payloads.some(r=>r.name==='qq_media_upload'&&r.trace_id===dispatch.id));
    assert.ok(payloads.some(r=>r.name==='morning_failure_notice'&&r.trace_id===dispatch.id));
    assert.ok(!JSON.stringify(payloads).includes(secret));
  }finally{await app.close();}
});
