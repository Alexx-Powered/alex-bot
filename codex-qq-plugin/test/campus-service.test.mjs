import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {CampusService,campusFailure,validateCampusData} from '../src/campus-service.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {fileURLToPath} from 'node:url';

const data=()=>({...campusFailure('OK','2026-10-29'),ok:true,buildings:['三号楼'],rooms:[{building:'三号楼',room:'(三)105',free_periods:[1,2],busy_periods:Array.from({length:12},(_,i)=>i+3)}]});
const config={status:async()=>({enabled:true,configured:true}),read:async()=>({enabled:true,username:'offline-student',password:'offline-password'})};

test('a classroom grant is limited to its operation and revoked while private credentials load',async()=>{
  let allowed=true;
  const context={scope:'group',access:'white',authorize:()=>allowed};
  let complete;
  const loaded=new Promise(resolve=>complete=resolve);
  const service=new CampusService({home:'unused',worker:{},configStore:{
    status:config.status,read:()=>loaded
  }});
  assert.deepEqual(await service.workerGrant('arbitrary_tool',context),{code:'CAMPUS_OWNER_ONLY'});
  assert.deepEqual(await service.workerGrant('buaa_classroom_recommend',context),{code:'OK'});
  const pending=service.workerGrant('buaa_classroom_query',context);
  allowed=false;complete(await config.read());
  assert.deepEqual(await pending,{code:'CAMPUS_OWNER_ONLY'});
  assert.equal(await service.saveWorkerSession({code:'OK'},{cookies:[],origins:[]},context),false);
});
test('classroom JSON validates strict projection and refuses unknown fields or overlapping periods',()=>{
  assert.equal(validateCampusData(data()).rooms.length,1);
  assert.throws(()=>validateCampusData({...data(),password:'offline-password'}));
  const bad=data();bad.rooms[0].busy_periods[0]=1;assert.throws(()=>validateCampusData(bad));
});
test('campus credentials go only to private worker and generated image has no arbitrary file path',async t=>{
  const home=await mkdtemp(join(tmpdir(),'qq-campus-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const output=join(home,'.private','campus-output');await mkdir(output,{recursive:true});const id='a'.repeat(32);
  await writeFile(join(output,id+'.png'),createCanvas(1800,600).toBuffer('image/png'));
  let received;
  const worker={close(){},run:async(payload,_execute,finish)=>{received=payload;return finish({kind:'campus',data:data(),artifact_id:id});}};
  const service=new CampusService({home,configStore:config,worker});
  const result=await service.run({date:'2026-10-29'},'report');
  assert.equal(received.credentials.password,'offline-password');assert.equal(result.image.mimeType,'image/png');
  assert.doesNotMatch(JSON.stringify(result.data),/offline-student|offline-password/);
  worker.run=async(_p,_e,finish)=>finish({kind:'campus',data:data(),artifact_id:'../../private'});
  assert.equal((await service.run({},'report')).data.code,'CAMPUS_QUERY_FAILED');
});
test('unauthorized queries are denied and two authorized queries run sequentially',async()=>{
  let calls=0,release,entered;
  const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const service=new CampusService({home:'D:/unused',configStore:config,worker:{close(){},run:async(_p,_e,finish)=>{calls++;entered();await gate;return finish({data:campusFailure('CAMPUS_AUTH_FAILED'),artifact_id:null});}}});
  assert.equal((await service.workerGrant('buaa_classroom_query',{scope:'group'})).code,'CAMPUS_OWNER_ONLY');assert.equal(calls,0);
  const first=service.run({});await start;
  const second=service.run({});
  assert.equal(calls,1);release();const results=await Promise.all([first,second]);assert.equal(calls,2);
  assert.ok(results.every(r=>r.data.code==='CAMPUS_AUTH_FAILED'));
});
test('campus HTTP API authenticates all operations and sends one image only to the paired owner',async()=>{
  const sent=[],calls=[],store={token:'a'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const campus={status:async()=>({enabled:true,configured:true}),close(){},run:async(args,mode,options)=>{calls.push({args,mode,options});return {data:data(),image};}};
  let saved;
  const app=await createBridgeServer({port:0,store,campusService:campus,campusConfigStore:{save:async v=>{saved=v;return {enabled:true,configured:true};}},
    adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async value=>{sent.push(value);return {ok:true};}})});
  try{
    const port=await app.listen(),url='http://127.0.0.1:'+port;
    const post=(route,value,auth=true)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+store.token}:{})},body:JSON.stringify(value)});
    assert.equal((await post('/api/campus/query',{},false)).status,401);
    const pair=await app.core.startPairing();await app.core.handleMessage({kind:'c2c',id:'pair',senderId:'owner',text:'/pair '+pair.pairingCode});await app.core.confirmPairing();
    const savedResult=await(await post('/api/campus/config',{enabled:true,username:'offline-student',password:'offline-password'})).json();
    assert.equal(saved.password,'offline-password');assert.doesNotMatch(JSON.stringify(savedResult),/offline-student|offline-password/);
    assert.equal((await(await post('/api/campus/query',{})).json()).schema_version,'buaa-classrooms.v1');assert.equal(sent.length,0);
    assert.equal((await post('/api/morning/preview',{part:'campus'},false)).status,401);
    const preview=await(await post('/api/morning/preview',{part:'campus'})).json();
    assert.equal(preview.ok,true);assert.equal(preview.imageBytes,image.buffer.length);assert.equal(sent.length,0);
    assert.deepEqual(calls.at(-1).options,{scheduledMorning:true});
    const request={date:'2026-10-29',requestId:'b'.repeat(32)};
    assert.equal((await(await post('/api/campus/briefing',request)).json()).code,'SENT');assert.equal(sent.length,1);assert.equal(sent[0].ownerId,'owner');assert.equal(sent[0].groupId,undefined);assert.equal(sent[0].text,'');
    assert.equal((await(await post('/api/campus/briefing',request)).json()).code,'DUPLICATE');assert.equal(sent.length,1);
    await app.core.setPaused(true);const before=calls.length;
    assert.equal((await(await post('/api/campus/briefing',{...request,requestId:'c'.repeat(32)})).json()).code,'PAUSED');assert.equal(calls.length,before);
    assert.equal((await post('/api/campus/briefing',{...request,ownerId:'other'})).status,400);
  }finally{await app.close();}
});

