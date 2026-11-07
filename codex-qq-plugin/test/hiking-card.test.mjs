import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadImage} from '@napi-rs/canvas';
import {parseHikingCommand,renderHikingCard,validateHikingCard} from '../src/hiking-card-image.mjs';
import {PythonAgentWorker,pythonEnvironment} from '../src/python-agent.mjs';
import {pythonExecutable} from '../src/runtime-paths.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';

function fixture(n=3){
  const days=Array.from({length:n},(_,i)=>({date:'2026-11-'+String(i+7).padStart(2,'0'),route:['起点村','山脊营地'],sleep:i<n-1?{name:'山脊营地',kind:'tent'}:null,distance:12,
    stats:{min:-3,max:12,cloud:45,precip:1,rain:1,snow:0,gust:8},series:Array.from({length:24},(_,h)=>[h<8?-3:12,45,h===12?1:0,h===12?1:0,0,8,h<8?0:1])}));
  return {schema:'hiking.card.v1',topic:'合成测试路线',variant:'多日穿越',start:'2026-11-07',status:'ok',retrieved:'2026-11-07T09:00:00+08:00',days,
    nights:days.slice(0,-1).map((_,i)=>({day:i+1,name:'山脊营地',kind:'tent',low:-3,comfort:-8})),sources:[],missing:[],alternate:null,season:'仅用于布局和协议测试。'};
}
test('fixed hiking grammar accepts date and inn without a model',()=>{
  assert.deepEqual(parseHikingCommand('发 徒步 党岭 2026-11-14 不露营'),{destination:'党岭',start_date:'2026-11-14',overnight:'inn'});
  assert.equal(parseHikingCommand('去党岭徒步天气如何？'),null);
  assert.equal(parseHikingCommand('发 徒步 https://evil.test'),null);
});
test('card bounds reject oversized or malformed worker payloads',()=>{
  const value=fixture();value.days[0].series[0][0]=Infinity;assert.throws(()=>validateHikingCard(value),/INVALID/);
  assert.throws(()=>validateHikingCard(fixture(15)),/INVALID/);
});
test('3 and 14 walking days retain readable day width within canvas memory budget',async()=>{
  const small=await loadImage((await renderHikingCard(fixture(3))).buffer),long=await loadImage((await renderHikingCard(fixture(14))).buffer);
  assert.ok(small.width>2000);assert.ok(long.width>small.width);
  assert.ok(long.width<=6001);assert.ok(long.width*long.height<=18_020_000);
});
test('new fixed command cannot bypass group weather permission',async()=>{
  const agent=new ConversationAgent({worker:{run(){throw Error('MUST_NOT_EXECUTE');}},ragEnabled:true,modelBudget:{acquire(){throw Error('MUST_NOT_CALL_MODEL');}}});
  const features={...defaultGroupFeatures(),weather:false};
  const result=await agent.handle('发 徒步 党岭',{scope:'group',access:'white',features,sessionKey:'a'.repeat(64)});
  assert.equal(result.image,undefined);assert.ok(result.text);
});
test('real Node to Python LangChain produces image without model config or QQ',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),parent=path.join(root,'test-output','hiking-node');await mkdir(parent,{recursive:true});
  const home=await mkdtemp(path.join(parent,'run-')),config=path.join(home,'rag.json'),store=path.join(home,'rag.sqlite3');
  await writeFile(config,JSON.stringify({enabled:true,store_path:store}));
  const python=pythonExecutable();execFileSync(python,['-c','import sys;sys.path.insert(0,sys.argv[1]);from rag_store import RagStore;RagStore(sys.argv[2]).put_document(namespace="shared",visibility="shared",domain="outdoor",title="fixture",text="test reference",source_ref="https://example.org/fixture")',path.join(root,'python'),store],{env:pythonEnvironment(),windowsHide:true});
  const worker=new PythonAgentWorker({home,pythonPath:python,spawnImpl:(exe,args,options)=>spawn(exe,args,{...options,env:{...options.env,QQ_RAG_CONFIG:config}})});
  try{
    const agent=new ConversationAgent({worker,ragEnabled:true,configStore:{read(){throw Error('MODEL_CONFIG_DENIED');}},modelBudget:{acquire(){throw Error('MODEL_BUDGET_DENIED');}}});
    const reply=await agent.handle('发 徒步 合成测试山',{scope:'c2c',sessionKey:'a'.repeat(64)});
    assert.equal(reply.text,'');assert.ok(Buffer.isBuffer(reply.image.buffer));assert.equal(reply.image.mimeType,'image/png');assert.ok((await loadImage(reply.image.buffer)).width>1000);
  }finally{worker.close();await new Promise(r=>setTimeout(r,200));await rm(home,{recursive:true,force:true});}
});
