import {pythonExecutable} from '../src/runtime-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const home=fileURLToPath(new URL('..',import.meta.url));

test('real LangChain tool defaults cross the Python/Node boundary and remain compatible with the previous default contract',()=>{
  const program=`import sys,json
sys.path.insert(0,'python')
import agent_worker
from test_agent_worker import ScriptedModel,packet,call
results=[]
for text,args in [('我现在去哪个教室自习？',{}),('现在有什么空教室能去？',{'session':'now'}),('给我推荐个能自习的教室',{'regions':[]}),('主M和新主楼A座',{'regions':['主M','新主楼A座']})]:
 model=ScriptedModel(responses=[call('buaa_classroom_recommend',args)])
 runner=agent_worker.build_runner(model_factory=lambda _:model,rpc_callback=lambda _id,_call,_name,values:results.append({'text':text,'args':values}) or 'ok')
 runner.run(packet(text=text,context={'scope':'c2c'}))
print(json.dumps(results,ensure_ascii=False))`;
  const rows=JSON.parse(execFileSync(pythonExecutable(),['-B','-X','utf8','-c',program],{cwd:home,windowsHide:true,encoding:'utf8'}));
  assert.equal(rows.length,4);
  for(const row of rows.slice(0,3)){
    assert.equal(row.args.date,'');assert.equal(row.args.session,'now');
    assert.equal(Object.hasOwn(row.args,'regions'),false);assert.equal(Object.hasOwn(row.args,'building'),false);
    assert.deepEqual(row.args,{date:'',session:'now',limit:8,exclude_room:''});
  }
  assert.deepEqual(rows[3].args.regions,['主M','新主楼A座']);
});
