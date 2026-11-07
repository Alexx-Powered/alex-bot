import test from 'node:test';
import assert from 'node:assert/strict';
import {ResearchHealthCheck,researchSamples} from '../src/research-health.mjs';
import {createBridgeServer} from '../src/server.mjs';

test('fixed research samples use the existing worker and forbid arbitrary RPC',async()=>{
  const calls=[];
  const check=new ResearchHealthCheck({enabled:true,worker:{async run(payload,execute,finish){
    calls.push(payload);await assert.rejects(execute('send_message',{}),/RESEARCH_CHECK_RPC_DENIED/);
    return finish({kind:'rag',requiredFeature:'weather',status:'queued',text:'已登记资料补充。'});
  }}});
  for(const sample of Object.keys(researchSamples)){
    const result=await check.run({sample});assert.equal(result.statusCode,200);assert.equal(result.body.qqSent,false);
    const call=calls.at(-1);assert.deepEqual(call.args,{topic:researchSamples[sample]});
    assert.equal(call.name,'request_outdoor_research');assert.deepEqual(call.context,{scope:'c2c'});
    assert.match(call.sessionKey,/^[a-f0-9]{64}$/);
  }
  for(const input of [{sample:'unknown'},{sample:'haba',topic:'private'},{sample:'__proto__'},null,[]])
    assert.equal((await check.run(input)).statusCode,400);
  assert.equal(calls.length,5);
});

test('disabled, malformed, secret errors and overlapping requests fail without leaking',async()=>{
  const worker={run:async()=>{throw Error('a-secret');}};
  assert.equal((await new ResearchHealthCheck({worker}).run({sample:'haba'})).body.code,'RESEARCH_DISABLED');
  const check=new ResearchHealthCheck({worker,enabled:true});
  assert.doesNotMatch(JSON.stringify(await check.run({sample:'haba'})),/a-secret/);
  worker.run=async()=>({kind:'rag',requiredFeature:'memory',status:'completed',text:'private'});
  assert.equal((await check.run({sample:'haba'})).statusCode,503);
  let release;worker.run=()=>new Promise(resolve=>{release=resolve;});
  const first=check.run({sample:'haba'});assert.equal((await check.run({sample:'haba'})).statusCode,409);
  release({kind:'rag',requiredFeature:'weather',status:'completed',text:'来源已获取'});
  assert.equal((await first).statusCode,200);
});

test('natural sample uses a fixed question and private model config without exposing it',async()=>{
  let payload;
  const check=new ResearchHealthCheck({enabled:true,configStore:{read:async()=>({enabled:true,apiKey:'sample-secret'})},
    worker:{run:async value=>{payload=value;return {kind:'rag',requiredFeature:'weather',status:'queued',text:'已登记'};}}});
  const result=await check.run({sample:'fudao',mode:'natural'});
  assert.equal(result.statusCode,200);assert.equal(payload.type,'request');
  assert.equal(payload.text,'福州福道适合徒步吗？有哪些路线资料？');
  assert.equal(payload.policy.enabled,false);assert.equal(payload.config.apiKey,'sample-secret');
  assert.doesNotMatch(JSON.stringify(result),/sample-secret/);
});

test('research route is administrator only, rejects cross origin and never sends QQ',async()=>{
  let calls=0,sent=0;
  const worker={prewarm(){},close(){},async run(){calls++;return {kind:'rag',requiredFeature:'weather',status:'queued',text:'已登记'};}};
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),state:null,
    async init(){},async readCredentials(){return null;},async loadState(){return this.state;},async saveState(value){this.state=value;}};
  const app=await createBridgeServer({port:0,store,agentWorker:worker,ragEnabled:true,
    campusService:{status:async()=>({enabled:false}),close(){}},
    adapterFactory:()=>({status:()=>({state:'disconnected'}),async disconnect(){},async send(){sent++;}})});
  try{
    const url='http://127.0.0.1:'+await app.listen()+'/api/research/check';
    const call=(token,extra={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',
      ...(token?{Authorization:'Bearer '+token}:{}),...extra},body:JSON.stringify({sample:'xianhu'})});
    assert.equal((await call(null)).status,401);assert.equal((await call(store.integrationToken)).status,403);
    assert.equal((await call(store.token,{Origin:'https://other.invalid'})).status,403);assert.equal(calls,0);
    assert.equal((await call(store.token)).status,200);assert.equal(calls,1);assert.equal(sent,0);
  }finally{await app.close();}
});
