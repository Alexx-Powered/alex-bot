// Independent oneshot service. No import of the QQ server, agent or Milvus.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {AgentConfigStore} from '../src/agent-config.mjs';
import {isEntrypoint} from '../src/entrypoint.mjs';

const script = fileURLToPath(new URL('../python/research_service.py', import.meta.url));
const PYTHON = '/opt/alex-bot-runtime/python/app-venv/bin/python';
const HOME = '/var/lib/alexbot';
const CONFIG = `${HOME}/.private/rag-config.json`;
const statuses = new Set(['disabled','idle','busy','ready','completed','empty','timeout','failed','low_memory']);
const failure = code => ({status:'failed',error_code:code});

export function childEnvironment(source = process.env) {
  const result = {};
  for (const [key,value] of Object.entries(source)) {
    if (['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LANG','LC_ALL','SYSTEMDRIVE'].includes(key.toUpperCase())) result[key]=value;
  }
  return {...result,QQ_RAG_CONFIG:source.QQ_RAG_CONFIG || CONFIG,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
}

export function safeSummary(value) {
  if (!value || typeof value !== 'object' || !statuses.has(value.status)) return failure('RESEARCH_INVALID_OUTPUT');
  const result = {status:value.status};
  if (['check','publish'].includes(value.stage)) {
    result.stage=value.stage;
    if (['supported','insufficient','conflicting','pending'].includes(value.verdict)) result.verdict=value.verdict;
  }
  if (typeof value.error_code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value.error_code)) result.error_code=value.error_code;
  if (Number.isInteger(value.candidate_count) && value.candidate_count>=0 && value.candidate_count<=3) result.candidate_count=value.candidate_count;
  const keys = ['search_calls','fetch_calls','retries','llm_calls','search_ms','fetch_ms','validate_ms','total_ms','raw_hits','discovered_hits','eligible_pages','hiking_profiles','rag_updates','latency_ms','prompt_tokens','completion_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens'];
  if (value.metrics && typeof value.metrics==='object') {
    result.metrics=Object.fromEntries(keys.filter(key=>Number.isFinite(value.metrics[key]) && value.metrics[key]>=0 && value.metrics[key]<=600000).map(key=>[key,value.metrics[key]]));
  }
  return result;
}

export function runPython(mode, packet, {spawnProcess=spawn,python=process.env.QQ_PYTHON || PYTHON,timeoutMs=25000,env=childEnvironment()} = {}) {
  if (!['--probe','--consume','--review'].includes(mode) || !path.isAbsolute(python)) return Promise.resolve(failure('RESEARCH_ARGUMENTS_INVALID'));
  return new Promise(resolve=>{
    let child, timer, finished=false, bytes=0, chunks=[];
    const finish = value=>{if(finished)return;finished=true;clearTimeout(timer);resolve(safeSummary(value));};
    const kill = ()=>{
      try { if(process.platform!=='win32' && child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL'); }
      catch {try{child.kill('SIGKILL');}catch{}}
    };
    try {
      child=spawnProcess(python,['-B',script,mode],{cwd:HOME,env,stdio:['pipe','pipe','ignore'],windowsHide:true,detached:process.platform!=='win32'});
    } catch {finish(failure('RESEARCH_CHILD_START_FAILED'));return;}
    timer=setTimeout(()=>{kill();finish({status:'timeout',error_code:'RESEARCH_SUPERVISOR_TIMEOUT'});},timeoutMs);
    child.on('error',()=>finish(failure('RESEARCH_CHILD_START_FAILED')));
    child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>8192){kill();finish(failure('RESEARCH_OUTPUT_TOO_LARGE'));return;}
      chunks.push(chunk);
    });
    child.on('close',code=>{
      if(finished)return;
      if(code!==0){finish(failure('RESEARCH_CHILD_FAILED'));return;}
      try {finish(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
      catch {finish(failure('RESEARCH_INVALID_OUTPUT'));}
    });
    // Credentials never enter argv, env, files, stderr, or parent output.
    child.stdin.end(packet ? JSON.stringify(packet) : '');
  });
}

export async function runResearchTick({invoke=runPython,loadConfig=()=>new AgentConfigStore(HOME).read()} = {}) {
  try {
    const state=safeSummary(await invoke('--probe',null,{timeoutMs:3000}));
    if(state.status!=='ready')return state;
    const config=await loadConfig();
    if(config?.provider!=='deepseek' || typeof config.apiKey!=='string' || !/^\S{8,512}$/u.test(config.apiKey)) return failure('RESEARCH_CREDENTIAL_UNAVAILABLE');
    if(state.stage==='check')return safeSummary(await invoke('--review',{api_key:config.apiKey},{timeoutMs:80000}));
    return safeSummary(await invoke('--consume',{api_key:config.apiKey}));
  } catch {return failure('RESEARCH_RUNNER_FAILED');}
}

if (await isEntrypoint(import.meta.url)) {
  const result=process.argv.length===2 ? await runResearchTick() : failure('RESEARCH_ARGUMENTS_INVALID');
  if(!['idle','disabled','busy','low_memory'].includes(result.status))process.stdout.write(JSON.stringify(result)+'\n');
}