test('real dedicated Python campus worker fails safely with no credentials and no model or QQ RPC',async()=>{
  const home=fileURLToPath(new URL('../',import.meta.url));
  const worker=new PythonAgentWorker({home,workerPath:join(home,'python','campus_worker.py'),maxLineBytes:262144});
  try{
    for(const extra of [{mode:'query'},{mode:'report',timeout_profile:'morning'}]){
      const result=await worker.run({type:'campus',args:{date:''},credentials:{},...extra},async()=>assert.fail('no RPC'),v=>validateCampusData(v.data));
      assert.equal(result.code,'CAMPUS_NOT_CONFIGURED');assert.deepEqual(result.rooms,[]);
    }
    const invalid=await worker.run({type:'campus',mode:'query',args:{},credentials:{},timeout_profile:'morning'},async()=>assert.fail('no RPC'),v=>validateCampusData(v.data));
    assert.equal(invalid.code,'CAMPUS_QUERY_FAILED');
  }finally{worker.close();}
});

test('only host-owned scheduled reports receive the fixed extended campus budget',async t=>{
  const home=await mkdtemp(join(tmpdir(),'qq-campus-morning-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const calls=[],worker={close(){},run:async(payload,_execute,finish)=>{
    calls.push(payload);return finish({data:campusFailure('CAMPUS_AUTH_FAILED'),artifact_id:null});
  }};
  const service=new CampusService({home,configStore:config,worker});
  await service.run({},'report');
  await service.run({},'query',{scheduledMorning:true});
  await service.run({},'report',{scheduledMorning:'true'});
  await service.run({},'report',{scheduledMorning:true});
  assert.ok(calls.slice(0,3).every(packet=>!Object.hasOwn(packet,'timeout_profile')));
  assert.equal(calls[3].timeout_profile,'morning');
  assert.deepEqual(calls[3].args,{date:''});
  assert.equal((await service.run({scheduledMorning:true},'report')).data.code,'CAMPUS_INVALID_DATE');
  assert.equal(calls.length,4);
});
