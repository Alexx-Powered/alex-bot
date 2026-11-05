import fs from 'node:fs/promises';
import path from 'node:path';
import {loadImage} from '@napi-rs/canvas';
import {z} from 'zod';
import {PythonAgentWorker} from './python-agent.mjs';
import {APP_ROOT} from './runtime-paths.mjs';
import {fullAccess,restrictedReply} from './access-policy.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {recordRequestFailure,setTraceParameters} from './telemetry.mjs';
import {renderProviderStatusImage} from './provider-status-image.mjs';

const aiProviders=['openai','deepseek','gemini','claude','kimi'];
const sources=Object.freeze({openai:'https://status.openai.com/',deepseek:'https://status.deepseek.com/',gemini:'https://aistudio.google.com/status',
  claude:'https://status.claude.com/',kimi:'https://status.moonshot.cn/',liang:'https://liang.itsuyo.top/'});
const names=Object.freeze({...Object.fromEntries(aiProviders.map(p=>[p+'_service_status',p])),liang_status:'liang'});
const argsSchema=z.object({}).strict();
const providerArgs=z.object({provider:z.enum(aiProviders)}).strict();
const resultSchema=z.object({service:z.enum(['deepseek','liang']),source:z.enum(Object.values(sources)),
  checked_at:z.string().datetime({offset:true}),ok:z.boolean(),artifact_id:z.string().regex(/^[a-f0-9]{32}$/).nullable(),text:z.string().min(1).max(3900)}).strict();
const cleanText=n=>z.string().max(n).refine(v=>! /[@<>\x00-\x08\x0b-\x1f\x7f]/u.test(v));
const detail=z.object({title:cleanText(200),phase:cleanText(40),affected:cleanText(500),symptom:cleanText(600),progress:cleanText(600),
  updatedAt:z.string().datetime({offset:true}).nullable(),eta:cleanText(200)}).strict();
const reportSchema=z.object({provider:z.enum(aiProviders),title:cleanText(30),source:z.enum(Object.values(sources)),
  checkedAt:z.string().datetime({offset:true}),mode:z.literal('snapshot'),overall:z.enum(['operational','incident','unknown']),
  rows:z.array(z.object({label:cleanText(100),sourceName:cleanText(100),state:z.enum(['operational','degraded_performance','partial_outage','major_outage','under_maintenance','unknown','affected'])}).strict()).max(100),
  incidents:z.array(detail).max(100),incidentCount:z.number().int().min(0).max(100),notice:detail.optional(),
  listLabel:cleanText(60),statusTitle:cleanText(30),summary:cleanText(150),scopeNote:cleanText(150).optional(),sourceLabel:cleanText(40).optional()}).strict();
const providerResult=z.object({service:z.enum(aiProviders),source:z.enum(Object.values(sources)),checked_at:z.string().datetime({offset:true}),
  report:reportSchema,text:cleanText(3900)}).strict();

export function parseStatusCommand(text){
  if(typeof text!=='string')return null;
  const value=text.trim().replace(/[？?。！!~～]+$/u,'').trim();
  // Core removes one group wake prefix; private chat may retain it. Match
  // both forms without changing group admission or ordinary chat wake rules.
  for(const query of new Set([value,value.replace(/^(?:梁圣|梁祖|梁嗨|小难梁|大肥鱼)\s+/u,'')])){
    const match=query.match(/^(?:\/?(?:查(?:询)?(?:一下)?|发)?\s*)(openai|deepseek|深度求索|ds|大肥鱼|gemini|claude|anthropic|克劳德|kimi|月之暗面)\s*(?:服务|运行)?\s*(?:状态|status)$/iu)
      ||query.match(/^\/status\s+(openai|deepseek|ds|gemini|claude|kimi)$/iu);
    if(match){const p=match[1].toLowerCase();return ({ds:'deepseek',深度求索:'deepseek',大肥鱼:'deepseek',anthropic:'claude',克劳德:'claude',月之暗面:'kimi'}[p]||p)+'_service_status';}
    if(/^(?:\/(?:ds状态|deepseek状态)|(?:查(?:询)?(?:一下)?\s*)?(?:deepseek|深度求索|ds|大肥鱼)\s*(?:服务|运行)?状态)$/iu.test(query))return 'deepseek_service_status';
    if(/^(?:deepseek|深度求索|ds|大肥鱼)\s*(?:(?:现在|今天|目前)\s*)?(?:还\s*(?:活着|健在)(?:吗|么|没(?:有)?)|(?:还\s*)?(?:正常|能用)(?:吗|么|不)|(?:是不是|是否|又)?\s*(?:挂了|崩了|炸了|死了)(?:吗|么|没(?:有)?)?|恢复了(?:吗|么|没(?:有)?))$/iu.test(query))return 'deepseek_service_status';
  }
  if(/^(?:\/梁状态|(?:查(?:询)?(?:一下)?\s*)?滑动变[阻祖]器\s*(?:实时)?状态)$/u.test(value))return 'liang_status';
  return null;
}

