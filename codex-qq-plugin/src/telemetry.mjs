// Local history is metrics only. Remote-only inputs and diagnostic messages
// live in memory until this run is exported or dropped.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './storage.mjs';
import {traceMessage,failureDetail} from './trace-diagnostics.mjs';
import {MORNING_PART_FEATURES,MORNING_MAX_RETRIES} from './group-features.mjs';

const activeTrace=new AsyncLocalStorage();
export const hasActiveTrace=()=>Boolean(activeTrace.getStore()&&!activeTrace.getStore().closed);
const activeSpan=new AsyncLocalStorage();
const remoteDetails=new WeakMap();
const MORNING_OPERATIONS=new Set(['morning.prepare','morning.dispatch','morning.preview','morning.retry','morning.test']);
const MORNING_SKIPS=new Set(['MORNING_NOT_DUE','NO_MORNING_GROUPS','DUPLICATE','MORNING_CANCELLED']);
const MORNING_SUCCESS=new Set(['MORNING_PREPARED','SENT','MORNING_GROUP_FAILURES']);
const MILKY_EVENTS=new Set(['milky.account_offline','milky.bridge_closed','milky.channel_offline','milky.roster_ready','milky.roster_error']);
const MILKY_TIMES=['qqEventAt','nonebotReceivedAt','nodeReceivedAt','nodeSubmittedAt','nonebotDeliveryAt','gatewayReturnedAt','nodeReceiptAt','stateEventAt'];
// Receipt callbacks run on the socket listener. Capture the originating request here.
export function milkyTimeline(){
  const trace=activeTrace.getStore();
  return fields=>{
    if(!trace||trace.closed)return;
    trace.transport='milky';
    for(const key of MILKY_TIMES)if(Number.isSafeInteger(fields[key])&&fields[key]>0&&fields[key]<=Date.now()+60000)
      trace[key]=new Date(fields[key]).toISOString();
  };
}
const OPERATIONS=new Set(['video.cloud_forecast','video.satellite','video.temperature','video.precipitation','video.pm25','weather.report','weather.air','weather.radar','campus.query','service.status','tools.convert','agent.request','knowledge.query','hiking.trip',...MORNING_OPERATIONS,...MILKY_EVENTS]);
const STAGES=new Set(['core_queue','agent','worker_queue','worker_startup','worker_total','router_setup','router_model','chat_setup','chat_model','memory','tool','qq_send','qq_group_permission']);
export const videoWorkerStages=Object.freeze(['video_prepare_worker','video_fetch_gdps','video_fetch_ifs','video_fetch_gfs','video_fetch_cams','video_fetch_forecast','video_fetch_satellite','video_render_frames','video_encode_h264']);
export const campusWorkerStages=Object.freeze(['campus_browser_start','campus_navigation','campus_login_form','campus_login_fill_account',
  'campus_login_fill_password','campus_login_click','campus_login_result','campus_classroom_fetch','campus_render']);
for(const name of [...videoWorkerStages,...campusWorkerStages,'weather_video','resolve_location','heavy_queue','video_cache_hit','video_read_mp4',
  'video_download_slowest','video_decode_slowest','weather_fetch','air_fetch','weather_render','radar_query','qq_media_upload','qq_message_submit',
  'weather_forecast_primary','weather_metadata_primary','weather_forecast_backup','weather_metadata_backup',
  'weather_ecmwf_snapshot','weather_ecmwf_backup','weather_summary',
  'morning_air_cams','morning_air_gefs','morning_air_select',
  'morning_weather_prepare','morning_campus_prepare','morning_outdoor_index','morning_weather_delivery','morning_campus_delivery','morning_failure_notice',
  'rag_retrieval','rag_lexical','rag_embedding','rag_vector','rag_source_verify','hiking_route','hiking_locate','hiking_fetch','hiking_render'])STAGES.add(name);
