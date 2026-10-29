import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncResource} from 'node:async_hooks';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {Telemetry} from '../src/telemetry.mjs';

test('prewarmed reusable worker assigns metadata-only timings to each current request, not its startup context',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-worker-trace-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const outside=new AsyncResource('neutral-stdout');let spawned=0;const sentAt=[];
 const worker=new PythonAgentWorker({home,spawnImpl:()=>{
   spawned++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
   child.stdin.on('data',chunk=>{const value=JSON.parse(chunk);sentAt.push(value._sentAtMs);setTimeout(()=>outside.runInAsyncScope(()=>child.stdout.write(JSON.stringify({type:'result',id:value.id,kind:'chat',startupMs:10,text:'sensitive reply must not be recorded',timings:[{name:'router_model',ms:12,offsetMs:0,inputTokens:123,text:'SECRET'}, {name:'arbitrary',ms:1,apiKey:'SECRET'}]})+'\n')),30);});return child;
 }});
 const telemetry=new Telemetry({home,configStore:{read:async()=>({enabled:false})}});
 try{
   assert.equal(worker.prewarm(),true);
   for(let i=0;i<2;i++)await telemetry.run({scope:'c2c'},()=>worker.run({type:'request',text:'SECRET'},async()=>{},v=>({ok:true,kind:v.kind})));
   const recent=(await telemetry.status()).recent;
   assert.equal(spawned,1);assert.equal(recent.length,2);
   for(const [index,row] of recent.entries()){
     const startup=row.stages.find(s=>s.name==='worker_startup'),model=row.stages.find(s=>s.name==='router_model');
     assert.equal(Date.parse(startup.startTime),sentAt[sentAt.length-1-index]);
     assert.equal(Date.parse(startup.endTime),Date.parse(model.startTime));
     assert.equal(model.ms,12);assert.ok(row.stages.some(s=>s.name==='worker_total'));
   }
   assert.doesNotMatch(JSON.stringify(recent),/SECRET|sensitive reply|arbitrary|apiKey/);
   await new Promise(r=>setTimeout(r,40));
 }finally{worker.close();outside.emitDestroy();}
});
