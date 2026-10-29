import fs from 'node:fs/promises';
import path from 'node:path';
import {PythonAgentWorker} from './python-agent.mjs';
import {atomicJson} from './storage.mjs';
import {studyImage} from './study-briefing.mjs';
import {z} from 'zod';

const source='https://app.buaa.edu.cn/site/classRoomQuery/index';
const semantics='接口标空闲则为空闲，其余课节为有课；保留接口给出的节次。';
const codes=['OK','CAMPUS_NOT_CONFIGURED','CAMPUS_DISABLED','CAMPUS_CONFIG_UNAVAILABLE','CAMPUS_BUSY',
  'CAMPUS_INVALID_DATE','CAMPUS_AUTH_FAILED','CAMPUS_INTERACTION_REQUIRED','CAMPUS_NETWORK_ERROR',
  'CAMPUS_SCHEMA_CHANGED','CAMPUS_BROWSER_UNAVAILABLE','CAMPUS_QUERY_FAILED','CAMPUS_RENDER_FAILED','CAMPUS_OWNER_ONLY'];
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
export const parseCampusCommand=text=>{
  const match=typeof text==='string'&&/^(?:查空教室|三号楼简报)(?:\s+(\d{4}-\d{2}-\d{2}))?[？?。]?$/.exec(text.trim());
  return match?{date:match[1]||''}:null;
};

export class CampusService{
  #busy=false;#last=null;
  constructor({home,configStore,worker}){
    Object.assign(this,{home,configStore});
    this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(home,'python','campus_worker.py'),timeoutMs:210000,maxLineBytes:262144});
  }
  async status(){
    let status;try{status=await this.configStore.status();}catch{status={enabled:false,configured:false,code:'CAMPUS_CONFIG_UNAVAILABLE'};}
    return {...status,busy:this.#busy,lastCode:this.#last?.code||null,lastFetchedAt:this.#last?.fetched_at||null};
  }
  async run(args={},mode='query'){
    let parsed;try{parsed=campusArgs.parse(args);}catch{return {data:campusFailure('CAMPUS_INVALID_DATE')};}
    if(!['query','report','login'].includes(mode))return {data:campusFailure('CAMPUS_QUERY_FAILED')};
    if(this.#busy)return {data:campusFailure('CAMPUS_BUSY',parsed.date)};
    this.#busy=true;
    try{
      let credentials;try{credentials=await this.configStore.read();}catch{return {data:campusFailure('CAMPUS_CONFIG_UNAVAILABLE',parsed.date)};}
      if(!credentials.username||!credentials.password)return {data:campusFailure('CAMPUS_NOT_CONFIGURED',parsed.date)};
      if(!credentials.enabled)return {data:campusFailure('CAMPUS_DISABLED',parsed.date)};
      const result=await this.worker.run({type:'campus',mode,args:parsed,credentials},async()=>{throw Error('CAMPUS_RPC_DENIED');},async value=>{
        const data=validateCampusData(value.data);
        const output=path.join(this.home,'.private','campus-output');
        if(data.ok){await fs.mkdir(output,{recursive:true});await atomicJson(path.join(output,'latest.json'),data);}
        if(mode!=='report'||!data.ok){if(value.artifact_id!==null)throw Error('CAMPUS_SCHEMA_CHANGED');return {data};}
        if(typeof value.artifact_id!=='string'||!/^[a-f0-9]{32}$/.test(value.artifact_id))throw Error('CAMPUS_RENDER_FAILED');
        const file=path.join(output,value.artifact_id+'.png');
        if((await fs.stat(file)).size>1_500_000)throw Error('CAMPUS_RENDER_FAILED');
        const buffer=await fs.readFile(file);
        const image=await studyImage({idempotencyKey:'study:'+value.artifact_id.repeat(2),pngBase64:buffer.toString('base64')});
        return {data,image};
      });
      this.#last=result.data;return result;
    }catch{return {data:campusFailure('CAMPUS_QUERY_FAILED',parsed.date)};}
    finally{this.#busy=false;}
  }
  async execute(args,context){
    if(context?.scope!=='c2c')return {text:JSON.stringify(campusFailure('CAMPUS_OWNER_ONLY'))};
    const result=await this.run(args,'report');
    return result.image?{image:result.image,text:'',campusData:result.data}:{text:JSON.stringify(result.data)};
  }
  async handle(text,context){const args=parseCampusCommand(text);return args?this.execute(args,context):null;}
  close(){this.worker.close();}
}
