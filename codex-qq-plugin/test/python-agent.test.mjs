import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {PythonAgentWorker,pythonEnvironment} from '../src/python-agent.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {parseChatPolicy} from '../src/chat-policy.mjs';

function fakeWorker(respond,overrides={}){
  let child,options;const lines=[];
  const spawnImpl=(exe,args,opts)=>{
    options=opts;child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('exit');
    child.stdin.on('data',chunk=>{const value=JSON.parse(String(chunk));lines.push(value);queueMicrotask(()=>respond(value,v=>child.stdout.write(typeof v==='string'?v:JSON.stringify(v)+'\n')));});return child;
  };
  const worker=new PythonAgentWorker({home:process.cwd(),spawnImpl,timeoutMs:40,...overrides});
  return {worker,lines,get options(){return options;}};
}
test('Python RPC keeps image in Node, serializes concurrent requests, strips inherited secrets',async()=>{
  const f=fakeWorker((v,out)=>v.type==='execute'?out({type:'tool',id:v.id,callId:'one',name:v.name,args:v.args}):out({type:'result',id:v.id,kind:'tool'}));
  try{
    const image={buffer:Buffer.alloc(10,1),mimeType:'image/png'};
    const result=await Promise.all([1,2].map(()=>f.worker.run({type:'execute',name:'weather_image',args:{city:'北京'}},async()=>({text:'',image}))));
    assert.equal(result[0].image,image);assert.equal(result[1].image,image);
    assert.doesNotMatch(JSON.stringify(f.lines),/buffer|image\/png/);assert.equal(f.options.windowsHide,true);
    const env=pythonEnvironment({PATH:'x',OPENAI_API_KEY:'secret',LANGSMITH_API_KEY:'secret',LANGSMITH_TRACING:'true'});
    assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.LANGSMITH_API_KEY,undefined);assert.equal(env.LANGSMITH_TRACING,'false');
  }finally{f.worker.close();}
});
test('wrong request id, non-JSON logging, overlong stdout and timeout fail closed',async()=>{
  for(const respond of [(v,o)=>o({type:'result',id:'wrong',kind:'ignore'}),(v,o)=>o('unexpected log\n'),(v,o)=>o('x'.repeat(66000)),()=>{}]){
    const f=fakeWorker(respond);try{await assert.rejects(f.worker.run({type:'request'},async()=>null),/PYTHON_AGENT_UNAVAILABLE/);}finally{f.worker.close();}
  }
});
test('worker cannot claim image without callback or invoke two tools',async()=>{
  const none=fakeWorker((v,o)=>o({type:'result',id:v.id,kind:'tool'}));
  try{await assert.rejects(none.worker.run({type:'request'},async()=>null));}finally{none.worker.close();}
  const two=fakeWorker((v,o)=>{if(v.type==='request'){o({type:'tool',id:v.id,callId:'a',name:'weather_image',args:{city:'北京'}});o({type:'tool',id:v.id,callId:'b',name:'weather_image',args:{city:'广州'}});}});
  let calls=0;try{await assert.rejects(two.worker.run({type:'request'},async()=>{calls++;return {text:'ok'};}));assert.equal(calls,1);}finally{two.worker.close();}
});

test('conversion result cannot masquerade as an existing weather execution',async()=>{
  const f=fakeWorker((v,out)=>out({type:'result',id:v.id,kind:'conversion',text:'1 马里 = 3.08 km'}));
  try{await assert.rejects(f.worker.run({type:'execute',name:'weather_image',args:{city:'北京'}},async()=>assert.fail('No RPC')));}
  finally{f.worker.close();}
});

test('worker propagates only allowlisted model failure reasons without provider text',async()=>{
  for(const [code,expected] of [['MODEL_CONNECTION_ERROR','MODEL_CONNECTION_ERROR'],['SECRET_PROVIDER_BODY','WORKER_FAILED']]){
    const f=fakeWorker((v,out)=>out({type:'result',id:v.id,kind:'error',code,text:'SECRET_API_KEY'}));
    try{await assert.rejects(f.worker.run({type:'request'},async()=>null),e=>e.reason===expected&&!e.message.includes('SECRET'));}
    finally{f.worker.close();}
  }
});

