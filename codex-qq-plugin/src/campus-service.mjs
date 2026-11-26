import fs from 'node:fs/promises';
import path from 'node:path';
import {PythonAgentWorker} from './python-agent.mjs';
import {atomicJson,protectCredential,unprotectCredential,credentialFormat} from './storage.mjs';
import {APP_ROOT} from './runtime-paths.mjs';
import {createHash} from 'node:crypto';
import {studyImage} from './study-briefing.mjs';
import {z} from 'zod';
import {fullAccess} from './access-policy.mjs';
import {withHeavyWork} from './heavy-work.mjs';

const source='https://app.buaa.edu.cn/site/classRoomQuery/index';
const semantics='接口标空闲则为空闲，其余课节为有课；保留接口给出的节次。';
const codes=['OK','CAMPUS_NOT_CONFIGURED','CAMPUS_DISABLED','CAMPUS_CONFIG_UNAVAILABLE','CAMPUS_BUSY',
  'CAMPUS_INVALID_DATE','CAMPUS_AUTH_FAILED','CAMPUS_INTERACTION_REQUIRED','CAMPUS_NETWORK_ERROR',
  'CAMPUS_SCHEMA_CHANGED','CAMPUS_BROWSER_UNAVAILABLE','CAMPUS_QUERY_FAILED','CAMPUS_RENDER_FAILED','CAMPUS_OWNER_ONLY',
  'CAMPUS_NAVIGATION_TIMEOUT','CAMPUS_LOGIN_TIMEOUT','CAMPUS_SEARCH_TIMEOUT','CAMPUS_WORKER_TIMEOUT','CAMPUS_INTERACTIVE_LOGIN_TIMEOUT','CAMPUS_LOGIN_ACTION_TIMEOUT',
  'CAMPUS_LOGIN_ACCOUNT_TIMEOUT','CAMPUS_LOGIN_PASSWORD_TIMEOUT','CAMPUS_LOGIN_SUBMIT_TIMEOUT'];
export const campusArgs=z.object({date:z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/).default('')}).strict();
const name=z.string().min(1).max(64).regex(/^[\p{L}\p{N}_（）()· .-]+$/u);
const periods=z.array(z.number().int().min(1).max(14)).max(14);
const schema=z.object({schema_version:z.literal('buaa-classrooms.v1'),ok:z.boolean(),code:z.enum(codes),
  campus:z.literal('学院路校区'),date:z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/),
  fetched_at:z.string().datetime({offset:true}),source:z.literal(source),semantics:z.literal(semantics),
  buildings:z.array(name).max(30),rooms:z.array(z.object({building:name,room:name,free_periods:periods,busy_periods:periods}).strict()).max(600)}).strict();
