// Performance-only diagnostics. Message bodies, identities, settings and errors
// never enter a trace. LangSmith delivery runs separately from QQ requests.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './storage.mjs';

const activeTrace=new AsyncLocalStorage();
const STAGES=new Set(['core_queue','agent','worker_queue','worker_startup','worker_total','router_setup','router_model','chat_setup','chat_model','memory','tool','qq_send']);
const TOKEN_KEYS=['inputTokens','outputTokens','cachedInputTokens'];
const ENDPOINTS=new Set(['https://api.smith.langchain.com','https://eu.api.smith.langchain.com']);
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ISO=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAX_RECENT=50,MAX_SPANS=64,MAX_PENDING=32;
const numeric=(x,max=86_400_000)=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=max;
const round=x=>Math.round(x*100)/100;
function contextFields(context){
  const result={};
  try{
    if(context?.scope==='c2c'||context?.scope==='group')result.scope=context.scope;
    if(result.scope==='group'&&(context.access==='white'||context.access==='gray'))result.access=context.access;
    if(context?.synthetic===true)result.synthetic=true;
  }catch{}
  return result;
}
function tokenFields(value){
  const result={};
  if(!value||typeof value!=='object')return result;
  for(const key of TOKEN_KEYS){try{if(numeric(value[key],1e12))result[key]=value[key];}catch{}}
  return result;
}
function timeValue(now){
  let value;try{value=now();}catch{}
  return numeric(value,8e15)?value:Date.now();
}
function clockValue(clock){let value;try{value=clock();}catch{}return numeric(value,8e15)?value:performance.now();}
function addSpan(trace,name,durationMs,metrics={},status='ok',startTime,endTime){
  if(!trace||trace.closed||!STAGES.has(name)||!numeric(durationMs)||trace.spans.length>=MAX_SPANS)return;
  const end=timeValue(trace.now);
  trace.spans.push({id:randomUUID(),name,startTime:startTime??new Date(Math.max(0,end-durationMs)).toISOString(),endTime:endTime??new Date(end).toISOString(),durationMs:round(durationMs),ms:round(durationMs),status,...tokenFields(metrics)});
}

export async function measureSpan(name,fn){
  const trace=activeTrace.getStore();
  if(!trace||trace.closed||!STAGES.has(name))return fn();
  const start=clockValue(trace.clock),wall=new Date(timeValue(trace.now)).toISOString();
  let status='ok';
  try{return await fn();}catch(error){status='error';throw error;}
  finally{addSpan(trace,name,Math.max(0,clockValue(trace.clock)-start),{},status,wall,new Date(timeValue(trace.now)).toISOString());}
}

export function recordTiming(name,ms,metrics={}){
  const trace=activeTrace.getStore();
  let status='ok';try{if(['ok','error','fallback'].includes(metrics?.status))status=metrics.status;}catch{}
  let startTime,endTime;
  try{
    const started=metrics?.startedAtMs,now=trace?timeValue(trace.now):0;
    // Worker timing arrives in one result packet; retain its original timeline.
    // A short clock tolerance cannot shift spans into an unrelated request.
    if(trace&&!trace.closed&&numeric(ms)&&numeric(started,8e15)&&started>=Date.parse(trace.startTime)-1000&&started<=now&&started+ms<=now+100){
      startTime=new Date(started).toISOString();endTime=new Date(started+ms).toISOString();
    }
  }catch{}
  addSpan(trace,name,ms,metrics,status,startTime,endTime);
}

function safeSavedTrace(value){
  if(!value||typeof value!=='object'||!UUID.test(value.id??'')||!ISO.test(value.startTime??'')||!ISO.test(value.endTime??'')||!numeric(value.durationMs)||!['ok','error'].includes(value.status))return null;
  const spans=[];
  for(const row of Array.isArray(value.spans)?value.spans.slice(0,MAX_SPANS):[]){
    if(!row||!UUID.test(row.id??'')||!STAGES.has(row.name)||!ISO.test(row.startTime??'')||!ISO.test(row.endTime??'')||!numeric(row.durationMs)||!['ok','error','fallback'].includes(row.status))continue;
    spans.push({id:row.id,name:row.name,startTime:row.startTime,endTime:row.endTime,durationMs:row.durationMs,ms:row.durationMs,status:row.status,...tokenFields(row)});
  }
  return {id:value.id,startTime:value.startTime,endTime:value.endTime,durationMs:value.durationMs,totalMs:value.durationMs,status:value.status,...contextFields(value),spans};
}
const percentile=(values,p)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
function summary(recent){
  const requests=recent.filter(t=>t.synthetic!==true&&!(t.synthetic===undefined&&t.spans.length>0&&t.spans.every(s=>s.name==='agent')));
  const durations=requests.map(t=>t.durationMs),stages={};
  for(const name of STAGES){const values=requests.flatMap(t=>t.spans.filter(s=>s.name===name).map(s=>s.durationMs));if(values.length)stages[name]={count:values.length,medianMs:percentile(values,.5),p95Ms:percentile(values,.95)};}
  return {count:requests.length,lastMs:durations[0]??null,medianMs:percentile(durations,.5),p95Ms:percentile(durations,.95),stages};
}

