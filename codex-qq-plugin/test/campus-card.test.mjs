import {pythonExecutable} from '../src/runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CampusService,campusFailure} from '../src/campus-service.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
const home=fileURLToPath(new URL('..',import.meta.url));
test('an ignored request does not trigger rule-based campus dispatch',async()=>{
  const image={mimeType:'image/png'};let calls=0,recovered=0;
  const agent=new ConversationAgent({campusTools:{handle:async()=>null,recoverIgnored:async(text,context)=>{recovered++;assert.equal(text,'今天三号楼的空教室情况');assert.equal(context.access,'white');return {image,text:'',requiredAccess:'white'};}},
    toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-model-key'})},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})},
    worker:{run:async(_packet,_execute,finish)=>{calls++;return finish({kind:'ignore'});}}});
  const result=await agent.handle('今天三号楼的空教室情况',{scope:'group',access:'white'});
  assert.ok(result.ignored);assert.equal(result.requiredAccess,'chat');assert.equal(calls,1);assert.equal(recovered,0);
});

test('a real LangChain recommendation reads a pre-migration snapshot and returns a PNG through the gateway',async t=>{
  const folder=await mkdtemp(path.join(tmpdir(),'qq-campus-worker-'));
  const tomorrow=new Date(Date.now()+32*3600000).toISOString().slice(0,10);
  const script=path.join(folder,'offline_school.py');
  await writeFile(script,[
    'import sys','sys.path.insert(0,'+JSON.stringify(path.join(home,'python'))+')',
    'import agent_worker','from test_agent_worker import ScriptedModel, call','from langchain_core.messages import AIMessage',
    "model=ScriptedModel(responses=[call('buaa_classroom_recommend',{'date':'"+tomorrow+"','regions':['新主楼A座'],'session':'evening'}),AIMessage(content='优先看看A101。')])",
    'agent_worker.default_model_factory=lambda _:model','agent_worker.main()'
  ].join('\n'),'utf8');
  const worker=new PythonAgentWorker({home:folder,pythonPath:pythonExecutable(),workerPath:script});
  t.after(()=>{worker.close();return rm(folder,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const room={building:'新主楼',room:'A101',free_periods:Array.from({length:14},(_,i)=>i+1),busy_periods:[]};
  const data={...campusFailure('OK',tomorrow),ok:true,buildings:['新主楼'],rooms:[room]};
  const output=path.join(folder,'.private','campus-output');await mkdir(output,{recursive:true});
  await writeFile(path.join(output,'memory.json'),JSON.stringify({version:1,snapshots:[data]}));
  const campus=new CampusService({home:folder,worker:{},configStore:{
    status:async()=>({enabled:true,configured:true}),read:async()=>assert.fail('recommendation read credentials')
  }});
  const context={scope:'group',access:'white',groupContext:[],currentSpeaker:'member-a'};
  const packet={type:'request',replyFormat:'attachment-v1',text:'明天晚上新主楼A座哪间教室能去？',sessionKey:'offline-school',
    now:new Date().toISOString(),context,config:{enabled:true,apiKey:'offline-model-key',model:'deepseek-flash',baseURL:'https://api.deepseek.com'},
    policy:{enabled:false,topics:[],maxChars:600,instructions:''}};
  const outputReply=await worker.run(packet,()=>assert.fail('legacy callback'),value=>value.reply,
    (_feature,tool)=>campus.workerGrant(tool,context),{allowed:()=>true});
  assert.equal(outputReply.text,'');assert.equal(outputReply.image.mimeType,'image/png');
  assert.equal(outputReply.image.buffer.readUInt32BE(16),1080);
});
