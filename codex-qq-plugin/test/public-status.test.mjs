import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {PublicStatusService,parseStatusCommand} from '../src/public-status.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {APP_ROOT,pythonExecutable} from '../src/runtime-paths.mjs';

test('fixed status commands separate balance, ordinary complaints and electronics',()=>{
  for(const text of ['查DeepSeek状态','/ds状态','查询一下 ds 服务状态？'])assert.equal(parseStatusCommand(text),'deepseek_service_status');
  for(const text of ['查滑动变祖器状态','查询滑动变阻器实时状态','/梁状态'])assert.equal(parseStatusCommand(text),'liang_status');
  for(const text of ['查DeepSeek余额','DeepSeek说话好僵硬','变阻器阻值怎么算','https://example.invalid/status'])assert.equal(parseStatusCommand(text),null);
});

test('only whitelisted status tools, no keys/URLs/recipients; gray denied before process',async()=>{
  let count=0;const service=new PublicStatusService({home:APP_ROOT,worker:{run:async()=>{count++;throw Error('unexpected');},close(){}}});
  await assert.rejects(service.execute('run_command',{}, {scope:'c2c'}));
  await assert.rejects(service.execute('liang_status',{url:'http://127.0.0.1'}, {scope:'c2c'}));
  assert.match((await service.execute('liang_status',{}, {scope:'group',access:'gray'})).text,/灰名单/);
  assert.equal(count,0);
});

test('caption and image survive the real service boundary; artifact is consumed and removed',async()=>{
  const tempRoot=await fs.realpath(os.tmpdir());
  const home=await fs.mkdtemp(path.join(tempRoot,'alex-status-'));
  const folder=path.join(home,'.private','public-status');await fs.mkdir(folder,{recursive:true});
  const id='a'.repeat(32),file=path.join(folder,id+'.png');
  const png=createCanvas(1080,400).toBuffer('image/png');await fs.writeFile(file,png);
  let packet;const service=new PublicStatusService({home,worker:{run:async(p,_e,finish)=>{packet=p;return finish({kind:'analysis',data:{service:'liang',source:'https://liang.itsuyo.top/',checked_at:new Date().toISOString(),ok:true,artifact_id:id,text:'梁圣 · 22.4794 级\n来源：https://liang.itsuyo.top/'}});},close(){}}});
  try{
    const reply=await service.execute('liang_status',{}, {scope:'c2c'});
    assert.equal(reply.richMedia,true);assert.deepEqual(reply.image.buffer,png);assert.match(reply.text,/22.4794/);
    assert.deepEqual(packet,{type:'public_status',name:'liang_status',args:{}});
    await assert.rejects(fs.stat(file),{code:'ENOENT'});
  }finally{assert.equal(path.dirname(await fs.realpath(home)),tempRoot);assert.ok(path.basename(home).startsWith('alex-status-'));await fs.rm(home,{recursive:true,force:true});}
});

test('malformed/stale worker snapshots and authorization changes never send an image',async()=>{
  for(const overrides of [{source:'https://status.deepseek.com/'},{artifact_id:'../../secret'},{checked_at:'2026-01-01T00:00:00Z'}]){
    const service=new PublicStatusService({home:APP_ROOT,worker:{run:async(_p,_e,finish)=>finish({kind:'analysis',data:{service:'liang',source:'https://liang.itsuyo.top/',checked_at:new Date().toISOString(),ok:true,artifact_id:'a'.repeat(32),text:'来源：https://liang.itsuyo.top/',...overrides}}),close(){}}});
    assert.equal((await service.execute('liang_status',{}, {scope:'c2c'})).image,undefined);
  }
  let allowed=true;
  const service=new PublicStatusService({home:APP_ROOT,worker:{run:async()=>{allowed=false;return {image:{}};},close(){}}});
  assert.match((await service.execute('liang_status',{}, {scope:'group',access:'white',authorize:()=>allowed})).text,/灰名单/);
});

test('fixed status requests work with model config disabled and no budget or model Key',async()=>{
  const reply={text:'DeepSeek 正常\n来源：https://status.deepseek.com/',richMedia:true,image:{buffer:Buffer.alloc(12),mimeType:'image/png'},requiredAccess:'white'};
  const statusTools={handle:async text=>parseStatusCommand(text)?reply:null};
  const agent=new ConversationAgent({statusTools,toolbox:{handle:async()=>assert.fail()},configStore:{read:async()=>assert.fail('no Key read')},modelBudget:{acquire:async()=>assert.fail('no model call')}});
  assert.equal(await agent.handle('查DeepSeek状态',{scope:'c2c'}),reply);
});

test('natural language uses a real Node → Python → LangChain → Node tool call',async()=>{
  const worker=new PythonAgentWorker({home:APP_ROOT,pythonPath:pythonExecutable(),workerPath:path.join(APP_ROOT,'test','fixtures','public-status-worker.py'),timeoutMs:15000});
  const calls=[];const result={text:'滑动变祖器：梁圣\n来源：https://liang.itsuyo.top/',richMedia:true,image:{buffer:Buffer.alloc(10),mimeType:'image/png'},requiredAccess:'white'};
  const agent=new ConversationAgent({worker,statusTools:{handle:async()=>null,execute:async(name,args,context)=>{calls.push({name,args,scope:context.scope});return result;}},toolbox:{handle:async()=>null},
    configStore:{read:async()=>({enabled:true,apiKey:'offline-test-key',model:'deepseek-flash',baseURL:'https://api.deepseek.com'})},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})}});
  try{
    const answer=await agent.handle('滑动变祖器现在几级了',{scope:'c2c',sessionKey:'offline-public-status'});
    assert.equal(answer,result);assert.deepEqual(calls,[{name:'liang_status',args:{},scope:'c2c'}]);
  }finally{worker.close();}
});
