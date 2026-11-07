import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {childEnvironment,runResearchTick,runPython,safeSummary} from '../ops/research-runner.mjs';

const key='FAKE-secret-key-for-test-only';

test('idle, busy and low-memory probes do not decrypt credentials or consume',async()=>{
  for(const status of ['idle','busy','low_memory','disabled']) {
    const calls=[];
    const result=await runResearchTick({invoke:async(...args)=>{calls.push(args);return {status};},loadConfig:()=>assert.fail('key read')});
    assert.equal(result.status,status);assert.equal(calls.length,1);assert.equal(calls[0][0],'--probe');
  }
});

test('one ready task uses stdin-only key, strips content and never invokes a model',async()=>{
  const calls=[];
  const result=await runResearchTick({loadConfig:async()=>({enabled:false,provider:'deepseek',apiKey:key}),invoke:async(...args)=>{
    calls.push(args);return args[0]==='--probe'?{status:'ready'}:{status:'completed',candidate_count:1,topic:'private topic',api_key:key,metrics:{total_ms:80,llm_calls:0,text:key}};
  }});
  assert.deepEqual(calls[1].slice(0,2),['--consume',{api_key:key}]);
  assert.deepEqual(result,{status:'completed',candidate_count:1,metrics:{llm_calls:0,total_ms:80}});
  assert.ok(!JSON.stringify(result).includes(key));assert.equal(calls.length,2);
});

test('key error and provider rejection are bounded without retry or raw error logs',async()=>{
  const calls=[];
  const result=await runResearchTick({loadConfig:async()=>{throw Error(key);},invoke:async mode=>{calls.push(mode);return {status:'ready'};}});
  assert.deepEqual(result,{status:'failed',error_code:'RESEARCH_RUNNER_FAILED'});
  assert.deepEqual(calls,['--probe']);
  const rejected=await runResearchTick({loadConfig:async()=>({provider:'other',apiKey:key}),invoke:async()=>({status:'ready'})});
  assert.equal(rejected.error_code,'RESEARCH_CREDENTIAL_UNAVAILABLE');
});

test('waiting for background consume leaves event loop available',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const work=runResearchTick({loadConfig:async()=>({provider:'deepseek',apiKey:key}),invoke:async mode=>mode==='--probe'?{status:'ready'}:pending});
  await new Promise(resolve=>setImmediate(resolve));
  const foreground=await Promise.resolve('ordinary reply');
  assert.equal(foreground,'ordinary reply');
  release({status:'empty'});assert.equal((await work).status,'empty');
});

test('child inherits only non-secret runtime essentials and the operator config path',()=>{
  const env=childEnvironment({PATH:'bin',QQ_RAG_CONFIG:'/safe/config.json',QQ_BOT_SECRET:key,DEEPSEEK_API_KEY:key,CREDENTIALS_DIRECTORY:'/run/credentials',LANGSMITH_API_KEY:key});
  assert.equal(env.QQ_RAG_CONFIG,'/safe/config.json');assert.equal(env.PATH,'bin');
  assert.ok(!JSON.stringify(env).includes(key));assert.equal(env.CREDENTIALS_DIRECTORY,undefined);
});

function fakeSpawn(reply,{never=false}={}) {
  const state={};
  const spawn=(executable,args,options)=>{
    Object.assign(state,{executable,args,options});
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();
    child.kill=()=>{state.killed=true;return true;};
    let input='';child.stdin.on('data',data=>{input+=data;});
    child.stdin.on('finish',()=>{
      state.input=input;
      if(!never)setImmediate(()=>{child.stdout.write(reply);child.emit('close',0);});
    });
    return child;
  };
  return {state,spawn};
}

test('subprocess never receives a secret through argv or environment',async()=>{
  const fake=fakeSpawn(JSON.stringify({status:'empty',api_key:key}));
  const result=await runPython('--consume',{api_key:key},{spawnProcess:fake.spawn});
  assert.equal(result.status,'empty');assert.equal(JSON.parse(fake.state.input).api_key,key);
  assert.ok(!JSON.stringify(fake.state.args).includes(key));assert.ok(!JSON.stringify(fake.state.options.env).includes(key));
  assert.equal(fake.state.options.stdio[2],'ignore');assert.ok(!JSON.stringify(result).includes(key));
});

test('subprocess hard timeout and oversized output terminate once',async()=>{
  const slow=fakeSpawn('',{never:true});
  const timeout=await runPython('--consume',{api_key:key},{spawnProcess:slow.spawn,timeoutMs:10});
  assert.equal(timeout.status,'timeout');assert.equal(slow.state.killed,true);
  const large=fakeSpawn('x'.repeat(8193));
  const invalid=await runPython('--probe',null,{spawnProcess:large.spawn});
  assert.equal(invalid.error_code,'RESEARCH_OUTPUT_TOO_LARGE');assert.equal(large.state.killed,true);
});

test('safe summaries discard unrecognized errors and non-finite metrics',()=>{
  assert.deepEqual(safeSummary({status:'failed',error_code:key,metrics:{total_ms:Infinity}}),{status:'failed',metrics:{}});
});

test('runner executes when launched through the current release directory symlink',async()=>{
  const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
  const {fileURLToPath}=await import('node:url');const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');const temp=await fs.mkdtemp(path.join(os.tmpdir(),'research-entry-'));
  const link=path.join(temp,'current');
  try{
    await fs.symlink(fileURLToPath(new URL('../',import.meta.url)),link,process.platform==='win32'?'junction':'dir');
    const {stdout}=await promisify(execFile)(process.execPath,[path.join(link,'ops','research-runner.mjs'),'--invalid'],{windowsHide:true});
    assert.equal(JSON.parse(stdout).error_code,'RESEARCH_ARGUMENTS_INVALID');
  }finally{await fs.unlink(link).catch(()=>{});await fs.rmdir(temp);}
});
