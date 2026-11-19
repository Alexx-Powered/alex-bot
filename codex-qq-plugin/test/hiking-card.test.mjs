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
    nights:days.slice(0,-1).map((_,i)=>({day:i+1,name:'山脊营地',kind:'tent',low:-3,comfort:-3})),sources:[],missing:[],alternate:null,season:'仅用于布局和协议测试。'};
}
test('fixed hiking grammar accepts date and inn without a model',()=>{
  assert.deepEqual(parseHikingCommand('发 徒步 党岭 2026-11-14 不露营'),{destination:'党岭',start_date:'2026-11-14',overnight:'inn'});
  assert.equal(parseHikingCommand('去党岭徒步天气如何？'),null);
  assert.equal(parseHikingCommand('发 徒步 https://evil.test'),null);
});
test('card bounds reject oversized or malformed worker payloads',()=>{
  const value=fixture();value.days[0].series[0][0]=Infinity;assert.throws(()=>validateHikingCard(value),/INVALID/);
  assert.throws(()=>validateHikingCard(fixture(15)),/INVALID/);
  const covered=fixture();covered.days[0].coverage={min:25,max:25,cloud:24,precip:24,rain:24,snow:24,gust:24};
  assert.throws(()=>validateHikingCard(covered),/INVALID/);
});
test('partial per-day statistics retain visible values and still render a valid QQ image',async()=>{
  const value=fixture();value.status='partial';
  value.days[0].coverage={min:21,max:21,cloud:21,precip:21,rain:21,snow:21,gust:21};
  for(const hour of [8,12,16])value.days[0].series[hour]=[null,null,null,null,null,null,2];
  const image=await renderHikingCard(value);
  assert.equal(image.mimeType,'image/png');assert.ok((await loadImage(image.buffer)).width>2000);
  assert.equal(value.days[0].stats.min,-3);assert.equal(value.days[0].series[12][0],null);
});
test('representative-point label is constrained to the daily route and fits the card',async()=>{
  const value=fixture(2);value.days[0].weather_reference='山脊营地';
  const image=await renderHikingCard(value);assert.ok(image.buffer.length>10000);
  value.days[0].weather_reference='虚构营地';assert.throws(()=>validateHikingCard(value),/INVALID/);
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
test('real Node to Python LangChain carries weather reference and camping/room alternatives without model or QQ',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),parent=path.join(root,'test-output','hiking-node');await mkdir(parent,{recursive:true});
  const home=await mkdtemp(path.join(parent,'run-')),config=path.join(home,'rag.json'),store=path.join(home,'rag.sqlite3');
  await writeFile(config,JSON.stringify({enabled:true,store_path:store}));
  const python=pythonExecutable();execFileSync(python,['-c','import sys;sys.path.insert(0,sys.argv[1]);from rag_store import RagStore;RagStore(sys.argv[2]).put_document(namespace="shared",visibility="shared",domain="outdoor",title="fixture",text="test reference",source_ref="https://example.org/fixture")',path.join(root,'python'),store],{env:pythonEnvironment(),windowsHide:true});
  // Keep the real worker/Tool/stdio path; replace only route data and HTTP.
  const wrapper=path.join(home,'worker.py');
  await writeFile(wrapper,`import sys,runpy
sys.path.insert(0,${JSON.stringify(path.join(root,'python'))})
import hiking_trip as h
from hiking_catalog import validate_profile
point={'lat':30,'lon':100,'source':'https://www.openstreetmap.org/node/1'}
profile=validate_profile({'topic':'合成测试山','variant':'测试两日往返','sources':[{'url':'https://example.org/fixture','date':'2026-11-08'}],
 'days':[{'route':['起点村','未知湖','起点村'],'sleep':{'name':'起点村','kind':'tent','options':['tent','inn']}},
         {'route':['起点村','未知湖','起点村'],'sleep':None}],'points':{'起点村':point}})
h.catalog=lambda:[profile]
h.resolve_points=lambda *a,**kw:{'起点村':point}
def forecast(points,start,end,**kw):
 values={(h.datetime.combine(start,h.datetime.min.time())+h.timedelta(hours=i)).isoformat(timespec='minutes'):{'temperature_2m':10,'cloud_cover':40,'precipitation':1,'rain':.5,'showers':.2,'snowfall':.1,'wind_gusts_10m':2} for i in range(48)}
 return {'起点村':values},h.datetime.now(h.TZ).isoformat(),None
h.forecasts=forecast
runpy.run_path(${JSON.stringify(path.join(root,'python','agent_worker.py'))},run_name='__main__')
`);
  const worker=new PythonAgentWorker({home,pythonPath:python,workerPath:wrapper,spawnImpl:(exe,args,options)=>spawn(exe,args,{...options,env:{...options.env,QQ_RAG_CONFIG:config}})});
  const run=worker.run.bind(worker),outputs=[];
  worker.run=(packet,execute,finish)=>run(packet,execute,value=>{outputs.push(value);return finish(value);});
  try{
    const agent=new ConversationAgent({worker,ragEnabled:true,configStore:{read(){throw Error('MODEL_CONFIG_DENIED');}},modelBudget:{acquire(){throw Error('MODEL_BUDGET_DENIED');}}});
    const reply=await agent.handle('发 徒步 合成测试山',{scope:'c2c',sessionKey:'a'.repeat(64)});
    assert.equal(reply.text,'');assert.ok(Buffer.isBuffer(reply.image.buffer));assert.equal(reply.image.mimeType,'image/png');assert.ok((await loadImage(reply.image.buffer)).width>1000);
    const day=outputs.at(-1).hikingCard.days[0];
    assert.equal(day.stats.min,10);assert.equal(day.stats.cloud,40);assert.equal(day.stats.precip,24);
    assert.equal(day.coverage.min,24);assert.equal(day.coverage.precip,24);assert.equal(day.series[12][0],10);
    assert.equal(day.weather_reference,'起点村');
    const card=outputs.at(-1).hikingCard;
    assert.equal(card.nights[0].kind,'tent');assert.equal(card.nights[0].comfort,10);
    assert.deepEqual(card.nights[0].options,['tent','inn']);
    assert.equal(card.alternate.nights[0].kind,'inn');assert.equal(card.alternate.nights[0].comfort,null);
  }finally{worker.close();await new Promise(r=>setTimeout(r,200));await rm(home,{recursive:true,force:true});}
});
