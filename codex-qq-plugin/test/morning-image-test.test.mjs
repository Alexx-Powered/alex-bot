import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeServer} from '../src/server.mjs';
import {beijingDay} from '../src/weather-commands.mjs';
import {createMcpServer} from '../src/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

async function fixture(){
  const sent=[],image={buffer:Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),mimeType:'image/png'};let enabled=false,calls=0,valid=true;
  const store={token:'a'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const app=await createBridgeServer({port:0,store,isMorningEnabled:async()=>enabled,morningReport:{create:async()=>{calls++;return {date:beijingDay(),image,analysis:valid?{version:'morning-rules-v1'}:{}};}},adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async r=>{sent.push(r);return {ok:true};}})});
  const pair=await app.core.startPairing();await app.core.handleMessage({kind:'c2c',id:'pair',senderId:'owner',text:'/pair '+pair.pairingCode});await app.core.confirmPairing();
  const binding=await app.core.startGroupPairing({name:'测试群'});
  await app.core.handleMessage({kind:'group',id:'bind',senderId:'member',groupId:'group-1',text:'/group-bind '+binding.groupPairingCode,replyTarget:{scope:'group',targetId:'group-1',msgId:'bind'}});
  await app.core.confirmGroupPairing({groupKey:app.core.status().pendingGroup.groupKey});
  const port=await app.listen();
  const request=(body,auth=true)=>fetch('http://127.0.0.1:'+port+'/api/morning/test-all-allowed',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+store.token}:{})},body:JSON.stringify(body)});
  return {app,sent,image,request,get calls(){return calls;},enable(){enabled=true;},invalidAnalysis(){valid=false;}};
}
test('morning test endpoint generates one image for owner+whitelisted group; no target/upload input',async()=>{
  const f=await fixture();try{
    assert.equal((await f.request({idempotencyKey:'test-1'},false)).status,401);
    assert.equal((await(await f.request({idempotencyKey:'test-1'})).json()).code,'MORNING_NOT_ENABLED');assert.equal(f.calls,0);
    f.enable();
    for(const extra of [{groupId:'attacker'},{image:'arbitrary'},{cities:['广州']},{url:'https://example.com'}])assert.equal((await f.request({idempotencyKey:'test-1',...extra})).status,400);
    const result=await(await f.request({idempotencyKey:'test-1'})).json();assert.equal(result.ok,true);assert.equal(result.sent,2);assert.equal(f.calls,1);
    assert.equal(f.sent.length,2);assert.deepEqual(f.sent.map(r=>r.text),['','']);assert.ok(f.sent.every(r=>r.image===f.image));assert.equal(f.sent[1].groupId,'group-1');assert.equal(f.sent[1].proactiveGroup,true);
    assert.equal((await f.app.core.notifyImageAllAllowed({image:f.image,idempotencyKey:'test-1'})).code,'DUPLICATE');assert.equal(f.sent.length,2);
  }finally{await f.app.close();}
});
test('fallback exercise analysis is not broadcast as a successful enhanced test',async()=>{
  const f=await fixture();try{f.enable();f.invalidAnalysis();const r=await(await f.request({idempotencyKey:'invalid'})).json();assert.equal(r.code,'MORNING_ANALYSIS_UNAVAILABLE');assert.equal(f.sent.length,0);}finally{await f.app.close();}
});
test('morning test MCP accepts only a stable key and delegates one generated-image request',async()=>{
  let calls=0;const server=createMcpServer({morningTestAllAllowed:async args=>{calls++;assert.deepEqual(args,{idempotencyKey:'once'});return {ok:true,code:'SENT',results:[],attempted:2,sent:2};}});
  const client=new Client({name:'morning-test-client',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
  try{await server.connect(a);await client.connect(b);const ok=await client.callTool({name:'qq_morning_test',arguments:{idempotencyKey:'once'}});assert.equal(ok.isError,false);const bad=await client.callTool({name:'qq_morning_test',arguments:{idempotencyKey:'once',groupId:'attacker'}});assert.equal(bad.isError,true);assert.equal(calls,1);}finally{await client.close();await server.close();}
});
