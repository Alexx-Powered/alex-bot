import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Telemetry,measureSpan,recordTiming} from '../src/telemetry.mjs';

const config={enabled:true,apiKey:'test-only-langsmith-key',project:'alex-bot-test',endpoint:'https://api.smith.langchain.com',workspaceId:'abcdef12-1234-4567-8901-123456789012'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=5000){const start=Date.now();for(;;){if(await fn())return;if(Date.now()-start>timeout)assert.fail('telemetry did not settle');await sleep(10);}}
async function fixture(t,options={}){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'qq-telemetry-'));
  t.after(async()=>{assert.equal(path.dirname(home),os.tmpdir());assert.ok(path.basename(home).startsWith('qq-telemetry-'));await fs.rm(home,{recursive:true,force:true});});
  const requests=[];
  const telemetry=new Telemetry({home,configStore:{read:async()=>config},fetchImpl:async(url,request)=>{requests.push({url,...request});return {ok:true,status:202};},...options});
  const file=path.join(home,'.private/telemetry/recent.json');
  const settle=()=>until(async()=>{const status=await telemetry.status();return status.langsmith.pending===0&&status.local.lastCode==='SAVED';});
  return {home,file,telemetry,requests,settle};
}

test('unadmitted content and arbitrary metrics, output, IDs and credentials never become remote inputs or errors',async t=>{
  const f=await fixture(t),secret='private-content-never-upload';
  const result=await f.telemetry.run({scope:'group',access:'gray',senderId:secret,sessionKey:secret,config:{apiKey:secret}},async()=>{
    await measureSpan('agent',async()=>{
      recordTiming('router_model',12,{inputTokens:20,outputTokens:7,cachedInputTokens:3,text:secret,prompt:secret,apiKey:secret,status:'fallback'});
      recordTiming(secret,12,{inputTokens:1});recordTiming('memory',-1);recordTiming('memory',Infinity);
    });
    return {text:secret,key:secret,config:{apiKey:secret}};
  });
  assert.equal(result.text,secret);await f.settle();
  const status=await f.telemetry.status();assert.equal(status.recent.length,1);assert.equal(status.recent[0].scope,'group');assert.equal(status.recent[0].access,'gray');
  assert.equal(status.recent[0].at,status.recent[0].startTime);assert.deepEqual(status.recent[0].stages,status.recent[0].spans);
  assert.equal(f.requests.length,3);assert.equal(f.requests[0].url,'https://api.smith.langchain.com/runs');
  for(const request of f.requests){
    assert.equal(request.headers['x-api-key'],config.apiKey);assert.equal(request.headers['x-tenant-id'],config.workspaceId);
    assert.equal(request.redirect,'error');assert.ok(request.signal instanceof AbortSignal);
    const body=JSON.parse(request.body);assert.deepEqual(body.inputs,{event:'qq_event',scope:'group',access:'gray'});assert.deepEqual(body.outputs,{});
    assert.equal(body.session_name,config.project);assert.ok(!request.body.includes(secret));assert.ok(!request.body.includes(config.apiKey));
    for(const field of ['serialized','attachments','events'])assert.equal(body[field],undefined);
    assert.deepEqual(Object.keys(body.extra),['metadata']);
  }
  const agent=JSON.parse(f.requests[1].body),model=JSON.parse(f.requests[2].body);
  assert.equal(agent.name,'agent');assert.equal(model.name,'router_model');assert.match(model.error,/备用路径.*router_model/);
  assert.equal(agent.parent_run_id,JSON.parse(f.requests[0].body).id);assert.equal(model.parent_run_id,agent.id);
  assert.ok(model.dotted_order.startsWith(agent.dotted_order+'.'));
  assert.deepEqual(model.usage_metadata,{input_tokens:20,output_tokens:7,total_tokens:27,input_token_details:{cache_read:3}});
  assert.ok(!JSON.stringify(status).includes(secret));assert.ok(!JSON.stringify(status).includes(config.apiKey));
  const saved=await fs.readFile(f.file,'utf8');assert.ok(!saved.includes(secret));assert.ok(!saved.includes(config.apiKey));
  assert.equal(status.summary.stages.router_model.medianMs,12);
});

