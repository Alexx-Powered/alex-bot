import test from 'node:test';
import assert from 'node:assert/strict';
import {HikingHealthCheck,indexWhenIdle} from '../src/hiking-health.mjs';
import {createBridgeServer} from '../src/server.mjs';
test('maintenance skips busy workers and sends only one host-owned index operation',async()=>{
  let calls=0;const worker={busy:true,async run(packet,rpc,finish){calls++;assert.deepEqual(packet,{type:'rag_index'});return finish({data:{processed:1,failed:0}});}};
  assert.equal((await indexWhenIdle(worker)).status,'busy');assert.equal(calls,0);
  worker.busy=false;assert.equal((await indexWhenIdle(worker)).processed,1);assert.equal(calls,1);
});
test('hiking diagnostics reject arbitrary destinations and inputs',async()=>{
  const check=new HikingHealthCheck({enabled:true,worker:{run(){throw Error('not called');}}});
  for(const input of [null,[],{}, {sample:'private'}, {sample:'haba',topic:'private'}, {sample:'__proto__'}])assert.equal((await check.run(input)).statusCode,400);
});
test('hiking preview and index maintenance are administrator only and cannot send',async()=>{
  let calls=0,sent=0;
  const worker={busy:false,close(){},async run(){calls++;return {kind:'rag',hikingCard:{schema:'hiking.card.v1',topic:'哈巴西坡',days:[],nights:[],message:'资料待补充。'}};}};
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),state:null,async init(){},async readCredentials(){return null;},async loadState(){return this.state;},async saveState(s){this.state=s;}};
  const app=await createBridgeServer({port:0,store,agentWorker:worker,ragEnabled:true,campusService:{status:async()=>({enabled:false}),close(){}},adapterFactory:()=>({status:()=>({state:'disconnected'}),async disconnect(){},async send(){sent++;}})});
  try{
    const base='http://127.0.0.1:'+await app.listen();
    for(const route of ['hiking/check','rag/index'])for(const token of [null,store.integrationToken]){
      const r=await fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(route==='rag/index'?{}:{sample:'haba'})});
      assert.equal(r.status,token?403:401);
    }
    assert.equal(calls,0);
    const r=await fetch(base+'/api/hiking/check',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+store.token},body:JSON.stringify({sample:'haba'})});
    assert.equal(r.status,200);const result=await r.json();assert.equal(result.qqSent,false);assert.equal(result.mediaReady,true);assert.equal(result.mimeType,'image/png');assert.equal(sent,0);
  }finally{await app.close();}
});