function destination(config){
  if(config?.enabled!==true)return null;
  const endpoint=typeof config.endpoint==='string'?config.endpoint.replace(/\/$/,''):'';
  if(!ENDPOINTS.has(endpoint)||typeof config.apiKey!=='string'||!/^\S{8,512}$/.test(config.apiKey)||typeof config.project!=='string'||!config.project.trim()||config.project.length>100||/[\r\n\p{Cc}]/u.test(config.project))throw Error('LANGSMITH_CONFIG_INVALID');
  const workspaceId=config.workspaceId??'';
  if(workspaceId!==''&&(typeof workspaceId!=='string'||!UUID.test(workspaceId)))throw Error('LANGSMITH_CONFIG_INVALID');
  return {endpoint,apiKey:config.apiKey,project:config.project,workspaceId};
}
function runPayload(trace,span,project){
  const row=span??trace;
  const metrics=tokenFields(row);
  const metadata={...contextFields(trace),duration_ms:row.durationMs,status:row.status,...metrics};
  const segment=run=>run.startTime.replace(/[-:.]/g,'').replace(/Z$/,'000Z')+run.id;
  const rootOrder=segment(trace),dottedOrder=span?rootOrder+'.'+segment(span):rootOrder;
  const result={id:row.id,trace_id:trace.id,dotted_order:dottedOrder,...span?{parent_run_id:trace.id}:{},name:span?span.name:'qq.response',run_type:span&&['router_model','chat_model'].includes(span.name)?'llm':span?.name==='tool'?'tool':'chain',session_name:project,inputs:{},outputs:{},start_time:row.startTime,end_time:row.endTime,extra:{metadata}};
  if(row.status==='error'||row.status==='fallback')result.error=span?row.status==='fallback'?'SPAN_FALLBACK':'SPAN_FAILED':'REQUEST_FAILED';
  if(numeric(metrics.inputTokens,1e12)&&numeric(metrics.outputTokens,1e12))result.usage_metadata={input_tokens:metrics.inputTokens,output_tokens:metrics.outputTokens,total_tokens:metrics.inputTokens+metrics.outputTokens,...numeric(metrics.cachedInputTokens,metrics.inputTokens)?{input_token_details:{cache_read:metrics.cachedInputTokens}}:{}};
  return result;
}