test('unknown scope/access and arbitrary metrics/status are dropped, and helpers outside a request are no-ops',async t=>{
  assert.equal(await measureSpan('agent',async()=>42),42);recordTiming('agent',10,{text:'no-context'});
  const f=await fixture(t,{configStore:{read:async()=>({enabled:false})}});
  await f.telemetry.run({scope:'secret-scope',access:'secret-access',id:'private-id'},async()=>{recordTiming('memory',2,{inputTokens:'private',outputTokens:-5,cachedInputTokens:NaN,status:'private-error'});return 7;});
  await f.settle();const recent=(await f.telemetry.status()).recent[0];
  assert.equal(recent.scope,undefined);assert.equal(recent.access,undefined);assert.equal(recent.spans[0].status,'ok');
  assert.deepEqual(Object.keys(recent.spans[0]).sort(),['id','name','startTime','endTime','durationMs','ms','status'].sort());assert.equal(f.requests.length,0);
});

test('network delivery does not block replies and only 32 traces can be pending',async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{fetchImpl:async()=>{entered();await gate;return {ok:true};}});
  assert.equal(await f.telemetry.run({scope:'c2c'},async()=>'reply immediately'),'reply immediately');
  await started;
  for(let i=0;i<100;i++)assert.equal(await f.telemetry.run({scope:'c2c'},async()=>i),i);
  let status=await f.telemetry.status();assert.equal(status.langsmith.pending,32);assert.equal(status.langsmith.dropped,69);assert.equal(status.recent.length,50);
  release();await f.settle();status=await f.telemetry.status();assert.equal(status.langsmith.sent,32);assert.equal(status.langsmith.failed,0);
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).recent.length,50);
});

test('failed upload preserves reply, does not retry, and stores only a fixed failure code',async t=>{
  let calls=0;
  const f=await fixture(t,{fetchImpl:async()=>{calls++;throw Error('provider private-secret-body');}});
  assert.deepEqual(await f.telemetry.run({scope:'group',access:'white'},async()=>({text:'still reply'})),{text:'still reply'});
  await f.settle();const status=await f.telemetry.status();assert.equal(calls,1);assert.equal(status.langsmith.failed,1);assert.equal(status.langsmith.lastCode,'LANGSMITH_NETWORK_ERROR');
  assert.ok(!JSON.stringify(status).includes('private-secret-body'));assert.equal(status.recent[0].status,'ok');
});

test('thrown application errors preserve the original error while the trace records only fixed status',async t=>{
  const f=await fixture(t),original=Error('secret-stack-and-auth');
  await assert.rejects(f.telemetry.run({scope:'c2c',access:'white'},()=>measureSpan('agent',async()=>{throw original;})),error=>error===original);
  await f.settle();const status=await f.telemetry.status();assert.equal(status.recent[0].status,'error');assert.equal(status.recent[0].spans[0].status,'error');
  assert.equal(status.recent[0].access,undefined);for(const request of f.requests)assert.ok(!request.body.includes(original.message));
});

test('EU endpoint is accepted, arbitrary hosts are refused and authentication failures are not retried',async t=>{
  const f=await fixture(t,{configStore:{read:async()=>({...config,endpoint:'https://eu.api.smith.langchain.com/'})}});
  await f.telemetry.run({},async()=>null);await f.settle();assert.equal(f.requests[0].url,'https://eu.api.smith.langchain.com/runs');
  let calls=0;const denied=await fixture(t,{configStore:{read:async()=>({...config,endpoint:'https://attacker.invalid'})},fetchImpl:async()=>{calls++;return {ok:true};}});
  await denied.telemetry.run({},async()=>null);await denied.settle();assert.equal(calls,0);assert.equal((await denied.telemetry.status()).langsmith.lastCode,'LANGSMITH_CONFIG_UNAVAILABLE');
  const auth=await fixture(t,{fetchImpl:async()=>{calls++;return {ok:false,status:401};}});
  await auth.telemetry.run({},async()=>null);await auth.settle();assert.equal(calls,1);assert.equal((await auth.telemetry.status()).langsmith.lastCode,'LANGSMITH_AUTH_FAILED');
});

