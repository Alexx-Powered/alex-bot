import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeCore} from '../src/core.mjs';
import {LocationError} from '../src/locations.mjs';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {Telemetry,measureSpan,recordTiming,setTraceMessage,setTraceOperation} from '../src/telemetry.mjs';
import {traceMessage} from '../src/trace-diagnostics.mjs';

async function fixture(t){
  const home=await mkdtemp(path.join(os.tmpdir(),'qq-trace-input-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const runs=[];
  const tracing=new Telemetry({home,configStore:{read:async()=>({enabled:true,apiKey:'test-only-key',endpoint:'https://api.smith.langchain.com',project:'test'})},
    fetchImpl:async(_url,request)=>{runs.push(JSON.parse(request.body));return {ok:true};}});
  async function settle(){
    for(let i=0;i<350;i++){
      const s=await tracing.status();
      if(!s.langsmith.pending&&s.local.lastCode==='SAVED')return;
      await delay(10);
    }
    assert.fail('trace did not settle');
  }
  return {tracing,runs,settle,file:path.join(home,'.private','telemetry','recent.json')};
}

test('official queue preserves each addressed original, shows failed location at root, and omits other group traffic',async t=>{
  const f=await fixture(t);
  const tools=new WeatherToolbox(new WeatherCommands({locations:{resolve:async()=>{throw new LocationError('LOCATION_NOT_FOUND');}},videos:{},radar:{}}),{});
  const core=new BridgeCore({loadState:async()=>({version:1,ownerId:'owner',paused:false,attempts:[],deliveries:[],incoming:[],allowedGroups:[{id:'group',name:'测试群'}]}),
    saveState:async()=>{},send:()=>measureSpan('qq_send',async()=>({ok:true})),limits:{minuteAttempts:30},
    commandHandler:text=>measureSpan('agent',async()=>await tools.handle(text)??{text:'test reply'})});
  await core.init();
  const send=(id,text,kind='group',groupId='group')=>{
    const targetId=kind==='group'?groupId:'owner';
    return f.tracing.run({scope:kind},()=>core.handleMessage({kind,groupId,id,senderId:kind==='group'?'member':'owner',text,replyTarget:{scope:kind,targetId,msgId:id}},Date.now()+300000));
  };
  const raw='大肥鱼  发 动态云图48h 测试未知地点',question='午饭吃什么好？\n想吃面。';
  await Promise.all([send('m1',raw),send('m2',question,'c2c'),send('m3','private background'),send('m4','大肥鱼 unauthorized','group','other')]);
  await f.settle();
  const root=f.runs.find(run=>!run.parent_run_id&&run.inputs.message===raw);
  assert.deepEqual(root.inputs,{message:raw,city:'测试未知地点',layer:'cloud_cover',hours:48});
  assert.match(root.error,/resolve_location.*LOCATION_NOT_FOUND.*未找到/);
  const children=f.runs.filter(row=>row.trace_id===root.id&&row.parent_run_id);
  const stage=children.find(row=>row.name==='resolve_location');
  assert.deepEqual(stage.inputs,{city:'测试未知地点',layer:'cloud_cover',hours:48});
  assert.equal(stage.error,root.error);assert.equal(children.find(row=>row.name==='qq_send').error,undefined);
  const chat=f.runs.find(row=>!row.parent_run_id&&row.inputs.message===question);
  assert.ok(chat);assert.equal(chat.error,undefined);
  assert.doesNotMatch(JSON.stringify(f.runs),/private background|unauthorized|test reply/);
  assert.doesNotMatch(await readFile(f.file,'utf8'),/午饭|大肥鱼|测试未知地点/);
});

test('fallback and partial success keep specific child diagnostics while successful roots stay green',async t=>{
  const f=await fixture(t);
  await f.tracing.run({scope:'c2c'},()=>measureSpan('agent',async()=>{
    setTraceMessage('发 云图 南京');setTraceOperation('video.cloud_forecast');
    recordTiming('video_fetch_ifs',22,{status:'fallback',errorCode:'VIDEO_NATIVE_UNAVAILABLE',causeCode:'NETWORK_TIMEOUT',url:'secret-url'});
    return {video:true,text:''};
  }));
  await f.tracing.run({scope:'c2c'},()=>measureSpan('agent',async()=>{
    setTraceMessage('北京天气');setTraceOperation('weather.report');
    await measureSpan('air_fetch',async()=>{throw Object.assign(Error('password=private-body'),{httpStatus:503});}).catch(()=>{});
    return {image:true,text:'partial'};
  }));
  await f.settle();
  assert.ok(f.runs.filter(row=>!row.parent_run_id).every(row=>!row.error));
  assert.match(f.runs.find(row=>row.name==='video_fetch_ifs').error,/备用路径.*VIDEO_NATIVE_UNAVAILABLE.*超时/);
  assert.match(f.runs.find(row=>row.name==='air_fetch').error,/air_fetch.*HTTP 503/);
  assert.doesNotMatch(JSON.stringify(f.runs),/secret-url|private-body/);
});

test('real LangChain tool round trip retains the user question and the handled location failure',async t=>{
  const f=await fixture(t),worker=new PythonAgentWorker({home:process.cwd(),workerPath:fileURLToPath(new URL('./fixtures/model-weather-worker.py',import.meta.url))});
  t.after(()=>worker.close());
  const commands=new WeatherCommands({locations:{resolve:async()=>{throw new LocationError('LOCATION_SOURCE_TIMEOUT');}},videos:{},radar:{}});
  const toolbox=new WeatherToolbox(commands,worker),question='北京天气如何';
  await f.tracing.run({scope:'c2c'},()=>measureSpan('agent',async()=>{
    setTraceMessage(question);
    return worker.run({type:'request',text:question,sessionKey:'trace-test-session',now:'2026-11-03T03:00:00Z',context:{scope:'c2c'},
      config:{enabled:true,apiKey:'offline-test-only',model:'deepseek-flash',baseURL:'https://api.deepseek.com'},
      policy:{enabled:false,topics:[],instructions:'',maxChars:600}},(name,args)=>toolbox.execute(name,args));
  }));
  await f.settle();
  const root=f.runs.find(row=>!row.parent_run_id);
  assert.equal(root.inputs.message,question);assert.equal(root.inputs.city,'北京');
  assert.match(root.error,/resolve_location.*LOCATION_SOURCE_TIMEOUT/);
  assert.equal(f.runs.find(row=>row.name==='resolve_location').error,root.error);
  assert.ok(f.runs.some(row=>row.name==='worker_total'));
  assert.doesNotMatch(JSON.stringify(f.runs),/offline-test-only|trace-test-session/);
});

test('normal wording and whitespace are retained, credentials and control codes are withheld',()=>{
  const ordinary='  大肥鱼  把 48h 云图发给我吧！\n谢谢';assert.equal(traceMessage(ordinary),ordinary);
  for(const text of ['密码：private-value','验证码 是 125789','api_key="private-value"','Bearer secret-token','链接 https://api.invalid/?x-amz-signature=secret','sk-1234567890ab']){
    assert.equal(traceMessage(text),'[凭据已隐藏]');
  }
  assert.equal(traceMessage('/group-bind private-value'),'/group-bind [口令已隐藏]');
  assert.equal(traceMessage('看看 <@!12345>'),'看看 [QQ 提及]');
});