export class PublicStatusService{
  constructor({home,worker}={}){
    this.home=home;
    this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python','public_status_worker.py'),timeoutMs:65000,idleMs:90_000});
  }
  async handle(text,context){const name=parseStatusCommand(text);return name?this.execute(name,{},context):null;}
  async execute(name,args,context){
    if(name==='ai_service_status'?!providerArgs.safeParse(args).success:(!Object.hasOwn(names,name)||!argsSchema.safeParse(args).success))throw Error('STATUS_TOOL_DENIED');
    if(!fullAccess(context,'status'))return {text:restrictedReply(context),requiredAccess:'chat'};
    const service=name==='ai_service_status'?args.provider:names[name];
    setTraceParameters({provider:service});
    if(aiProviders.includes(service))return this.executeProvider(service,context);
    try{
      const response=await this.worker.run({type:'public_status',name,args:{}},async()=>{throw Error('STATUS_RPC_DENIED');},async result=>{
        const value=resultSchema.parse(result.data);
        if(value.service!==service||value.source!==sources[service]||value.ok!==(value.artifact_id!==null)||!value.text.endsWith('来源：'+value.source)||/[@<>\x00-\x08\x0b-\x1f\x7f]/u.test(value.text))throw Error('STATUS_RESULT_INVALID');
        const age=Date.now()-Date.parse(value.checked_at);
        if(age< -60000||age>120000)throw Error('STATUS_RESULT_STALE');
        if(!value.ok){recordRequestFailure({code:'STATUS_SOURCE_UNAVAILABLE'},'worker_total');return {text:value.text,requiredAccess:'white',requiredFeature:'status'};}
        const file=path.join(this.home,'.private','public-status',value.artifact_id+'.png');
        try{
          if((await fs.stat(file)).size>1500000)throw Error('STATUS_IMAGE_INVALID');
          const buffer=await fs.readFile(file);
          if(buffer.length<45||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('STATUS_IMAGE_INVALID');
          const image=await loadImage(buffer);
          if(image.width!==1080||image.height<200||image.height>7000)throw Error('STATUS_IMAGE_INVALID');
          return {text:value.text,image:{buffer,mimeType:'image/png'},richMedia:true,requiredAccess:'white',requiredFeature:'status'};
        }finally{await fs.unlink(file).catch(()=>{});}
      });
      return fullAccess(context,'status')?response:{text:restrictedReply(context),requiredAccess:'chat'};
    }catch(error){recordRequestFailure(error,'worker_total');return {text:(timeoutNotice(error,{stage:service==='deepseek'?'DeepSeek状态查询':'滑动变祖器状态查询',seconds:65})||'这次状态查询没能完成，稍后再试一下')+'\n来源：'+sources[service],requiredAccess:'white',requiredFeature:'status'};}
  }
  async executeProvider(provider,context){
    if(!aiProviders.includes(provider))throw Error('STATUS_TOOL_DENIED');
    if(!fullAccess(context,'status'))return {text:restrictedReply(context),requiredAccess:'chat'};
    try{
      const result=await this.worker.run({type:'public_status',name:'ai_service_status',args:{provider}},async()=>{throw Error('STATUS_RPC_DENIED');},async result=>{
        const value=providerResult.parse(result.data),report=value.report;
        const age=Date.now()-Date.parse(value.checked_at);
        if(value.service!==provider||value.source!==sources[provider]||report.provider!==provider||report.source!==value.source
          ||report.checkedAt!==value.checked_at||age< -60000||age>120000||!value.text.endsWith('来源：'+value.source))throw Error('STATUS_RESULT_INVALID');
        if(!fullAccess(context,'status'))return {text:restrictedReply(context),requiredAccess:'chat'};
        const rendered=await renderProviderStatusImage(report);
        if(rendered.buffer.length>1500000)throw Error('STATUS_IMAGE_INVALID');
        return {text:value.text,image:{buffer:rendered.buffer,mimeType:rendered.mimeType},richMedia:true,requiredAccess:'white',requiredFeature:'status'};
      });
      return fullAccess(context,'status')?result:{text:restrictedReply(context),requiredAccess:'chat'};
    }catch(error){
      recordRequestFailure(error);
      return {text:(timeoutNotice(error,{stage:provider+' 服务状态查询',seconds:65})||'这次状态查询未能完成，暂不能确认服务是否正常。')+'\n来源：'+sources[provider],requiredAccess:'white',requiredFeature:'status'};
    }
  }
  close(){this.worker.close();}
}