test('local history survives reconstruction with protected permissions and ignores unknown loaded fields',async t=>{
  const f=await fixture(t,{configStore:{read:async()=>({enabled:false})}});
  await f.telemetry.run({scope:'c2c'},async()=>recordTiming('worker_total',25));await f.settle();
  if(process.platform!=='win32'){
    assert.equal((await fs.stat(path.dirname(f.file))).mode&0o777,0o700);assert.equal((await fs.stat(f.file)).mode&0o777,0o600);
  }
  const packet=JSON.parse(await fs.readFile(f.file,'utf8'));packet.recent[0].text='old-private-data';packet.recent[0].spans[0].config={apiKey:'old-secret'};await fs.writeFile(f.file,JSON.stringify(packet));
  const restored=new Telemetry({home:f.home});const status=await restored.status();assert.equal(status.recent.length,1);assert.equal(status.summary.lastMs,status.recent[0].durationMs);
  assert.ok(!JSON.stringify(status).includes('old-private-data'));assert.ok(!JSON.stringify(status).includes('old-secret'));
});

test('unaddressed ignored group traffic creates no trace, but work that reached an agent is retained',async t=>{
  const f=await fixture(t,{configStore:{read:async()=>({enabled:false})}});
  assert.deepEqual(await f.telemetry.run({scope:'group'},async()=>({code:'IGNORED'})),{code:'IGNORED'});
  assert.equal((await f.telemetry.status()).recent.length,0);
  await f.telemetry.run({scope:'group'},async()=>{await measureSpan('agent',async()=>{});return {code:'IGNORED'};});
  await f.settle();assert.equal((await f.telemetry.status()).recent.length,1);
});

test('worker timings preserve a serial timeline without uploading their timing hint',async t=>{
  const start=Date.parse('2026-10-29T09:00:00.000Z');let now=start,clock=0;
  const f=await fixture(t,{now:()=>now,clock:()=>clock});
  await f.telemetry.run({scope:'c2c'},async()=>{
    now=start+1000;clock=1000;
    recordTiming('router_model',200,{startedAtMs:start+100,inputTokens:10,outputTokens:2});
    recordTiming('chat_model',500,{startedAtMs:start+350,status:'fallback'});
  });
  await f.settle();const spans=(await f.telemetry.status()).recent[0].spans;
  assert.equal(spans[0].startTime,new Date(start+100).toISOString());assert.equal(spans[0].endTime,new Date(start+300).toISOString());
  assert.equal(spans[1].startTime,new Date(start+350).toISOString());assert.equal(spans[1].endTime,new Date(start+850).toISOString());
  assert.ok(Date.parse(spans[0].endTime)<Date.parse(spans[1].startTime));
  const modelRuns=f.requests.slice(1).map(request=>JSON.parse(request.body));
  assert.equal(modelRuns[0].start_time,spans[0].startTime);assert.equal(modelRuns[1].end_time,spans[1].endTime);
  assert.equal(modelRuns[1].extra.metadata.status,'fallback');
  for(const request of f.requests)assert.ok(!request.body.includes('startedAtMs'));
  assert.ok(!(await fs.readFile(f.file,'utf8')).includes('startedAtMs'));
});

test('worker timestamp hints are bounded to this trace and malformed hints use the existing timing fallback',async t=>{
  const start=Date.parse('2026-10-29T09:00:00.000Z');let now=start;
  const f=await fixture(t,{now:()=>now,clock:()=>0,configStore:{read:async()=>({enabled:false})}});
  await f.telemetry.run({},async()=>{
    now=start+1000;
    for(const startedAtMs of [start-1001,start+1001,start+950,NaN,Infinity,String(start),-1])recordTiming('memory',200,{startedAtMs});
    recordTiming('memory',200,{get startedAtMs(){throw Error('private-timestamp-error');}});
    recordTiming('router_setup',200,{startedAtMs:start-1000});
    recordTiming('chat_setup',200,{startedAtMs:start+900});
  });
  await f.settle();const spans=(await f.telemetry.status()).recent[0].spans;
  for(const span of spans.slice(0,8)){
    assert.equal(span.startTime,new Date(now-200).toISOString());assert.equal(span.endTime,new Date(now).toISOString());
  }
  assert.equal(spans[8].startTime,new Date(start-1000).toISOString());
  assert.equal(spans[9].endTime,new Date(now+100).toISOString());
  assert.ok(!JSON.stringify(await f.telemetry.status()).includes('private-timestamp-error'));
});