export class Telemetry{
  #home;#directory;#file;#configStore;#fetch;#now;#clock;
  #recent=[];#loaded;#persistScheduled=false;#persisting=false;#dirty=false;
  #queue=[];#busy=false;#inFlight=0;
  #local={lastCode:'EMPTY'};
  #remote={enabled:false,sent:0,sentRuns:0,failed:0,dropped:0,lastCode:'NOT_CONFIGURED'};
  constructor({home,configStore,fetchImpl=globalThis.fetch,now=Date.now,clock=performance.now}){
    if(typeof home!=='string'||!path.isAbsolute(home)||typeof fetchImpl!=='function'||typeof now!=='function'||typeof clock!=='function')throw new TypeError('TELEMETRY_CONFIG_INVALID');
    this.#home=home;this.#directory=path.join(home,'.private','telemetry');this.#file=path.join(this.#directory,'recent.json');
    this.#configStore=configStore;this.#fetch=fetchImpl;this.#now=now;this.#clock=clock;
    this.#loaded=this.#load();
  }
  async #load(){
    try{
      if((await fs.lstat(this.#directory)).isSymbolicLink())throw Error();
      if((await fs.lstat(this.#file)).isSymbolicLink()||(await fs.stat(this.#file)).size>2_000_000)throw Error();
      const packet=JSON.parse(await fs.readFile(this.#file,'utf8'));
      if(packet.version!==1||!Array.isArray(packet.recent))throw Error();
      const loaded=packet.recent.slice(0,MAX_RECENT).map(safeSavedTrace).filter(Boolean);
      const all=new Map([...loaded,...this.#recent].map(t=>[t.id,t]));
      this.#recent=[...all.values()].sort((a,b)=>b.endTime.localeCompare(a.endTime)).slice(0,MAX_RECENT);
      this.#local.lastCode='LOADED';
    }catch(error){this.#local.lastCode=error?.code==='ENOENT'?'EMPTY':'LOCAL_READ_FAILED';}
  }
  async run(context,fn){
    const start=clockValue(this.#clock);
    const trace={id:randomUUID(),startTime:new Date(timeValue(this.#now)).toISOString(),...contextFields(context),spans:[],now:this.#now,clock:this.#clock,closed:false};
    let status='ok',outcome;
    try{outcome=await activeTrace.run(trace,fn);return outcome;}catch(error){status='error';throw error;}
    finally{
      trace.closed=true;
      if(!(status==='ok'&&outcome?.code==='IGNORED'&&!trace.spans.some(s=>s.name==='agent'||s.name.startsWith('worker_')))){
      const duration=round(Math.min(86_400_000,Math.max(0,clockValue(this.#clock)-start)));
      const record={id:trace.id,startTime:trace.startTime,endTime:new Date(timeValue(this.#now)).toISOString(),durationMs:duration,totalMs:duration,status,...contextFields(trace),spans:trace.spans};
      this.#recent.unshift(record);this.#recent=this.#recent.slice(0,MAX_RECENT);
      this.#schedulePersist();
      if(this.#queue.length+this.#inFlight>=MAX_PENDING){this.#remote.dropped++;this.#remote.lastCode='QUEUE_FULL';}
      else{this.#queue.push(record);if(!this.#busy){this.#busy=true;setImmediate(()=>this.#drain());}}
      }
    }
  }
  #schedulePersist(){
    this.#dirty=true;
    if(this.#persistScheduled||this.#persisting)return;
    this.#persistScheduled=true;
    setImmediate(async()=>{
      this.#persistScheduled=false;this.#persisting=true;
      try{
        await this.#loaded;
        while(this.#dirty){
          this.#dirty=false;
          await fs.mkdir(this.#directory,{recursive:true,mode:0o700});
          if((await fs.lstat(this.#directory)).isSymbolicLink())throw Error();
          if(process.platform!=='win32')await fs.chmod(this.#directory,0o700);
          await atomicJson(this.#file,{version:1,recent:this.#recent});
          this.#local.lastCode='SAVED';
        }
      }catch{this.#local.lastCode='LOCAL_WRITE_FAILED';}
      finally{this.#persisting=false;if(this.#dirty)this.#schedulePersist();}
    });
  }
  async #drain(){
    try{
      for(;;){
        const trace=this.#queue.shift();if(!trace)break;
        this.#inFlight=1;
        let config;
        try{config=destination(await this.#configStore?.read());}
        catch{this.#remote.enabled=false;this.#remote.failed++;this.#remote.lastCode='LANGSMITH_CONFIG_UNAVAILABLE';continue;}
        this.#remote.enabled=Boolean(config);
        if(!config){this.#remote.lastCode='DISABLED';continue;}
        try{
          for(const span of [null,...trace.spans]){
            await this.#post(config,runPayload(trace,span,config.project));this.#remote.sentRuns++;
          }
          this.#remote.sent++;this.#remote.lastCode='SENT';
        }catch(error){this.#remote.failed++;this.#remote.lastCode=error?.message==='LANGSMITH_TIMEOUT'?'LANGSMITH_TIMEOUT':error?.message==='LANGSMITH_AUTH_FAILED'?'LANGSMITH_AUTH_FAILED':error?.message==='LANGSMITH_RATE_LIMITED'?'LANGSMITH_RATE_LIMITED':error?.message==='LANGSMITH_HTTP_ERROR'?'LANGSMITH_HTTP_ERROR':'LANGSMITH_NETWORK_ERROR';}
      }
    }finally{this.#inFlight=0;this.#busy=false;if(this.#queue.length){this.#busy=true;setImmediate(()=>this.#drain());}}
  }
  async #post(config,payload){
    const controller=new AbortController();let timeout;
    const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{controller.abort();reject(Error('LANGSMITH_TIMEOUT'));},2000);});
    try{
      const response=await Promise.race([this.#fetch(config.endpoint+'/runs',{method:'POST',redirect:'error',cache:'no-store',headers:{'Content-Type':'application/json',Accept:'application/json','x-api-key':config.apiKey,...config.workspaceId?{'x-tenant-id':config.workspaceId}:{}},body:JSON.stringify(payload),signal:controller.signal}),deadline]);
      if(!response?.ok)throw Error(response?.status===401||response?.status===403?'LANGSMITH_AUTH_FAILED':response?.status===429?'LANGSMITH_RATE_LIMITED':'LANGSMITH_HTTP_ERROR');
      // No response body is needed, retained or logged.
      try{response.body?.cancel()?.catch(()=>{});}catch{}
    }finally{clearTimeout(timeout);}
  }
  async status(){
    await this.#loaded;
    const recent=structuredClone(this.#recent).map(trace=>({...trace,at:trace.startTime,stages:trace.spans}));
    return {recent,summary:summary(recent),local:{...this.#local},langsmith:{...this.#remote,pending:this.#queue.length+this.#inFlight}};
  }
}
