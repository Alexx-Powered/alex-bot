import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {CampusService,campusFailure,validateCampusData} from '../src/campus-service.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {fileURLToPath} from 'node:url';

const data=()=>({...campusFailure('OK','2026-10-29'),ok:true,buildings:['三号楼'],rooms:[{building:'三号楼',room:'(三)105',free_periods:[1,2],busy_periods:Array.from({length:12},(_,i)=>i+3)}]});
const config={status:async()=>({enabled:true,configured:true}),read:async()=>({enabled:true,username:'offline-student',password:'offline-password'})};
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
  const result=await service.execute({date:'2026-10-29'},{scope:'c2c'});
  assert.equal(received.credentials.password,'offline-password');assert.equal(result.image.mimeType,'image/png');
  assert.equal(result.text,'');assert.doesNotMatch(JSON.stringify(result.campusData),/offline-student|offline-password/);
  worker.run=async(_p,_e,finish)=>finish({kind:'campus',data:data(),artifact_id:'../../private'});
  assert.equal((await service.run({},'report')).data.code,'CAMPUS_QUERY_FAILED');
});
test('group queries, paused configuration and duplicate active queries do not access private worker',async()=>{
  let calls=0,release,entered;
  const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const service=new CampusService({home:'D:/unused',configStore:config,worker:{close(){},run:async(_p,_e,finish)=>{calls++;entered();await gate;return finish({data:campusFailure('CAMPUS_AUTH_FAILED'),artifact_id:null});}}});
  assert.equal(JSON.parse((await service.execute({},{scope:'group'})).text).code,'CAMPUS_OWNER_ONLY');assert.equal(calls,0);
  const first=service.run({});await start;
  assert.equal((await service.run({})).data.code,'CAMPUS_BUSY');release();await first;assert.equal(calls,1);
});
test('campus HTTP API authenticates all operations and sends one image only to the paired owner',async()=>{
  const sent=[],calls=[],store={token:'a'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const campus={status:async()=>({enabled:true,configured:true}),close(){},run:async(args,mode)=>{calls.push({args,mode});return {data:data(),image};}};
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
    const request={date:'2026-10-29',requestId:'b'.repeat(32)};
    assert.equal((await(await post('/api/campus/briefing',request)).json()).code,'SENT');assert.equal(sent.length,1);assert.equal(sent[0].ownerId,'owner');assert.equal(sent[0].groupId,undefined);assert.equal(sent[0].text,'');
    assert.equal((await(await post('/api/campus/briefing',request)).json()).code,'DUPLICATE');assert.equal(sent.length,1);
    await app.core.setPaused(true);const before=calls.length;
    assert.equal((await(await post('/api/campus/briefing',{...request,requestId:'c'.repeat(32)})).json()).code,'PAUSED');assert.equal(calls.length,before);
    assert.equal((await post('/api/campus/briefing',{...request,ownerId:'other'})).status,400);
  }finally{await app.close();}
});

test('fixed campus command works without model configuration; group fixed command cannot access campus account',async()=>{
  const calls=[];
  const service={handle:async(text,context)=>{if(text!=='查空教室')return null;calls.push(context.scope);return {text:context.scope==='c2c'?'fixed JSON':'owner only'};}};
  const agent=new ConversationAgent({campusTools:service,toolbox:{handle:async()=>null},configStore:{read:async()=>assert.fail('model config must not be read')},worker:{},modelBudget:{acquire:async()=>assert.fail('no model budget')}});
  assert.deepEqual(await agent.handle('查空教室',{scope:'c2c'}),{text:'fixed JSON'});
  assert.deepEqual(await agent.handle('查空教室',{scope:'group'}),{text:'owner only'});
  assert.deepEqual(calls,['c2c','group']);
});

test('real dedicated Python campus worker fails safely with no credentials and no model or QQ RPC',async()=>{
  const home=fileURLToPath(new URL('../',import.meta.url));
  const worker=new PythonAgentWorker({home,workerPath:join(home,'python','campus_worker.py'),maxLineBytes:262144});
  try{
    const result=await worker.run({type:'campus',mode:'query',args:{date:''},credentials:{}},async()=>assert.fail('no RPC'),v=>validateCampusData(v.data));
    assert.equal(result.code,'CAMPUS_NOT_CONFIGURED');assert.deepEqual(result.rooms,[]);
  }finally{worker.close();}
});
