import test from 'node:test';
import assert from 'node:assert/strict';
import {RagHealthCheck} from '../src/rag-health.mjs';
import {createBridgeServer} from '../src/server.mjs';

const good = () => ({kind:'rag',requiredFeature:'weather',status:'ok',text:'乌孙古道相关资料。\n来源：https://example.org/source',
  ragTimings:{lexical_ms:1,embedding_ms:2,vector_ms:3,source_verify_ms:1,total_ms:7}});
const fake = (handler=async()=>good()) => ({calls:[],closed:false,
  async run(payload,execute,finish){this.calls.push(payload);return finish(await handler(payload,execute));},
  close(){this.closed=true;}});

test('RAG check accepts only two fixed read-only inputs and requires configuration',async()=>{
  const worker=fake(), check=new RagHealthCheck({worker,enabled:true});
  for(const input of [null,[],{}, {check:'save'}, {check:'knowledge',query:'private'},
    {check:'outdoor',namespace:'other'}, {check:'knowledge',path:'/secret'},
    {check:'knowledge',recipient:'owner'}, {check:'outdoor',destination_id:'other'}]) {
    assert.equal((await check.run(input)).statusCode,400);
  }
  assert.equal(worker.calls.length,0);
  const disabled=await new RagHealthCheck({worker,enabled:false}).run({check:'knowledge'});
  assert.equal(disabled.statusCode,503);assert.equal(disabled.body.code,'RAG_DISABLED');
  assert.equal(worker.calls.length,0);
});

test('knowledge check uses fixed shared query and no model, recipient or arbitrary RPC',async()=>{
  const worker=fake(async(payload,execute)=>{
    await assert.rejects(execute('send_message',{}),/RAG_CHECK_RPC_DENIED/);
    return good();
  });
  const result=await new RagHealthCheck({worker,enabled:true}).run({check:'knowledge'});
  assert.equal(result.statusCode,200);assert.equal(result.body.vectorVerified,true);
  assert.equal(result.body.text,good().text);assert.equal(result.body.elapsedMs>=0,true);
  const payload=worker.calls[0];
  assert.deepEqual(Object.keys(payload).sort(),['args','context','name','sessionKey','text','type']);
  assert.equal(payload.type,'rag');assert.equal(payload.name,'search_domain_knowledge');
  assert.deepEqual(payload.args,{query:'乌孙古道 路线 管理公告',domain:'outdoor',limit:2});
  assert.match(payload.sessionKey,/^[a-f0-9]{64}$/);assert.deepEqual(payload.context,{scope:'c2c'});
});

test('degradation, error and missing vector timing never claim vector success',async()=>{
  const rows=[{...good(),status:'degraded',errorCode:'RAG_VECTOR_UNAVAILABLE'},
    {...good(),status:'empty'}, {...good(),ragTimings:{lexical_ms:1,total_ms:1}},
    {...good(),status:'unavailable',errorCode:'RAG_STORE_UNAVAILABLE'},
    {...good(),errorCode:'private-token-must-not-leak'},
    {kind:'rag',requiredFeature:'memory',status:'unavailable',errorCode:'RAG_DISABLED',text:'未启用'}];
  for(const value of rows){
    const result=await new RagHealthCheck({worker:fake(async()=>value),enabled:true}).run({check:'knowledge'});
    assert.equal(result.statusCode,503);assert.equal(result.body.ok,false);
    assert.notEqual(result.body.vectorVerified,true);
    assert.doesNotMatch(JSON.stringify(result),/private-token/);
  }
});

test('outdoor check binds Dangling and tomorrow/next day in Beijing across year boundary',async()=>{
  const worker=fake(async()=>({...good(),status:'partial',text:'党岭逐日预报；气候正常值；路线开放待核。'}));
  const result=await new RagHealthCheck({worker,enabled:true,now:()=>Date.parse('2026-12-31T16:01:00Z')}).run({check:'outdoor'});
  assert.equal(result.statusCode,200);assert.equal(result.body.complete,false);
  assert.equal(result.body.status,'partial');assert.equal(result.body.vectorVerified,undefined);
  assert.deepEqual(worker.calls[0].args,{destination_id:'dangling',start_date:'2027-01-02',end_date:'2027-01-03'});
  assert.equal(worker.calls[0].name,'prepare_outdoor_trip');
});

test('check rejects concurrent work and redacts worker failures then releases its lock',async()=>{
  let release;
  const worker=fake(()=>new Promise(resolve=>{release=resolve;}));
  const check=new RagHealthCheck({worker,enabled:true});
  const first=check.run({check:'knowledge'});
  assert.equal((await check.run({check:'outdoor'})).body.code,'RAG_CHECK_BUSY');
  assert.equal(worker.calls.length,1);release(good());await first;
  worker.run=async()=>{throw Object.assign(Error('secret endpoint and path'),{timedOut:true});};
  const failed=await check.run({check:'knowledge'});
  assert.equal(failed.body.code,'RAG_CHECK_TIMEOUT');assert.doesNotMatch(JSON.stringify(failed),/secret/);
  worker.run=async(payload,execute,finish)=>finish(good());
  assert.equal((await check.run({check:'knowledge'})).statusCode,200);
});

async function fixture(enabled=true){
  const worker=fake(), sent=[];
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),state:null,
    async init(){},async readCredentials(){return null;},async loadState(){return structuredClone(this.state);},
    async saveState(value){this.state=structuredClone(value);}};
  const app=await createBridgeServer({port:0,store,agentWorker:worker,ragEnabled:enabled,
    campusService:{status:async()=>({enabled:false}),close(){}},
    adapterFactory:()=>({status:()=>({state:'disconnected'}),async disconnect(){},async send(value){sent.push(value);}})});
  const url='http://127.0.0.1:'+await app.listen();
  const request=(body,token=store.token,headers={})=>fetch(url+'/api/rag/check',{method:'POST',headers:{
    'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:JSON.stringify(body)});
  return {app,worker,sent,store,url,request};
}

test('admin RAG route rejects integration/anonymous/cross-origin and shares the only worker without QQ',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request({check:'knowledge'},null)).status,401);
    assert.equal((await f.request({check:'knowledge'},f.store.integrationToken)).status,403);
    assert.equal((await f.request({check:'knowledge'},f.store.token,{Origin:'https://attacker.invalid'})).status,403);
    assert.equal((await f.request({check:'knowledge',namespace:'private'})).status,400);
    assert.equal(f.worker.calls.length,0);
    const checked=await f.request({check:'knowledge'});
    assert.equal(checked.status,200);assert.equal((await checked.json()).vectorVerified,true);
    assert.equal(f.worker.calls.length,1);assert.equal(f.sent.length,0);
    assert.equal(f.app.core.status().dailyAttempts,0);
    assert.equal((await fetch(f.url+'/api/rag/check',{headers:{Authorization:'Bearer '+f.store.token}})).status,405);
  }finally{await f.app.close();}
  assert.equal(f.worker.closed,true);
});

test('admin RAG route reports disabled config without touching worker',async()=>{
  const f=await fixture(false);try{
    const checked=await f.request({check:'outdoor'});
    assert.equal(checked.status,503);assert.equal((await checked.json()).code,'RAG_DISABLED');
    assert.equal(f.worker.calls.length,0);assert.equal(f.sent.length,0);
  }finally{await f.app.close();}
});