test('only trusted campus RPC gets its bounded longer deadline and campus results cannot impersonate model replies',async()=>{
  const f=fakeWorker((v,out)=>v.type==='request'?out({type:'tool',id:v.id,callId:'campus',name:'buaa_classroom_query',args:{date:''}}):out({type:'result',id:v.id,kind:'tool'}),{timeoutMs:25,toolTimeouts:{buaa_classroom_query:500}});
  try{
    const result=await f.worker.run({type:'request'},async()=>{await new Promise(r=>setTimeout(r,60));return {text:'',image:{buffer:Buffer.alloc(16)}};});
    assert.ok(result.image);
  }finally{f.worker.close();}
  const bad=fakeWorker((v,out)=>out({type:'result',id:v.id,kind:'campus',data:{}}));
  try{await assert.rejects(bad.worker.run({type:'request'},async()=>null));}finally{bad.worker.close();}
});
test('exact weather and morning briefing fall back if Python missing, never require key',async()=>{
  const queries=[];const toolbox=new WeatherToolbox({handle:async text=>{queries.push(text);return {text:'',image:{buffer:Buffer.alloc(10)}};},briefing:async args=>({ok:true,cities:args.cities})},{run:async()=>{throw Error();}});
  assert.ok((await toolbox.handle('发天气广州')).image);assert.equal(queries[0],'发 天气 guangzhou');assert.equal((await toolbox.briefing({cities:['beijing']})).ok,true);
  await assert.rejects(toolbox.execute('weather_image',{city:'https://example.com'}));await assert.rejects(toolbox.execute('notify',{text:'hi'}));
});
test('disabled natural language never starts worker; chat policy and mention filters enforced twice',async()=>{
  let config={enabled:false,apiKey:''},started=0;
  const agent=new ConversationAgent({modelBudget:{acquire:async()=>({ok:true})},toolbox:{handle:async()=>null},worker:{run:async(p,e,finish)=>{started++;return finish({kind:'chat',topic:'日常',text:'<@!123>@全体成员你好呀呀呀呀呀'});}},configStore:{read:async()=>config},policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:5,instructions:'简短'}),policyFile:'unused'});
  assert.equal(await agent.handle('你好'),null);assert.equal(started,0);config={enabled:true,apiKey:'dummy-not-real'};
  const result=await agent.handle('你好');assert.equal(result.text.length,5);assert.doesNotMatch(result.text,/@/);
});
test('Markdown policy fails closed on malformed frontmatter',()=>{
  assert.equal(parseChatPolicy('---\nchat_enabled: false\nallowed_topics: []\nmax_reply_chars: 500\n---\n规则').enabled,false);
  assert.throws(()=>parseChatPolicy('chat_enabled: true'));
});
test('close rejects queued requests and never restarts the worker',async()=>{
  const f=fakeWorker(()=>{});
  const first=f.worker.run({type:'request'},async()=>null);
  const second=f.worker.run({type:'request'},async()=>null);
  await new Promise(resolve=>setImmediate(resolve));f.worker.close();
  assert.deepEqual((await Promise.allSettled([first,second])).map(r=>r.status),['rejected','rejected']);
  assert.equal(f.lines.length,1);await assert.rejects(f.worker.run({type:'request'},async()=>null));
});
test('premature non-tool result cannot discard an in-flight artifact',async()=>{
  const f=fakeWorker((v,o)=>{if(v.type==='request'){o({type:'tool',id:v.id,callId:'a',name:'weather_image',args:{city:'北京'}});o({type:'result',id:v.id,kind:'ignore'});}});
  let release;const pending=new Promise(resolve=>release=resolve);
  try{await assert.rejects(f.worker.run({type:'request'},async()=>{await pending;return {text:'no'};}));}
  finally{release();f.worker.close();}
});
test('local provider errors preserve safe location codes without retrying the provider',async()=>{
  const f=fakeWorker((v,o)=>v.type==='execute'?o({type:'tool',id:v.id,callId:'a',name:v.name,args:v.args}):o({type:'result',id:v.id,kind:'tool'}));
  try{
    let calls=0;const error=Object.assign(new Error('private provider details'),{code:'LOCATION_AMBIGUOUS',suggestions:['辽宁 朝阳']});
    const t=new WeatherToolbox({briefing:async()=>{calls++;throw error;}},f.worker);
    await assert.rejects(t.briefing({cities:['朝阳']}),e=>e.code==='LOCATION_AMBIGUOUS'&&e.suggestions[0]==='辽宁 朝阳');assert.equal(calls,1);
    assert.doesNotMatch(JSON.stringify(f.lines),/private provider details|辽宁/);
  }finally{f.worker.close();}
});
