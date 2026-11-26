import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {GROUP_FEATURES} from '../src/group-features.mjs';

test('actual Node/Python LangChain boundary routes weather using structured model decisions',async()=>{
  const worker=new PythonAgentWorker({home:process.cwd(),workerPath:fileURLToPath(new URL('./fixtures/model-weather-worker.py',import.meta.url))});
  const base={type:'request',sessionKey:'latency-regression',config:{enabled:true,apiKey:'offline-no-api-key',model:'deepseek-flash',baseURL:'https://api.deepseek.com'},policy:{enabled:false,topics:[],instructions:'',maxChars:600},now:'2026-11-03T03:00:00Z'};
  const calls=[];
  const execute=async(name,args)=>{calls.push({name,args});return {text:'fixture-result'};};
  try{
    const privateResult=await worker.run({...base,text:'北京天气如何',context:{scope:'c2c'}},execute);
    assert.deepEqual(privateResult,{text:'fixture-result'});
    assert.deepEqual(calls,[{name:'weather_image',args:{city:'北京'}}]);
    const features=Object.fromEntries(GROUP_FEATURES.map(({key})=>[key,key==='weather']));
    const context={scope:'group',access:'white',features,currentSpeaker:'member-ab',groupContext:[]};
    assert.deepEqual(await worker.run({...base,text:'广州明天天气如何',context},execute),{text:'fixture-result'});
    features.weather=false;
    const denied=await worker.run({...base,text:'北京天气如何',context},execute,result=>result);
    assert.equal(denied.kind,'clarify');assert.equal(denied.reason,'restricted_access');
    assert.equal(calls.length,2);
    // Previous callers can still invoke the deterministic tool with optional day omitted.
    assert.deepEqual(await worker.run({type:'execute',name:'weather_image',args:{city:'北京'}},execute),{text:'fixture-result'});
    assert.deepEqual(calls.at(-1),{name:'weather_image',args:{city:'北京'}});
    assert.deepEqual(await worker.run({...base,text:'看看北京未来48小时的PM2.5变化视频',context:{scope:'c2c'}},execute),{text:'fixture-result'});
    assert.deepEqual(calls.at(-1),{name:'pm25_video',args:{city:'北京',hours:48}});
    features.weather=true;
    assert.deepEqual(await worker.run({...base,text:'看看动态云图48h 华北',context},execute),{text:'fixture-result'});
    assert.deepEqual(calls.at(-1),{name:'cloud_video',args:{city:'华北',hours:48}});
  }finally{worker.close();}
});
