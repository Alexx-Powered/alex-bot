import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CampusService,recommendationArgs} from '../src/campus-service.mjs';
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
  const rows=JSON.parse(execFileSync(path.join(home,'.venv','Scripts','python.exe'),['-B','-X','utf8','-c',program],{cwd:home,windowsHide:true,encoding:'utf8'}));
  assert.equal(rows.length,4);
  for(const row of rows)assert.equal(recommendationArgs.safeParse(row.args).success,true);
  for(const row of rows.slice(0,3)){
    assert.equal(row.args.date,'');assert.equal(row.args.session,'now');
    assert.equal(Object.hasOwn(row.args,'regions'),false);assert.equal(Object.hasOwn(row.args,'building'),false);
    assert.equal(recommendationArgs.omit({regions:true,building:true}).strict().safeParse(row.args).success,true);
  }
  assert.deepEqual(rows[3].args.regions,['主M','新主楼A座']);
});

test('internal argument errors never ask the user to supply an already-known current date',async()=>{
  const service=new CampusService({home,configStore:{},worker:{close(){}}});
  const warn=console.warn,logs=[];console.warn=message=>logs.push(message);
  try{
    const reply=await service.recommend({session:'unexpected-value'},{scope:'c2c'},'现在去哪');
    assert.match(reply.text,/参数.*解析失败/);assert.doesNotMatch(reply.text,/请指定|日期|上午/);
    assert.match(logs[0],/INVALID_ARGUMENTS/);assert.doesNotMatch(logs[0],/unexpected-value/);
  }finally{console.warn=warn;}
});

test('natural fresh-query routing also returns current recommendations; explicit full-day and fixed commands retain full reports',async()=>{
  const service=new CampusService({home,configStore:{},worker:{close(){}}}),calls=[];
  service.run=async(args,mode)=>{calls.push({args,mode});return {data:{ok:true,date:'2026-10-29'},image:{mimeType:'image/png'}};};
  service.recommend=async(args,_context,text)=>{assert.equal(args.date,'2026-10-29');return {text:'current facts',campusRecommendation:{ok:true},question:text};};
  for(const text of ['我现在去哪个教室自习？','现在有什么空教室能去？','给我推荐个能自习的教室']){
    const result=await service.execute({},{scope:'c2c'},text);
    assert.equal(calls.at(-1).mode,'query');assert.equal(result.campusRecommendation.ok,true);assert.equal(result.question,text);
  }
  await service.execute({view:'full'},{scope:'c2c'},'生成全天完整简报');assert.equal(calls.at(-1).mode,'report');
  await service.execute({},{scope:'c2c'});assert.equal(calls.at(-1).mode,'report');
});
