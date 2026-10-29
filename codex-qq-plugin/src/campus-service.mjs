import fs from 'node:fs/promises';
import path from 'node:path';
import {PythonAgentWorker} from './python-agent.mjs';
import {atomicJson} from './storage.mjs';
import {studyImage} from './study-briefing.mjs';
import {z} from 'zod';
import {fullAccess} from './access-policy.mjs';

const source='https://app.buaa.edu.cn/site/classRoomQuery/index';
const semantics='接口标空闲则为空闲，其余课节为有课；保留接口给出的节次。';
const codes=['OK','CAMPUS_NOT_CONFIGURED','CAMPUS_DISABLED','CAMPUS_CONFIG_UNAVAILABLE','CAMPUS_BUSY',
  'CAMPUS_INVALID_DATE','CAMPUS_AUTH_FAILED','CAMPUS_INTERACTION_REQUIRED','CAMPUS_NETWORK_ERROR',
  'CAMPUS_SCHEMA_CHANGED','CAMPUS_BROWSER_UNAVAILABLE','CAMPUS_QUERY_FAILED','CAMPUS_RENDER_FAILED','CAMPUS_OWNER_ONLY'];
export const campusArgs=z.object({date:z.string().regex(/^(?:\d{4}-\d{2}-\d{2})?$/).default('')}).strict();
const regionList=z.array(z.string().min(1).max(32).regex(/^[\p{L}\p{N}_（）()· .-]+$/u)).max(12);
export const recommendationArgs=campusArgs.extend({session:z.enum(['now','morning','afternoon','evening']).default('now'),
  limit:z.number().int().min(1).max(12).default(8),exclude_room:z.string().max(64).regex(/^[\p{L}\p{N}_（）()· .-]*$/u).default(''),building:z.string().min(1).max(64).regex(/^[\p{L}\p{N}_（）()· .-]+$/u).default('三号楼'),regions:regionList.default([])}).strict();