export function campusFailure(code,date=''){
  return {schema_version:'buaa-classrooms.v1',ok:false,code:codes.includes(code)?code:'CAMPUS_QUERY_FAILED',
    campus:'学院路校区',date:/^\d{4}-\d{2}-\d{2}$/.test(date)?date:'',fetched_at:new Date().toISOString(),source,semantics,buildings:[],rooms:[]};
}
export function validateCampusData(input){
  const data=schema.parse(input);
  if(data.ok!==(data.code==='OK')||(!data.ok&&(data.rooms.length||data.buildings.length)))throw Error('CAMPUS_SCHEMA_CHANGED');
  const seen=new Set();
  for(const r of data.rooms){
    const key=r.building+'\0'+r.room;
    if(seen.has(key)||!data.buildings.includes(r.building)||new Set([...r.free_periods,...r.busy_periods]).size!==14||r.free_periods.length+r.busy_periods.length!==14)throw Error('CAMPUS_SCHEMA_CHANGED');
    seen.add(key);
  }
  return data;
}
export class CampusService{
  #pendingQueries=new Set();#last=null;
  constructor({home,configStore,worker}){
    Object.assign(this,{home,configStore});
    this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python','campus_worker.py'),timeoutMs:210_000,
      toolTimeouts:{campusMorning:300_000},maxLineBytes:262144,idleMs:90_000});
  }
  async #collectorGrant(){
    try{
      const {enabled,username,password}=await this.configStore.read();
      if(!username||!password)return {code:'CAMPUS_NOT_CONFIGURED'};
      if(!enabled)return {code:'CAMPUS_DISABLED'};
      const credentialIdentity=createHash('sha256').update(username+'\0'+password).digest('hex');
      const grant={code:'OK',credentials:{enabled,username,password},credentialIdentity};
      if(process.platform!=='win32'){
        const file=path.join(this.home,'.private','campus-session.json');
        try{
          const {cipher}=JSON.parse(await fs.readFile(file,'utf8'));
          const saved=await unprotectCredential(cipher);
          if(saved.identity===credentialIdentity)grant.session_state=saved.state;
        }catch{ /* A missing or expired session requires a fresh login. */ }
      }
      return grant;
    }catch{return {code:'CAMPUS_CONFIG_UNAVAILABLE'};}
  }
  async workerGrant(tool,context){
    const denied={code:'CAMPUS_OWNER_ONLY'};
    if(!fullAccess(context,'campus'))return denied;
    if(tool==='buaa_classroom_query'||tool==='buaa_classroom_data'){
      const grant=await this.#collectorGrant();
      // Session reuse is optional. Leave headroom for the shared worker's 64 KiB packet.
      if(grant.session_state&&Buffer.byteLength(JSON.stringify(grant))>60000)delete grant.session_state;
      return fullAccess(context,'campus')?grant:denied;
    }
    if(tool!=='buaa_classroom_recommend')return denied;
    await Promise.allSettled(this.#pendingQueries);
    try{
      const {configured,enabled}=await this.configStore.status();
      if(!fullAccess(context,'campus'))return denied;
      return {code:!configured?'CAMPUS_NOT_CONFIGURED':enabled?'OK':'CAMPUS_DISABLED'};
    }catch{return {code:'CAMPUS_CONFIG_UNAVAILABLE'};}
  }
  async #saveSession(grant,state,authorized){
    if(process.platform==='win32'||!grant?.credentialIdentity||!authorized()||
       !Array.isArray(state?.cookies)||!Array.isArray(state?.origins))return false;
    const {enabled,username,password}=await this.configStore.read();
    if(!enabled||!username||!password)return false;
    const identity=createHash('sha256').update(username+'\0'+password).digest('hex');
    if(grant.credentialIdentity!==identity||!authorized())return false;
    const cipher=await protectCredential({identity,state});
    if(!authorized())return false;
    await atomicJson(path.join(this.home,'.private','campus-session.json'),{format:credentialFormat(),cipher});
    return true;
  }
  saveWorkerSession(grant,state,context){
    return this.#saveSession(grant,state,()=>fullAccess(context,'campus'));
  }
  async status(){
    let status;try{status=await this.configStore.status();}catch{status={enabled:false,configured:false,code:'CAMPUS_CONFIG_UNAVAILABLE'};}
    return {...status,busy:this.#pendingQueries.size>0,lastCode:this.#last?.code||null,lastFetchedAt:this.#last?.fetched_at||null};
  }
  async run(args={},mode='query',options={}){
    let parsed;try{parsed=campusArgs.parse(args);}catch{return {data:campusFailure('CAMPUS_INVALID_DATE')};}
    if(!['query','report','login'].includes(mode))return {data:campusFailure('CAMPUS_QUERY_FAILED')};
    const pending=withHeavyWork(()=>this.#query(parsed,mode,options));
    this.#pendingQueries.add(pending);
    try { return await pending; }
    catch(error){return {data:campusFailure(error.code==='HEAVY_WORK_BUSY'?'CAMPUS_BUSY':error.timedOut?'CAMPUS_WORKER_TIMEOUT':'CAMPUS_QUERY_FAILED',parsed.date)};}
    finally{this.#pendingQueries.delete(pending);}
  }
  async #query(parsed,mode,options) {
      if(options.authorize && !options.authorize())return {data:campusFailure('CAMPUS_OWNER_ONLY',parsed.date)};
      const grant=await this.#collectorGrant();
      if(grant.code!=='OK')return {data:campusFailure(grant.code,parsed.date)};
      if(options.authorize&&!options.authorize())return {data:campusFailure('CAMPUS_OWNER_ONLY',parsed.date)};
      // Only the host-owned morning report can opt into the fixed, longer
      // source budget. It is not a tool argument or a user-selected duration.
      const scheduled=mode==='report'&&options.scheduledMorning===true;
      const result=await this.worker.run({type:'campus',mode,args:parsed,cache_snapshot:true,credentials:grant.credentials,session_state:grant.session_state,request_text:options.requestText,building:options.building,regions:options.regions,
        ...(scheduled?{timeout_profile:'morning'}:{})},async()=>{throw Error('CAMPUS_RPC_DENIED');},async value=>{
        const data=validateCampusData(value.data);
        if(data.ok&&value.session_state)await this.#saveSession(grant,value.session_state,options.authorize||(()=>true));
        const output=path.join(this.home,'.private','campus-output');
        if(mode!=='report'||!data.ok){if(value.artifact_id!==null)throw Error('CAMPUS_SCHEMA_CHANGED');return {data};}
        if(value.render_error===true)return {data:campusFailure('CAMPUS_RENDER_FAILED',data.date)};
        if(typeof value.artifact_id!=='string'||!/^[a-f0-9]{32}$/.test(value.artifact_id))throw Error('CAMPUS_RENDER_FAILED');
        const file=path.join(output,value.artifact_id+'.png');
        if((await fs.stat(file)).size>1_500_000)throw Error('CAMPUS_RENDER_FAILED');
        const buffer=await fs.readFile(file);
        const image=await studyImage(buffer);
        return {data,image};
      });
      this.#last=result.data;return result;
  }
  close(){this.worker.close();}
}
