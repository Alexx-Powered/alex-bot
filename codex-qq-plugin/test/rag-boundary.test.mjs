import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PythonAgentWorker,pythonEnvironment} from '../src/python-agent.mjs';
import {pythonExecutable} from '../src/runtime-paths.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';
import {Telemetry,setTraceMessage} from '../src/telemetry.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));

test('real Node stdio invokes canonical LangChain RAG tools without model or QQ',async()=>{
  const parent=path.join(root,'test-output','rag-node');await mkdir(parent,{recursive:true});
  const home=await mkdtemp(path.join(parent,'run-'));
  const store=path.join(home,'rag.sqlite3'),config=path.join(home,'rag.json');
  await writeFile(config,JSON.stringify({enabled:true,store_path:store,outdoor:{climate_path:path.join(home,'climate.sqlite3'),
    locations:[{id:'beijing',name:'北京',latitude:39.905,longitude:116.4053}]}}));
  const python=pythonExecutable();
  const seed='import sys;sys.path.insert(0,sys.argv[1]);from rag_store import RagStore;RagStore(sys.argv[2]).put_document(namespace="shared",visibility="shared",domain="campus",title="Fixture rules",text="Room A101 opens on weekdays, except holidays.",source_ref="https://example.edu/rules")';
  execFileSync(python,['-c',seed,path.join(root,'python'),store],{windowsHide:true,timeout:30000,env:pythonEnvironment()});
  const worker=new PythonAgentWorker({home,pythonPath:python,timeoutMs:30000,
    spawnImpl:(exe,args,options)=>spawn(exe,args,{...options,env:{...options.env,QQ_RAG_CONFIG:config}})});
  try{
    const base={type:'rag',text:'lookup A101',sessionKey:'a'.repeat(64),context:{scope:'c2c'}};
    const result=await worker.run({...base,name:'search_domain_knowledge',args:{query:'A101',domain:'campus'}},()=>{throw Error('RPC forbidden');},x=>x);
    assert.equal(result.kind,'rag');assert.equal(result.requiredFeature,'campus');
    assert.match(result.text,/except holidays/);assert.match(result.text,/https:\/\/example.edu\/rules/);
    const trip=await worker.run({...base,name:'prepare_outdoor_trip',args:{destination_id:'beijing',start_date:'2050-11-07',end_date:'2050-11-08'}},()=>{throw Error('RPC forbidden');},x=>x);
    assert.equal(trip.kind,'rag');assert.equal(trip.requiredFeature,'weather');
    assert.match(trip.text,/季节参考/);assert.match(trip.text,/暂无可用预报/);assert.ok(trip.text.length<=1600);
    const directAgent=new ConversationAgent({worker,ragEnabled:true,toolbox:{handle:async()=>null},
      configStore:{read:async()=>({enabled:false})},
      modelBudget:{acquire:async()=>{throw Error('MODEL_BUDGET_MUST_NOT_BE_USED');}}});
    const saved=await directAgent.handle('保存项目 天气助手：使用 ECMWF 数据。',{scope:'c2c',sessionKey:'a'.repeat(64)});
    assert.match(saved.text,/已保存/);
    const deleted=await directAgent.handle('删除项目 天气助手',{scope:'c2c',sessionKey:'a'.repeat(64)});
    assert.match(deleted.text,/已删除/);
    const exported=[];
    const telemetry=new Telemetry({home,configStore:{read:async()=>({enabled:true,apiKey:'test-rag-only-key',project:'rag-offline-test',endpoint:'https://api.smith.langchain.com',workspaceId:''})},
      fetchImpl:async(url,request)=>{exported.push(JSON.parse(request.body));return {ok:true,status:202};}});
    const empty=await telemetry.run({scope:'c2c'},async()=>{
      setTraceMessage('回忆我的项目');
      return worker.run({...base,name:'recall_project_notes',args:{query:'A101'}},()=>{throw Error('RPC forbidden');},x=>x);
    });
    assert.doesNotMatch(empty.text,/opens on weekdays/);
    for(let i=0;i<100;i++){
      const status=await telemetry.status();
      if(status.langsmith.pending===0&&status.local.lastCode==='SAVED')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(exported.some(run=>run.name==='rag_lexical'));
    assert.ok(exported.some(run=>run.name==='rag_vector'&&run.error?.includes('RAG_VECTOR_NOT_CONFIGURED')));
    assert.ok(exported.some(run=>run.name==='rag_retrieval'&&run.error));
    assert.ok(exported[0].error);
    assert.ok(JSON.stringify(exported).includes('回忆我的项目'));
    assert.ok(!JSON.stringify(exported).includes('opens on weekdays'));
  }finally{
    worker.close();
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(path.dirname(path.resolve(home)),path.resolve(parent));
    await rm(home,{recursive:true,force:true});
  }
});

test('outdoor completion rechecks weather permission and uses one routing budget',async()=>{
  let allowed=true,acquired=0;
  const context={scope:'group',access:'white',sessionKey:'a'.repeat(64),features:defaultGroupFeatures('white'),
    currentSpeaker:'member-1',groupContext:[],allowsFeature:()=>allowed,authorize:()=>allowed};
  const worker={run:async(payload,execute,finish)=>{assert.equal(payload.type,'request');allowed=false;return finish({kind:'rag',requiredFeature:'weather',text:'private trip report'});}};
  const agent=new ConversationAgent({worker,toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-key'})},
    policyLoader:async()=>({enabled:false,topics:[],instructions:'',maxChars:600}),modelBudget:{acquire:async()=>{acquired++;return {ok:true};}}});
  const result=await agent.handle('周末去党岭徒步，天气与装备怎么样',context);
  assert.equal(acquired,1);assert.doesNotMatch(result.text,/private trip report/);
});

test('online routing asks the model about a project without first attempting a write',async()=>{
  const types=[];let acquired=0;
  const worker={run:async(payload,execute,finish)=>{types.push(payload.type);return finish(payload.type==='rag_control'?{kind:'ignore'}:{kind:'clarify',reason:'ignore'});}};
  const agent=new ConversationAgent({worker,ragEnabled:true,toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-key'})},
    policyLoader:async()=>({enabled:false,topics:[],instructions:'',maxChars:600}),modelBudget:{acquire:async()=>{acquired++;return {ok:true};}}});
  await agent.handle('保存项目是否有必要？',{scope:'c2c',sessionKey:'a'.repeat(64)});
  assert.deepEqual(types,['request']);assert.equal(acquired,1);
});

test('RAG output rechecks live group permission and preserves complete sourced evidence',async()=>{
  let allowed=true;
  const context={scope:'group',access:'white',sessionKey:'a'.repeat(64),features:defaultGroupFeatures('white'),
    currentSpeaker:'member-1',groupContext:[],allowsFeature:()=>allowed,authorize:()=>allowed};
  const complete='规则。'.repeat(210)+'节假日不开放。\n来源：https://example.edu/rules';
  const worker={run:async(payload,execute,finish)=>finish({kind:'rag',requiredFeature:'campus',text:complete})};
  const agent=new ConversationAgent({worker,toolbox:{handle:async()=>null},
    configStore:{read:async()=>({enabled:true,apiKey:'offline-key'})},
    policyLoader:async()=>({enabled:false,topics:[],instructions:'',maxChars:600}),
    modelBudget:{acquire:async()=>({ok:true})}});
  let result=await agent.handle('测试楼开放规则',context);
  assert.match(result.text,/节假日不开放。/);assert.match(result.text,/https:\/\/example.edu\/rules/);
  worker.run=async(payload,execute,finish)=>{allowed=false;return finish({kind:'rag',requiredFeature:'campus',text:complete});};
  result=await agent.handle('测试楼开放规则',context);
  assert.doesNotMatch(result.text,/节假日不开放。/);
});
