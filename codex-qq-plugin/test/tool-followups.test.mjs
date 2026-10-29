import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {APP_ROOT,pythonExecutable} from '../src/runtime-paths.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {ConversionToolbox} from '../src/conversion-tools.mjs';

test('real Node→Python LangChain followups share typed facts, preserve sensitive permissions and fixed no-key conversions',async t=>{
 if(!existsSync(pythonExecutable())){t.skip('Install Python environment first');return;}
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-tool-followups-'));
 t.after(async()=>{assert.equal(path.dirname(home),os.tmpdir());assert.ok(path.basename(home).startsWith('qq-tool-followups-'));await fs.rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
 const launcher=path.join(home,'fixture.py');
 const fixture=`import sys\nsys.path.insert(0,${JSON.stringify(path.join(APP_ROOT,'python'))})\nimport agent_worker as worker\nfrom test_agent_worker import ScriptedModel,call\nmodel=ScriptedModel(responses=[call('convert_previous_result',{'to_unit':'HU$'}),call('convert_previous_result',{'to_unit':'m'}),call('convert_previous_result',{'to_unit':'HU$'}),call('convert_previous_result',{'to_unit':'HU$'})])\nworker.read_balance=lambda _: 'DeepSeek API 账户余额：\\n可用 4.09 CNY（赠金 0.00，充值余额 4.09）\\n可供 API 调用：是\\n查询时间：10-29 21:51（北京时间）'\noriginal=worker.build_runner\nworker.build_runner=lambda **kw: original(model_factory=lambda _:model,**kw)\nworker.main()\n`;
 await fs.writeFile(launcher,fixture);
 const worker=new PythonAgentWorker({home,workerPath:launcher});
 const conversionTools=new ConversionToolbox(worker);
 const agent=new ConversationAgent({worker,conversionTools,toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-test-key',model:'deepseek-flash',baseURL:'https://api.deepseek.com'})},policyLoader:async()=>({enabled:false,topics:[],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})}});
 try{
  const context={scope:'c2c',sessionKey:'a'.repeat(64)};
  assert.match((await agent.handle('查DeepSeek余额',context)).text,/4\.09 CNY/);
  const converted=await agent.handle('换算成古月币是多少？',context);
  assert.match(converted.text,/4\.09 元 ≈ 0\.035057 HU\$/);assert.equal(converted.sensitive,true);
  assert.deepEqual(await agent.handle('1马里换公里',context),{text:'1 马里 = 3.08 km'});
  assert.match((await agent.handle('那换成米呢',context)).text,/1 马里 = 3080 m/);
  const group={scope:'group',access:'white',sessionKey:'b'.repeat(64),groupContext:[]};
  await agent.handle('查DeepSeek余额',group);
  const derived=await agent.handle('换成古月币呢',group);
  assert.equal(derived.requiredAccess,'white');assert.equal(derived.sensitive,true);assert.match(derived.text,/0\.035057/);
  const gray=await agent.handle('那换成古月币呢',{...group,access:'gray'});
  assert.doesNotMatch(gray.text,/4\.09|0\.035057/);
 }finally{worker.close();}
});