const recommendationSchema=z.object({schema_version:z.literal('buaa-recommendations.v1'),ok:z.boolean(),code:z.string().regex(/^(?:OK|CAMPUS_[A-Z_]+)$/),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),now:z.string().datetime({offset:true}),fetched_at:z.union([z.literal(''),z.string().datetime({offset:true})]),
  regions:regionList.default([]),missing_regions:regionList.default([]),building:z.string().min(1).max(64).default('三号楼'),session:z.enum(['','上午','下午','晚上']),message:z.string().max(3000),candidates:z.array(z.object({room:z.string().min(1).max(64).regex(/^[\p{L}\p{N}_（）()· .-]+$/u),building:z.string().min(1).max(64).default('三号楼'),region:z.string().max(32).default(''),
    small:z.boolean(),tier:z.number().int().min(1).max(6),start_period:z.number().int().min(1).max(14),end_period:z.number().int().min(1).max(14),
    usable_from:z.string().regex(/^\d{2}:\d{2}$/),usable_until:z.string().regex(/^\d{2}:\d{2}$/),available_now:z.boolean(),
    complete_remaining:z.boolean(),period5_busy:z.boolean(),full_afternoon:z.boolean(),just_released:z.boolean().default(false),release_pending:z.boolean().default(false)}).strict()).max(12)}).strict();
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
  #busy=false;#last=null;#cache=new Map();#cacheLoaded=false;
  constructor({home,configStore,worker,now=()=>Date.now()}){
    Object.assign(this,{home,configStore,now});
    this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(home,'python','campus_worker.py'),timeoutMs:210000,maxLineBytes:262144});
  }
  async #loadCache(){
    if(this.#cacheLoaded)return;
    this.#cacheLoaded=true;
    const folder=path.join(this.home,'.private','campus-output');
    try{
      const file=path.join(folder,'memory.json');
      if((await fs.stat(file)).size>2_000_000)return;
      const saved=JSON.parse(await fs.readFile(file,'utf8'));
      if(saved.version!==1||!Array.isArray(saved.snapshots)||saved.snapshots.length>8)return;
      for(const value of saved.snapshots){const data=validateCampusData(value);if(data.ok&&!this.#cache.has(data.date))this.#cache.set(data.date,data);}
    }catch{
      try{const file=path.join(folder,'latest.json');if((await fs.stat(file)).size>262144)return;
        const data=validateCampusData(JSON.parse(await fs.readFile(file,'utf8')));if(data.ok&&!this.#cache.has(data.date))this.#cache.set(data.date,data);
      }catch{ /* An absent/unreadable cache is never fabricated. */ }
    }
  }
  async #remember(data){
    await this.#loadCache();
    this.#cache.delete(data.date);this.#cache.set(data.date,structuredClone(data));
    while(this.#cache.size>8)this.#cache.delete(this.#cache.keys().next().value);
    await atomicJson(path.join(this.home,'.private','campus-output','memory.json'),{version:1,snapshots:[...this.#cache.values()]});
  }
  async status(){
    let status;try{status=await this.configStore.status();}catch{status={enabled:false,configured:false,code:'CAMPUS_CONFIG_UNAVAILABLE'};}
    return {...status,busy:this.#busy,lastCode:this.#last?.code||null,lastFetchedAt:this.#last?.fetched_at||null};
  }
  async run(args={},mode='query',options={}){
    let parsed;try{parsed=campusArgs.parse(args);}catch{return {data:campusFailure('CAMPUS_INVALID_DATE')};}
    if(!['query','report','login'].includes(mode))return {data:campusFailure('CAMPUS_QUERY_FAILED')};
    if(this.#busy)return {data:campusFailure('CAMPUS_BUSY',parsed.date)};
    this.#busy=true;
    try{
      let credentials;try{credentials=await this.configStore.read();}catch{return {data:campusFailure('CAMPUS_CONFIG_UNAVAILABLE',parsed.date)};}
      if(!credentials.username||!credentials.password)return {data:campusFailure('CAMPUS_NOT_CONFIGURED',parsed.date)};
      if(!credentials.enabled)return {data:campusFailure('CAMPUS_DISABLED',parsed.date)};
      const result=await this.worker.run({type:'campus',mode,args:parsed,credentials,request_text:options.requestText,building:options.building,regions:options.regions},async()=>{throw Error('CAMPUS_RPC_DENIED');},async value=>{
        const data=validateCampusData(value.data);
        const output=path.join(this.home,'.private','campus-output');
        if(data.ok){await fs.mkdir(output,{recursive:true});await atomicJson(path.join(output,'latest.json'),data);await this.#remember(data);}
        if(mode!=='report'||!data.ok){if(value.artifact_id!==null)throw Error('CAMPUS_SCHEMA_CHANGED');return {data};}
        if(value.render_error===true)return {data:campusFailure('CAMPUS_RENDER_FAILED',data.date)};
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
  async resolveIntent(text,requested='auto',origin='query'){
    if(!text)return {view:requested==='auto'?(origin==='query'?'full':'compact'):requested,session:'now'};
    return this.worker.run({type:'campus',mode:'intent',args:{text,requested,origin}},async()=>{throw Error('CAMPUS_RPC_DENIED');},value=>z.object({view:z.enum(['full','compact']),session:z.enum(['now','morning','afternoon','evening'])}).strict().parse(value.intent));
  }
  async recoverIgnored(text,context){
    if(!fullAccess(context))return null;
    const recovered=await this.worker.run({type:'campus',mode:'recognize',args:{text},now:new Date(this.now()).toISOString()},async()=>{throw Error('CAMPUS_RPC_DENIED');},value=>z.object({recognized:z.boolean(),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()}).parse(value));
    if(!recovered.recognized||!fullAccess(context))return null;
    const intent=await this.resolveIntent(text,'auto','query');
    console.warn('[campus] RECOVERED_IGNORED_QUERY');
    return intent.view==='full'?this.execute({date:recovered.date,view:'full'},context,text):this.recommend({date:recovered.date,session:intent.session},context,text);
  }
  async execute(args,context,requestText){
    if(!fullAccess(context))return {text:JSON.stringify(campusFailure('CAMPUS_OWNER_ONLY')),requiredAccess:'chat'};
    const {building,regions,view,...queryArgs}=args||{};
    const intent=await this.resolveIntent(requestText,view||'auto','query');
    if(!fullAccess(context))return {cancelled:true};
    const compact=intent.view==='compact';
    if(context?.progress&&await context.progress(compact?'campus-fetch-current':'campus-fetch')!==true)return {cancelled:true};
    if(!fullAccess(context))return {cancelled:true};
    const result=await this.run(queryArgs,compact?'query':'report',{requestText,building,regions});
    if(!fullAccess(context))return {text:JSON.stringify(campusFailure('CAMPUS_OWNER_ONLY')),requiredAccess:'chat'};
    if(compact&&result.data.ok)return this.recommend({date:result.data.date,session:intent.session,...(building?{building}:{}),...(regions?{regions}:{})},context,requestText);
    return result.image?{image:result.image,text:'',campusData:result.data,requiredAccess:'white'}:{text:JSON.stringify(result.data),requiredAccess:'white'};
  }
  async recommend(args,context,requestText){
    if(!fullAccess(context))return {text:'当前会话未开放教室推荐。',requiredAccess:'chat'};
    let parsed;try{parsed=recommendationArgs.parse(args);}catch(error){
      console.warn('[campus-recommend] INVALID_ARGUMENTS '+JSON.stringify((error.issues||[]).map(issue=>({field:issue.path.filter(part=>['date','session','limit','exclude_room','building','regions'].includes(part)),code:issue.code}))));
      return {text:'教室推荐参数暂时解析失败，请稍后重试。本次没有返回教室结果。',requiredAccess:'white'};
    }
    const status=await this.configStore.status();
    if(!status.configured||!status.enabled)return {text:'校园查询未启用，请先在本机设置页启用。',requiredAccess:'white'};
    if(this.#busy)return {text:'正在抓取教室数据，请等本次查询完成后再问推荐。',requiredAccess:'white'};
    const intent=await this.resolveIntent(requestText,'auto','recommend');
    if(!fullAccess(context))return null;
    if(intent.view==='full')return this.execute({date:parsed.date,building:parsed.building,regions:parsed.regions,view:'full'},context,requestText);
    if(parsed.session==='now')parsed.session=intent.session;
    await this.#loadCache();
    const now=new Date(this.now()).toISOString();
    const day=parsed.date||new Date(this.now()+8*3600000).toISOString().slice(0,10);
    const snapshot=this.#cache.get(day)||null;
    const report=await this.worker.run({type:'campus',mode:'recommend',args:parsed,now,snapshot,request_text:requestText},async()=>{throw Error('CAMPUS_RPC_DENIED');},value=>recommendationSchema.parse(value.recommendation));
    if(!fullAccess(context))return null;
    return {text:report.message,campusRecommendation:report,requiredAccess:'white'};
  }
  async renderRecommendation(report,explanation,context){
    if(!fullAccess(context))return null;
    report=recommendationSchema.parse(report);
    const id=await this.worker.run({type:'campus',mode:'recommend_render',report,explanation:typeof explanation==='string'?explanation.slice(0,180):''},async()=>{throw Error('CAMPUS_RPC_DENIED');},value=>{
      if(!/^[a-f0-9]{32}$/.test(value.artifact_id||''))throw Error('CAMPUS_RENDER_FAILED');return value.artifact_id;
    });
    if(!fullAccess(context))return null;
    const file=path.join(this.home,'.private','campus-output',id+'.png');
    if((await fs.stat(file)).size>1_500_000)throw Error('CAMPUS_RENDER_FAILED');
    const image=await studyImage({idempotencyKey:'study:'+id.repeat(2),pngBase64:(await fs.readFile(file)).toString('base64')});
    return fullAccess(context)?{image,text:'',requiredAccess:'white'}:null;
  }
  async handle(text,context){const args=parseCampusCommand(text);return args?this.execute(args,context):null;}
  close(){this.worker.close();}
}
