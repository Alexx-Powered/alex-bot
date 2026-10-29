import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBridgeServer} from '../src/server.mjs';
import {MonitoringConfigStore} from '../src/monitoring-config.mjs';

test('monitoring configuration and local traces stay admin-only and never echo a saved key',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-monitoring-api-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.private'));
 const codec=new Map();let sequence=0;
 const monitoringConfigStore=new MonitoringConfigStore(home,{protect:async value=>{const id='cipher-'+ ++sequence;codec.set(id,structuredClone(value));return id;},unprotect:async id=>codec.get(id)});
 const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
 const app=await createBridgeServer({home,port:0,store,monitoringConfigStore,adapterFactory:()=>({status:()=>({state:'disconnected'}),disconnect:async()=>{}})});
 try{
  const port=await app.listen();
  const request=async(route,body,token=store.token)=>fetch(`http://127.0.0.1:${port}/api/monitoring/${route}`,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  for(const route of ['status','config','test'])assert.equal((await request(route,route==='status'?undefined:{},store.integrationToken)).status,403);
  const key='private-only-langsmith-test-key';
  const saved=await(await request('config',{enabled:false,project:'alex-bot',apiKey:key})).json();
  assert.equal(saved.ok,true);assert.equal(saved.config.configured,true);assert.ok(!JSON.stringify(saved).includes(key));
  assert.equal((await monitoringConfigStore.read()).apiKey,key);
  const checked=await(await request('test',{})).json();assert.equal(checked.code,'MONITORING_TEST_QUEUED');
  await new Promise(r=>setTimeout(r,50));
  const status=await(await request('status')).json();assert.equal(status.ok,true);assert.ok(status.telemetry.recent.length);assert.ok(!JSON.stringify(status).includes(key));
  assert.equal(status.telemetry.recent[0].synthetic,true);assert.equal(status.telemetry.summary.count,0);
  assert.equal((await request('test',{text:'must reject arbitrary trace input'})).status,400);
 }finally{await app.close();}
});
