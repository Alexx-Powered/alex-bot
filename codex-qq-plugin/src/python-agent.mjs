import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {lstat,open,unlink} from 'node:fs/promises';
import {constants,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {toolFeature} from './group-features.mjs';
import {validVideo} from './video-media.mjs';
import {acquireHeavyWork} from './heavy-work.mjs';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {beginSpan,hasActiveTrace,recordTiming,recordRequestFailure,setTraceOperation,setTraceParameters,videoWorkerStages,campusWorkerStages} from './telemetry.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
export function pythonEnvironment(source=process.env){
  const env={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','PLAYWRIGHT_BROWSERS_PATH','QQ_FONT_REGULAR','QQ_FONT_BOLD','QQ_RAG_CONFIG'])if(source[key])env[key]=source[key];
  return {...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',LANGCHAIN_TRACING:'false',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',LANGCHAIN_VERBOSE:'false'};
}
const failure=()=>Object.assign(new Error('PYTHON_AGENT_UNAVAILABLE'),{code:'PYTHON_AGENT_UNAVAILABLE'});
const RAG_ERRORS=new Set(['RAG_DISABLED','RAG_VECTOR_NOT_CONFIGURED','RAG_VECTOR_UNAVAILABLE','RAG_STORE_UNAVAILABLE','RAG_INDEX_MANIFEST_MISMATCH','RAG_EMBEDDING_MISMATCH','EMBEDDING_DIMENSION_MISMATCH','RAG_EXPLICIT_SAVE_REQUIRED','RAG_EXPLICIT_DELETE_REQUIRED','HIKING_FORECAST_TIMEOUT','HIKING_FORECAST_UNAVAILABLE']);
const workerOperations=Object.freeze({
  weather_image:'weather.report',air_quality_image:'weather.air',radar_image:'weather.radar',radar_catalog:'weather.radar',
  cloud_video:'video.cloud_forecast',satellite_video:'video.satellite',pm25_video:'video.pm25',
  precipitation_video:'video.precipitation',temperature_video:'video.temperature',hiking_trip_card:'hiking.trip',
  ai_service_status:'service.status',liang_status:'service.status',deepseek_service_status:'service.status',
  buaa_classroom_query:'campus.query',buaa_classroom_recommend:'campus.query',
  deepseek_account_balance:'agent.request',
  search_domain_knowledge:'knowledge.query',prepare_outdoor_trip:'knowledge.query',request_outdoor_research:'knowledge.query',
  save_project_note:'knowledge.query',delete_project_note:'knowledge.query',recall_project_notes:'knowledge.query',
});
const ragPermissions={prepare_outdoor_trip:'weather',request_outdoor_research:'weather',save_project_note:'memory',delete_project_note:'memory',recall_project_notes:'memory'};

async function readWorkerReply(home,id,value){
  if(typeof value.text!=='string'||value.text.length>4000)throw failure();
  const reply={text:value.text};
  if(value.cancelled===true)return {cancelled:true};
  if(!value.media)return reply;
  if(!['png','jpg','mp4'].includes(value.media))throw failure();
  const file=join(home,'.private','worker-replies',id+'.'+value.media);
  const dir=await lstat(join(home,'.private','worker-replies'));
  const entry=await lstat(file);
  if(!dir.isDirectory()||!entry.isFile())throw failure();
  const input=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const info=await input.stat();
    if(!info.isFile()||info.dev!==entry.dev||info.ino!==entry.ino||info.size<8||info.size>5*1024*1024)throw failure();
    const buffer=Buffer.alloc(info.size);
    for(let offset=0;offset<buffer.length;){
      const {bytesRead}=await input.read(buffer,offset,buffer.length-offset,offset);
      if(!bytesRead)throw failure();
      offset+=bytesRead;
    }
    if(value.media==='mp4'){
      reply.video={buffer,mimeType:'video/mp4'};
      if(!validVideo(reply.video))throw failure();
    }else{
      const png=value.media==='png';
      if(png?!buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):buffer.readUInt16BE()!==0xffd8)throw failure();
      reply.image={buffer,mimeType:png?'image/png':'image/jpeg'};
      if(value.richMedia===true&&reply.text.trim())reply.richMedia=true;
    }
  }finally{await input.close();await unlink(file).catch(()=>{});}
  return reply;
}
export class PythonAgentWorker{
  #child;#current;#tail=Promise.resolve();#buffer='';#closed=false;
  #idleTimer;#queued=0;
  constructor({home,pythonPath=pythonExecutable(),workerPath=resolve(APP_ROOT,'python','agent_worker.py'),spawnImpl=spawn,timeoutMs=60000,maxLineBytes=65536,toolTimeouts={},idleMs=0}){Object.assign(this,{home,pythonPath,workerPath,spawnImpl,timeoutMs,maxLineBytes,toolTimeouts,idleMs});}
  #scheduleIdle(){
    clearTimeout(this.#idleTimer);
    if(!this.idleMs||!this.#child||this.#closed||this.#queued)return;
    const child=this.#child;
    this.#idleTimer=setTimeout(()=>{if(this.#child===child&&!this.#queued&&!this.#current)this.#stop();},this.idleMs);
    this.#idleTimer.unref();
  }
  #stop(details={}){
    const child=this.#child;this.#child=null;this.#buffer='';if(child)child.kill();
    if(!this.#current)return;
    const task=this.#current;this.#current=null;clearTimeout(task.timer);task.releaseHeavy?.();
    const error=Object.assign(failure(),{toolExecuted:task.called||Boolean(task.authorizedTool),...details});
    task.workerSpan?.end('error',undefined,error);
    task.record('worker_total',performance.now()-task.startedAt,{status:'error',error});
    task.reject(error);
  }
  #timeout(){const task=this.#current;this.#stop({timedOut:true,timeoutMs:task?.limitMs??this.timeoutMs,stage:task?.stage,
    ...(task?.requestType==='campus'?{code:'CAMPUS_WORKER_TIMEOUT'}:{})});}
  close(){this.#closed=true;clearTimeout(this.#idleTimer);this.#stop();}
  get busy(){return this.#queued>0||Boolean(this.#current)||this.#closed;}
  prewarm(){if(this.#closed)return false;try{this.#start();this.#scheduleIdle();return true;}catch{return false;}}
  warmup(){return this.run({type:'warmup'},async()=>{throw Error('WARMUP_RPC_DENIED');},()=>true);}
  #write(value){if(!this.#child?.stdin.writable)throw failure();this.#child.stdin.write(JSON.stringify(value)+'\n');}
  #start(){
    if(this.#child)return;
    const env=pythonEnvironment();
    if(this.workerPath===resolve(APP_ROOT,'python','agent_worker.py')){
      env.QQ_CANVAS_NODE=process.execPath;
      const keyFile=process.env.AMAP_WEB_KEY_FILE||(process.env.CREDENTIALS_DIRECTORY&&join(process.env.CREDENTIALS_DIRECTORY,'amap.web-key'));
      if(process.env.AMAP_WEB_KEY)env.AMAP_WEB_KEY=process.env.AMAP_WEB_KEY;
      else if(keyFile&&existsSync(keyFile))env.AMAP_WEB_KEY_FILE=keyFile;
    }
    const child=this.spawnImpl(this.pythonPath,['-u',this.workerPath],{cwd:this.home,windowsHide:true,stdio:['pipe','pipe','pipe'],env});
    this.#child=child;child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(this.#child!==child)return;this.#buffer+=chunk;
      let index;
      while((index=this.#buffer.indexOf('\n'))>=0){
        const line=this.#buffer.slice(0,index),task=this.#current;
        this.#buffer=this.#buffer.slice(index+1);
        if(Buffer.byteLength(line)+1>this.maxLineBytes){this.#stop();return;}
        this.#line(line).catch(()=>{if(this.#child===child&&this.#current===task)this.#stop();});
      }
      if(Buffer.byteLength(this.#buffer)>this.maxLineBytes)this.#stop();
    });
    // Never forward raw provider stderr, which might contain credentials.
    child.stderr.resume();
    child.stdin.on('error',()=>{if(this.#child===child)this.#stop();});
    child.on('error',()=>{if(this.#child===child)this.#stop();});
    child.on('exit',()=>{if(this.#child===child)this.#stop();});
  }
  async #line(line){
    const value=JSON.parse(line),task=this.#current;
    if(!task||value.id!==task.id)throw failure();
    const video=value.type==='video_stage'&&(task.requestType==='weather_video'||workerOperations[task.authorizedTool]?.startsWith('video.'));
    const campus=value.type==='campus_stage'&&(task.requestType==='campus'||toolFeature(task.authorizedTool)==='campus');
    if(video||campus){
      if(!(video?videoWorkerStages:campusWorkerStages).includes(value.stage))return;
      if(value.phase==='start'&&!task.workerSpan){
        task.workerStage=value.stage;task.workerSpan=task.begin(value.stage,value.startedAtMs);
      }else if(task.workerSpan&&value.stage===task.workerStage&&['ok','error','fallback'].includes(value.phase)){
        if(video)task.workerSpan.run(()=>{
          for(const s of Array.isArray(value.samples)?value.samples.slice(0,2):[]){
            if(s&&['video_decode_slowest','video_download_slowest'].includes(s.name))recordTiming(s.name,s.ms,s);
          }
        });
        task.workerSpan.end(value.phase,value.ms,value);task.workerSpan=null;
      }
      return;
    }
    if(value.type==='authorize'){
      const tool=value.tool;
      if(!task.attachmentReply||task.called||task.authorizationStarted||!Object.hasOwn(workerOperations,tool)||
        !(['request','fixed_request'].includes(task.requestType)||(['execute','rag'].includes(task.requestType)&&task.requestName===tool)))throw failure();
      task.authorizationStarted=true;
      const feature=tool==='search_domain_knowledge'?value.feature:toolFeature(tool)??ragPermissions[tool];
      if(!feature||(workerOperations[tool]==='knowledge.query'&&!['weather','memory','campus'].includes(feature)))throw failure();
      const grant=await task.authorizeFeature(feature,tool);
      if(this.#current!==task)return;
      const allowed=grant===true||(['campus','balance'].includes(feature)&&grant&&typeof grant==='object');
      if(allowed){
        if(tool!=='deepseek_account_balance'&&tool!=='radar_catalog'&&workerOperations[tool]!=='knowledge.query'&&(grant===true||grant.code==='OK')){
          const release=await task.acquireHeavy();
          if(this.#current!==task){release();return;}
          task.releaseHeavy=release;
        }
        task.stage=task.authorizedTool=tool;
        task.campusGrant=feature==='campus'&&grant!==true?grant:undefined;
        task.limitMs=this.toolTimeouts[tool]??(workerOperations[tool].startsWith('video.')?190000:90000);
        clearTimeout(task.timer);task.timer=setTimeout(()=>this.#timeout(),task.limitMs);
        task.traceTool(tool,value.trace);
      }
      this.#write({type:'authorization',id:task.id,allowed:Boolean(allowed),...(allowed&&grant!==true?{grant}:{})});
      return;
    }
    if(value.type==='campus_continue'){
      if(toolFeature(task.authorizedTool)!=='campus'||task.campusGrant?.code!=='OK')throw failure();
      const allowed=await task.campusEvents.allowed?.();
      if(this.#current===task)this.#write({type:'authorization',id:task.id,allowed:allowed===true});
      return;
    }
    if(value.type==='campus_session'||value.type==='campus_progress'){
      if(task.authorizedTool!=='buaa_classroom_query'||!task.campusGrant||task.campusGrant.code!=='OK')throw failure();
      const allowed=value.type==='campus_session'
        ?await task.campusEvents.saveSession?.(task.campusGrant,value.state)
        :['campus-fetch','campus-fetch-current'].includes(value.stage)&&await task.campusEvents.progress?.(value.stage);
      if(this.#current===task)this.#write({type:'authorization',id:task.id,allowed:allowed===true});
      return;
    }
    if(value.type==='tool'){
      if(task.attachmentReply||task.called||typeof value.callId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value.callId))throw failure();
      task.called=true;task.stage=value.name;
      if(Object.hasOwn(this.toolTimeouts,value.name)){
        task.limitMs=this.toolTimeouts[value.name];task.stage=value.name;
        clearTimeout(task.timer);task.timer=setTimeout(()=>this.#timeout(),task.limitMs);
      }
      try{
        const artifact=await task.execute(value.name,value.args);
        if(this.#current!==task)return;
        task.artifact=artifact;task.completed=true;
        this.#write({type:'tool_result',id:task.id,callId:value.callId,content:artifact?.video?'本机视频已生成。':artifact?.image?'本机图片已生成。':artifact?.campusRecommendation?'已生成缓存推荐事实，将由独立解释阶段回答。':String(artifact?.text||'没有结果。').slice(0,3000)});
      }catch(error){if(this.#current===task){task.toolError=error instanceof Error?error:new Error('WEATHER_TOOL_ERROR');this.#write({type:'tool_result',id:task.id,callId:value.callId,content:'工具暂不可用。'});}}
      return;
    }
    if(value.type!=='result'||!['attachment','tool','conversion','reasoned','balance','chat','clarify','ignore','error','analysis','campus','rag'].includes(value.kind))throw failure();
    task.releaseHeavy?.();
    const ragResult=value.kind==='rag'||(value.kind==='attachment'&&value.tool==='hiking_trip_card');
    const ragFailure=ragResult&&['unavailable','denied','invalid','rejected'].includes(value.status);
    const ragError=ragResult&&RAG_ERRORS.has(value.errorCode)?{code:value.errorCode}:undefined;
    const workerError=task.toolError??(value.kind==='error'?{reason:value.code}:ragFailure?(ragError??{code:'RAG_STORE_UNAVAILABLE'}):value.data?.ok===false?{code:value.data.code}:undefined);
    task.workerSpan?.end('error',undefined,workerError);
    task.record('worker_total',performance.now()-task.startedAt,{status:workerError?'error':'ok',error:workerError});
    if(Number.isFinite(value.startupMs))task.record('worker_startup',value.startupMs,{startedAtMs:task.sentAtMs});
    for(const timing of Array.isArray(value.timings)?value.timings.slice(0,32):[])if(timing&&typeof timing==='object')task.record(timing.name,timing.ms,{...timing,...Number.isFinite(timing.offsetMs)&&Number.isFinite(value.startupMs)?{startedAtMs:task.sentAtMs+value.startupMs+timing.offsetMs}:{}});
    if(ragResult){
      const timing=value.ragTimings??{},valid=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=600000;
      const total=valid(timing.total_ms)?timing.total_ms:0;
      let cursor=valid(value.ragStartedAtMs-task.sentAtMs)?value.ragStartedAtMs:task.sentAtMs;
      for(const stage of ['lexical','embedding','vector','source_verify','hiking_route','hiking_locate','hiking_fetch']){
        const ms=timing[stage+'_ms'];if(!valid(ms))continue;
        const failed=ragError&&value.ragFailedStage===stage;
        task.record(stage.startsWith('hiking_')?stage:'rag_'+stage,ms,{startedAtMs:cursor,...(failed?{status:ragFailure?'error':'fallback',error:ragError}:{})});cursor+=ms;
      }
      if(ragError&&!value.ragFailedStage)task.record('rag_vector',0,{status:ragFailure?'error':'fallback',error:ragError});
      task.record('rag_retrieval',total,{...(ragFailure?{status:'error',error:workerError}:{})});
      if(ragFailure)task.failTrace(workerError,'rag_retrieval');
    }
    if(value.kind==='campus'&&task.requestType!=='campus')throw failure();
    if(value.kind==='rag'&&(!['request','fixed_request','rag','rag_control'].includes(task.requestType)||!['campus','weather','memory'].includes(value.requiredFeature)||typeof value.text!=='string'||value.text.length>1600))throw failure();
    if(value.kind==='balance'&&!['request','fixed_request'].includes(task.requestType)&&!(task.requestType==='execute'&&task.requestName==='deepseek_account_balance'))throw failure();
    if(value.kind==='reasoned'&&!['request','campus_advice'].includes(task.requestType))throw failure();
    if(value.kind==='analysis'&&!['morning','social','media','insight','social_insight_save','public_status','global_radar','weather_video','rag_index'].includes(task.requestType))throw failure();
    if(value.kind==='conversion'&&!['request','fixed_request'].includes(task.requestType)&&!(task.requestType==='execute'&&task.requestName==='convert_units'))throw failure();
    if(value.kind==='error'){
      const allowed=new Set(['MODEL_AUTH_ERROR','MODEL_BALANCE_INSUFFICIENT','MODEL_PROVIDER_RATE_LIMITED','MODEL_PROVIDER_UNAVAILABLE','MODEL_TIMEOUT','MODEL_CONNECTION_ERROR','MODEL_TOOL_ROUTING_FAILED','MODEL_TOOL_PROTOCOL_ERROR','MODEL_REQUEST_REJECTED']);
      clearTimeout(task.timer);this.#current=null;
      task.reject(Object.assign(failure(),{reason:allowed.has(value.code)?value.code:'WORKER_FAILED',toolExecuted:task.called||Boolean(task.authorizedTool)}));return;
    }
    if((value.kind==='tool'&&!task.completed&&!task.toolError)||(task.called&&value.kind!=='tool'))throw failure();
    if(value.kind==='tool'&&task.toolError){clearTimeout(task.timer);this.#current=null;task.reject(Object.assign(task.toolError,{toolExecuted:true}));return;}
    if(value.kind==='attachment'){
      if(task.called||!task.authorizedTool||task.authorizedTool!==value.tool||task.authorizedTool==='deepseek_account_balance'||workerOperations[value.tool]==='knowledge.query')throw failure();
      value.reply=await readWorkerReply(this.home,task.id,value);
      if(this.#current!==task)return;
    }
    const output=value.kind==='tool'?task.artifact:task.finish(value);
    clearTimeout(task.timer);this.#current=null;task.resolve(output);
  }
  run(payload,execute,finish=()=>null,authorizeFeature=()=>false,campusEvents={}){
    if(payload.type==='campus')setTraceOperation('campus.query',true);
    if(payload.type==='public_status')setTraceOperation('service.status',true);
    if(payload.type==='execute'&&payload.name==='convert_units')setTraceOperation('tools.convert',true);
    if(payload.type==='request')setTraceOperation('agent.request',true);
    if(['rag','rag_control'].includes(payload.type))setTraceOperation('knowledge.query',true);
    clearTimeout(this.#idleTimer);
    this.#queued++;
    const queuedAt=performance.now();
    const operation=this.#tail.then(()=>new Promise((resolveTask,reject)=>{
      try{
        if(this.#closed)throw failure();
        recordTiming('worker_queue',performance.now()-queuedAt);this.#start();
        const id=randomUUID(),sentAtMs=Date.now();
        const limitMs=payload.type==='campus'&&payload.timeout_profile==='morning'?this.toolTimeouts.campusMorning??this.timeoutMs:this.timeoutMs;
        this.#current={id,sentAtMs,startedAt:performance.now(),record:AsyncLocalStorage.bind(recordTiming),failTrace:AsyncLocalStorage.bind(recordRequestFailure),
          begin:AsyncLocalStorage.bind(beginSpan),traceTool:AsyncLocalStorage.bind((tool,params={})=>{
            setTraceOperation(workerOperations[tool]);
            setTraceParameters({...params,city:params.city??params.target});
          }),authorizeFeature:AsyncLocalStorage.bind(authorizeFeature),campusEvents,
          acquireHeavy:AsyncLocalStorage.bind(acquireHeavyWork),
          attachmentReply:payload.replyFormat==='attachment-v1',requestType:payload.type,requestName:payload.name,execute:AsyncLocalStorage.bind(execute),
          finish:AsyncLocalStorage.bind(finish),resolve:resolveTask,reject,called:false,completed:false,limitMs,stage:payload.name,timer:setTimeout(()=>this.#timeout(),limitMs)};
        const traceFlag=payload.type==='weather_video'?'_traceVideo':payload.type==='campus'?'_traceCampus':null;
        this.#write({...payload,id,_sentAtMs:sentAtMs,...(traceFlag&&hasActiveTrace()?{[traceFlag]:true}:{})});
      }
      catch{this.#stop();reject(failure());}
    })).finally(()=>{this.#queued--;this.#scheduleIdle();});
    this.#tail=operation.catch(()=>{});return operation;
  }
}