export function setTraceOperation(name,onlyIfUnnamed=false){
  const trace=activeTrace.getStore();
  if(trace&&!trace.closed&&!MORNING_OPERATIONS.has(trace.operation)&&(!onlyIfUnnamed||!trace.operation||trace.operation==='agent.request')&&OPERATIONS.has(name))trace.operation=name;
}
export function setTraceMessage(text){
  const trace=activeTrace.getStore();
  if(trace&&!trace.closed)trace.message=traceMessage(text);
}
// Business inputs are projected explicitly. A worker packet can also contain
// credentials, coordinates, target IDs and chat history; never spread it here.
export function setTraceParameters({city,layer,hours,day,provider}={}){
  const trace=activeTrace.getStore();
  if(!trace||trace.closed)return;
  const fields={};
  if(typeof city==='string'&&city.length<=60&&/^[\p{L}\p{N} ·（）()_.,'’-]+$/u.test(city)&&traceMessage(city)===city)fields.city=city;
  if(['cloud','cloud_cover','pm25','temperature','precipitation'].includes(layer))fields.layer=layer;
  if([6,24,48].includes(hours))fields.hours=hours;
  if(['today','tomorrow'].includes(day))fields.day=day;
  if(['openai','deepseek','claude','gemini','kimi','liang'].includes(provider))fields.provider=provider;
  Object.assign(trace.parameters,fields);
}
function diagnostic(trace,stage,error,fallback=false){
  // Only inherit a cause observed in this request, even when an exception
  // instance is reused by different queued or concurrent callers.
  const reusable=error!==null&&typeof error==='object';
  const detail=(reusable&&trace.causes.get(error))||failureDetail(stage,error,fallback);
  if(reusable)trace.causes.set(error,detail);
  return detail;
}
export function recordRequestFailure(error,stage='agent'){
  const trace=activeTrace.getStore();
  if(!trace||trace.closed||!STAGES.has(stage))return;
  const detail=diagnostic(trace,stage,error);
  const cause=detail.code&&trace.spans.findLast(span=>span.status==='error'&&remoteDetails.get(span)?.failure?.code===detail.code&&span.name!=='worker_total');
  trace.failure=cause?remoteDetails.get(cause).failure:detail;
}
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
    if(context?.transport==='milky'){
      result.transport='milky';
      for(const key of MILKY_TIMES)if(typeof context[key]==='string'&&ISO.test(context[key]))result[key]=context[key];
    }
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
  const scope=activeSpan.getStore();
  const row={id:randomUUID(),...(scope?.trace===trace?{parentId:scope.id}:{}),name,startTime:startTime??new Date(Math.max(0,end-durationMs)).toISOString(),endTime:endTime??new Date(end).toISOString(),durationMs:round(durationMs),ms:round(durationMs),status,...tokenFields(metrics)};
  if(['video_download_slowest','video_decode_slowest'].includes(name)&&Number.isSafeInteger(metrics.calls)&&numeric(metrics.calls,4096)&&numeric(metrics.workMs)){
    row.calls=metrics.calls;row.workMs=round(metrics.workMs);
  }
  remoteDetails.set(row,{inputs:{...trace.parameters},...(status!=='ok'?{failure:diagnostic(trace,name,metrics.error??metrics,status==='fallback')}:{})});
  trace.spans.push(row);return row;
}

export function beginSpan(name,startedAtMs){
  const trace=activeTrace.getStore();
  if(!trace||trace.closed||!STAGES.has(name))return null;
  const start=clockValue(trace.clock),now=timeValue(trace.now);
  const started=numeric(startedAtMs,8e15)&&startedAtMs>=Date.parse(trace.startTime)-1000&&startedAtMs<=now?startedAtMs:now;
  const wall=new Date(started).toISOString();
  const span=addSpan(trace,name,0,{},'ok',wall,wall);
  if(!span)return null;
  return {run:fn=>activeTrace.run(trace,()=>activeSpan.run({trace,id:span.id},fn)),end(status='ok',ms,error,detail){
    if(trace.closed)return;
    const end=timeValue(trace.now),reported=numeric(ms)&&started+ms<=end+100;
    span.status=status;span.durationMs=span.ms=round(reported?ms:Math.max(0,clockValue(trace.clock)-start));
    span.endTime=new Date(reported?started+ms:end).toISOString();
    if(status!=='ok')remoteDetails.get(span).failure=detail??diagnostic(trace,name,error,status==='fallback');
  }};
}
export async function measureSpan(name,fn,failureFromResult){
  const span=beginSpan(name);if(!span)return fn();
  const trace=activeTrace.getStore();
  let failure;
  try{
    const result=await span.run(fn);
    const error=failureFromResult?.(result);
    if(error)failure=diagnostic(trace,name,error);
    if(name==='agent'&&result?.text&&!result.image&&!result.video&&/^(?:video\.|weather\.)/.test(trace.operation||'')){
      // Weather can legitimately return a partial chart after a source fails.
      // A text-only reply after a failed media stage is the handled failure.
      const stage=trace.spans.findLast(s=>s.status==='error'&&['resolve_location','weather_video','radar_query','weather_render','weather_fetch','air_fetch'].includes(s.name));
      if(stage)trace.failure??=remoteDetails.get(stage)?.failure;
    }
    return result;
  }catch(error){failure=diagnostic(trace,name,error);throw error;}
  finally{
    if(name==='agent')failure??=trace.failure;
    span.end(failure?'error':'ok',undefined,undefined,failure);
    if(failure&&(name==='agent'||name==='qq_send'))trace.failure=failure;
  }
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
    spans.push({id:row.id,...(spans.some(s=>s.id===row.parentId)?{parentId:row.parentId}:{}),name:row.name,startTime:row.startTime,endTime:row.endTime,durationMs:row.durationMs,ms:row.durationMs,status:row.status,...tokenFields(row),
      ...(Number.isSafeInteger(row.calls)&&numeric(row.calls,4096)&&numeric(row.workMs)?{calls:row.calls,workMs:row.workMs}:{})});
  }
  return {id:value.id,startTime:value.startTime,endTime:value.endTime,durationMs:value.durationMs,totalMs:value.durationMs,status:value.status,...contextFields(value),...(OPERATIONS.has(value.operation)?{operation:value.operation}:{}),spans};
}
const percentile=(values,p)=>values.length?values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*p)-1)]:null;
function summary(recent){
  const requests=recent.filter(t=>!MORNING_OPERATIONS.has(t.operation)&&t.synthetic!==true&&!(t.synthetic===undefined&&t.spans.length>0&&t.spans.every(s=>s.name==='agent')));
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
function morningOutputs(outcome, failure){
  if(typeof outcome?.ok!=='boolean')return {};
  const code=MORNING_SKIPS.has(outcome.code)||MORNING_SUCCESS.has(outcome.code)?outcome.code:failure?.code;
  const result={ok:outcome.ok,...(code?{code}:{})};
  for(const key of ['attempted','sent','prepared','groupFailures','skipped']){
    if(Number.isSafeInteger(outcome[key])&&outcome[key]>=0&&outcome[key]<=1000)result[key]=outcome[key];
  }
  if(['cams_global','gefs_aerosols'].includes(outcome.pm25Source))result.pm25Source=outcome.pm25Source;
  if(Array.isArray(outcome.failedParts)){
    result.failedParts=outcome.failedParts.slice(0,2)
      .filter(row=>row?.part==='weather'||row?.part==='campus')
      .map(({part,code})=>({part,code:failureDetail('morning',{code}).code??'UNKNOWN'}));
  }
  if(typeof outcome.failureNotice?.ok==='boolean'){
    const notice=outcome.failureNotice;
    result.failureNotice={ok:notice.ok,code:notice.ok?'SENT':
      notice.code==='DUPLICATE'?'DUPLICATE':failureDetail('morning_failure_notice',notice).code??'UNKNOWN'};
  }
  return result;
}
function runPayload(trace,span,project,orders,request){
  const row=span??trace;
  const metrics=tokenFields(row);
  const metadata={...contextFields(trace),duration_ms:row.durationMs,status:row.status,...metrics};
  const segment=run=>run.startTime.replace(/[-:.]/g,'').replace(/Z$/,'000Z')+run.id;
  if(span?.calls!==undefined){metadata.calls=span.calls;metadata.total_work_ms=span.workMs;}
  const parent=span?.parentId??trace.id;
  const dottedOrder=span?orders.get(parent)+'.'+segment(span):segment(trace);
  orders.set(row.id,dottedOrder);
  const detail=span?remoteDetails.get(span):request;
  const params=detail.inputs;
  const showMessage=!span||['agent','router_model','chat_model'].includes(span.name)||!Object.keys(params).length;
  const inputs={...(showMessage&&request.message!==undefined?{message:request.message}:{}),...params};
  if(MORNING_OPERATIONS.has(trace.operation))inputs.event=trace.operation;
  else if(!Object.keys(inputs).length)Object.assign(inputs,{event:trace.synthetic?'monitoring_test':'qq_event',...contextFields(trace)});
  const result={id:row.id,trace_id:trace.id,dotted_order:dottedOrder,...span?{parent_run_id:parent}:{},name:span?span.name:'qq.'+(trace.operation??'response'),run_type:span&&['router_model','chat_model'].includes(span.name)?'llm':span?.name==='tool'?'tool':'chain',session_name:project,inputs,outputs:span?{}:request.outputs??{},start_time:row.startTime,end_time:row.endTime,extra:{metadata}};
  if(detail.failure)result.error=detail.failure.message;
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
    const scheduled=MORNING_OPERATIONS.has(context?.operation);
    const date=scheduled&&typeof context.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(context.date)?context.date:undefined;
    const parameters=date?{date}:{};
    if(scheduled&&typeof context.part==='string'&&Object.hasOwn(MORNING_PART_FEATURES,context.part))parameters.part=context.part;
    if(context?.operation==='morning.retry'){
      if(Number.isInteger(context.retry)&&context.retry>=1&&context.retry<=MORNING_MAX_RETRIES)parameters.retry=context.retry;
    }
    const trace={id:randomUUID(),startTime:new Date(timeValue(this.#now)).toISOString(),...contextFields(context),...(scheduled||MILKY_EVENTS.has(context?.operation)?{operation:context.operation}:{}),spans:[],parameters,causes:new WeakMap(),now:this.#now,clock:this.#clock,closed:false};
    let status='ok',outcome;
    try{outcome=await activeTrace.run(trace,fn);return outcome;}catch(error){trace.failure=diagnostic(trace,scheduled?trace.operation:'qq.response',error);throw error;}
    finally{
      trace.closed=true;
      const pausedReply=!scheduled&&outcome?.ok===false&&outcome.code==='PAUSED';
      if(scheduled&&outcome?.ok===false&&!MORNING_SKIPS.has(outcome.code)){
        const detail=failureDetail(trace.operation,outcome);
        const child=detail.code&&trace.spans.findLast(span=>span.status==='error'&&span.name!=='worker_total'&&remoteDetails.get(span)?.failure?.code===detail.code);
        trace.failure=child?remoteDetails.get(child).failure:detail;
      }else if(pausedReply){
        trace.failure??=failureDetail('qq.response',outcome);
      }else if(!scheduled&&!trace.failure&&outcome?.ok===false&&trace.message&&!['DUPLICATE','IGNORED','GROUP_ACCESS_DENIED','GROUP_DISABLED'].includes(outcome.code)){
        trace.failure=failureDetail('qq.response',outcome);
      }
      if(trace.failure)status='error';
      if(!(status==='ok'&&outcome?.code==='IGNORED'&&!trace.spans.some(s=>s.name==='agent'||s.name.startsWith('worker_')))){
      const duration=round(Math.min(86_400_000,Math.max(0,clockValue(this.#clock)-start)));
      const record={id:trace.id,startTime:trace.startTime,endTime:new Date(timeValue(this.#now)).toISOString(),durationMs:duration,totalMs:duration,status,...contextFields(trace),...(trace.operation?{operation:trace.operation}:{}),spans:trace.spans};
      this.#recent.unshift(record);this.#recent=this.#recent.slice(0,MAX_RECENT);
      this.#schedulePersist();
      if(this.#queue.length+this.#inFlight>=MAX_PENDING){this.#remote.dropped++;this.#remote.lastCode='QUEUE_FULL';}
      else{
        const outputs=scheduled?morningOutputs(outcome,trace.failure):pausedReply?{ok:false,code:'PAUSED'}:undefined;
        this.#queue.push({record,detail:{message:trace.message,inputs:trace.parameters,failure:trace.failure,outputs}});
        if(!this.#busy){this.#busy=true;setImmediate(()=>this.#drain());}
      }
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
        const queued=this.#queue.shift();if(!queued)break;
        const {record:trace,detail}=queued;
        this.#inFlight=1;
        let config;
        try{config=destination(await this.#configStore?.read());}
        catch{this.#remote.enabled=false;this.#remote.failed++;this.#remote.lastCode='LANGSMITH_CONFIG_UNAVAILABLE';continue;}
        this.#remote.enabled=Boolean(config);
        if(!config){this.#remote.lastCode='DISABLED';continue;}
        try{
          const orders=new Map();
          for(const span of [null,...trace.spans]){
            await this.#post(config,runPayload(trace,span,config.project,orders,detail));this.#remote.sentRuns++;
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
