import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {recordTiming} from './telemetry.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
export function pythonEnvironment(source=process.env){
  const env={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP','TMPDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','PLAYWRIGHT_BROWSERS_PATH','QQ_FONT_REGULAR','QQ_FONT_BOLD'])if(source[key])env[key]=source[key];
  return {...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',LANGCHAIN_TRACING:'false',LANGCHAIN_TRACING_V2:'false',LANGSMITH_TRACING:'false',LANGCHAIN_VERBOSE:'false'};
}
const failure=()=>Object.assign(new Error('PYTHON_AGENT_UNAVAILABLE'),{code:'PYTHON_AGENT_UNAVAILABLE'});
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
  #stop(details={}){const child=this.#child;this.#child=null;this.#buffer='';if(child)child.kill();if(this.#current){const task=this.#current;this.#current=null;clearTimeout(task.timer);task.reject(Object.assign(failure(),{toolExecuted:task.called,...details}));}}
  #timeout(){const task=this.#current;this.#stop({timedOut:true,timeoutMs:task?.limitMs??this.timeoutMs,stage:task?.stage});}
  close(){this.#closed=true;clearTimeout(this.#idleTimer);this.#stop();}
  prewarm(){if(this.#closed)return false;try{this.#start();this.#scheduleIdle();return true;}catch{return false;}}
  warmup(){return this.run({type:'warmup'},async()=>{throw Error('WARMUP_RPC_DENIED');},()=>true);}
  #write(value){if(!this.#child?.stdin.writable)throw failure();this.#child.stdin.write(JSON.stringify(value)+'\n');}
  #start(){
    if(this.#child)return;
    const child=this.spawnImpl(this.pythonPath,['-u',this.workerPath],{cwd:this.home,windowsHide:true,stdio:['pipe','pipe','pipe'],env:pythonEnvironment()});
    this.#child=child;child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{
      if(this.#child!==child)return;this.#buffer+=chunk;
      if(Buffer.byteLength(this.#buffer)>this.maxLineBytes){this.#stop();return;}
      let index;while((index=this.#buffer.indexOf('\n'))>=0){const line=this.#buffer.slice(0,index);this.#buffer=this.#buffer.slice(index+1);this.#line(line).catch(()=>this.#stop());}
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
    if(value.type==='tool'){
      if(task.called||typeof value.callId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(value.callId))throw failure();
      task.called=true;task.stage=value.name;
      if(Object.hasOwn(this.toolTimeouts,value.name)){
        task.limitMs=this.toolTimeouts[value.name];task.stage=value.name;
        clearTimeout(task.timer);task.timer=setTimeout(()=>this.#timeout(),task.limitMs);
      }
      try{
        const artifact=await task.execute(value.name,value.args);
        if(this.#current!==task)return;
        task.artifact=artifact;task.completed=true;
        this.#write({type:'tool_result',id:task.id,callId:value.callId,content:artifact?.image?'本机图片已生成。':artifact?.campusRecommendation?'已生成缓存推荐事实，将由独立解释阶段回答。':String(artifact?.text||'没有结果。').slice(0,3000)});
      }catch(error){if(this.#current===task){task.toolError=error instanceof Error?error:new Error('WEATHER_TOOL_ERROR');this.#write({type:'tool_result',id:task.id,callId:value.callId,content:'工具暂不可用。'});}}
      return;
    }
    if(value.type!=='result'||!['tool','conversion','reasoned','balance','chat','clarify','ignore','error','analysis','campus'].includes(value.kind))throw failure();
    task.record('worker_total',performance.now()-task.startedAt);
    if(Number.isFinite(value.startupMs))task.record('worker_startup',value.startupMs,{startedAtMs:task.sentAtMs});
    for(const timing of Array.isArray(value.timings)?value.timings.slice(0,32):[])if(timing&&typeof timing==='object')task.record(timing.name,timing.ms,{...timing,...Number.isFinite(timing.offsetMs)&&Number.isFinite(value.startupMs)?{startedAtMs:task.sentAtMs+value.startupMs+timing.offsetMs}:{}});
    if(value.kind==='campus'&&task.requestType!=='campus')throw failure();
    if(value.kind==='balance'&&task.requestType!=='request'&&!(task.requestType==='execute'&&task.requestName==='deepseek_account_balance'))throw failure();
    if(value.kind==='reasoned'&&!['request','campus_advice'].includes(task.requestType))throw failure();
    if(value.kind==='analysis'&&!['morning','social','media','insight','social_insight_save','public_status','global_radar'].includes(task.requestType))throw failure();
    if(value.kind==='conversion'&&task.requestType!=='request'&&!(task.requestType==='execute'&&task.requestName==='convert_units'))throw failure();
    if(value.kind==='error'){
      const allowed=new Set(['MODEL_AUTH_ERROR','MODEL_BALANCE_INSUFFICIENT','MODEL_PROVIDER_RATE_LIMITED','MODEL_PROVIDER_UNAVAILABLE','MODEL_TIMEOUT','MODEL_CONNECTION_ERROR','MODEL_TOOL_ROUTING_FAILED']);
      clearTimeout(task.timer);this.#current=null;
      task.reject(Object.assign(failure(),{reason:allowed.has(value.code)?value.code:'WORKER_FAILED',toolExecuted:task.called}));return;
    }
    if((value.kind==='tool'&&!task.completed&&!task.toolError)||(task.called&&value.kind!=='tool'))throw failure();
    if(value.kind==='tool'&&task.toolError){clearTimeout(task.timer);this.#current=null;task.reject(Object.assign(task.toolError,{toolExecuted:true}));return;}
    const output=value.kind==='tool'?task.artifact:task.finish(value);
    clearTimeout(task.timer);this.#current=null;task.resolve(output);
  }
  run(payload,execute,finish=()=>null){
    clearTimeout(this.#idleTimer);
    this.#queued++;
    const queuedAt=performance.now();
    const operation=this.#tail.then(()=>new Promise((resolveTask,reject)=>{
      try{if(this.#closed)throw failure();recordTiming('worker_queue',performance.now()-queuedAt);this.#start();const id=randomUUID(),sentAtMs=Date.now();this.#current={id,sentAtMs,startedAt:performance.now(),record:AsyncLocalStorage.bind(recordTiming),requestType:payload.type,requestName:payload.name,execute:AsyncLocalStorage.bind(execute),finish:AsyncLocalStorage.bind(finish),resolve:resolveTask,reject,called:false,completed:false,limitMs:this.timeoutMs,stage:payload.name,timer:setTimeout(()=>this.#timeout(),this.timeoutMs)};this.#write({...payload,id,_sentAtMs:sentAtMs});}
      catch{this.#stop();reject(failure());}
    })).finally(()=>{this.#queued--;this.#scheduleIdle();});
    this.#tail=operation.catch(()=>{});return operation;
  }
}