test('REST runs carry SDK-compatible dotted orders with consistent root and child identities',async t=>{
  const start=Date.parse('2026-10-29T09:00:00.123Z');let now=start;
  const f=await fixture(t,{now:()=>now,clock:()=>0});
  await f.telemetry.run({scope:'c2c'},async()=>{
    now=start+700;
    recordTiming('router_model',200,{startedAtMs:start+100});
    recordTiming('chat_model',300,{startedAtMs:start+350});
  });
  await f.settle();const [root,...children]=f.requests.map(request=>JSON.parse(request.body));
  const rootOrder='20261029T090000123000Z'+root.id;
  assert.equal(root.trace_id,root.id);assert.equal(root.dotted_order,rootOrder);assert.equal(root.parent_run_id,undefined);
  assert.equal(children[0].dotted_order,rootOrder+'.20261029T090000223000Z'+children[0].id);
  assert.equal(children[1].dotted_order,rootOrder+'.20261029T090000473000Z'+children[1].id);
  for(const child of children){
    const parts=child.dotted_order.split('.');
    assert.equal(parts.length,2);assert.equal(parts[0],root.dotted_order);
    assert.equal(parts[0].split('Z')[1],child.trace_id);assert.equal(parts[0].split('Z')[1],child.parent_run_id);
    assert.equal(parts[1].split('Z')[1],child.id);assert.equal(child.dotted_order.slice(-36),child.id);
    for(const part of parts)assert.match(part,/^\d{8}T\d{12}Z[a-f\d-]{36}$/);
  }
});

test('synthetic checks and legacy agent-only checks remain visible but do not skew QQ latency summaries',async t=>{
  let clock=0;const f=await fixture(t,{clock:()=>clock});
  const run=(context,stage,ms)=>f.telemetry.run(context,async()=>{clock+=ms;recordTiming(stage,ms);});
  for(const ms of [2000,3000,4000])await run({scope:'c2c'},'core_queue',ms);
  await run({synthetic:true,private:'never-save-selftest-text'},'agent',1);
  await run({synthetic:true},'core_queue',1);
  await run({},'agent',1);
  await f.settle();const status=await f.telemetry.status();
  assert.equal(status.recent.length,6);assert.equal(status.recent.filter(t=>t.synthetic===true).length,2);
  assert.deepEqual(status.summary,{count:3,lastMs:4000,medianMs:3000,p95Ms:4000,stages:{core_queue:{count:3,medianMs:3000,p95Ms:4000}}});
  const runs=f.requests.map(request=>JSON.parse(request.body));
  assert.equal(runs.filter(run=>run.extra.metadata.synthetic===true).length,4);
  assert.ok(!JSON.stringify(status).includes('never-save-selftest-text'));
  const restored=await new Telemetry({home:f.home}).status();
  assert.equal(restored.recent.filter(t=>t.synthetic===true).length,2);assert.deepEqual(restored.summary,status.summary);
});

test('synthetic accepts only boolean true and cannot retain arbitrary context values',async t=>{
  const f=await fixture(t,{configStore:{read:async()=>({enabled:false})}});
  for(const synthetic of [false,'true',1,{},null])await f.telemetry.run({synthetic},async()=>recordTiming('core_queue',1));
  await f.settle();const status=await f.telemetry.status();
  assert.equal(status.summary.count,5);
  for(const trace of status.recent)assert.equal(Object.hasOwn(trace,'synthetic'),false);
});
