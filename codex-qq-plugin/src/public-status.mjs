import fs from 'node:fs/promises';
import path from 'node:path';
import {loadImage} from '@napi-rs/canvas';
import {z} from 'zod';
import {PythonAgentWorker} from './python-agent.mjs';
import {APP_ROOT} from './runtime-paths.mjs';
import {fullAccess,RESTRICTED_REPLY} from './access-policy.mjs';
import {timeoutNotice} from './timeout-notice.mjs';

const sources=Object.freeze({deepseek:'https://status.deepseek.com/',liang:'https://liang.itsuyo.top/'});
const names=Object.freeze({deepseek_service_status:'deepseek',liang_status:'liang'});
const argsSchema=z.object({}).strict();
const resultSchema=z.object({service:z.enum(['deepseek','liang']),source:z.enum(Object.values(sources)),
  checked_at:z.string().datetime({offset:true}),ok:z.boolean(),artifact_id:z.string().regex(/^[a-f0-9]{32}$/).nullable(),text:z.string().min(1).max(3900)}).strict();

export function parseStatusCommand(text){
  if(typeof text!=='string')return null;
  const value=text.trim().replace(/[？?。！!~～]+$/u,'').trim();
  // Core removes one group wake prefix; private chat may retain it. Match
  // both forms without changing group admission or ordinary chat wake rules.
  for(const query of new Set([value,value.replace(/^(?:梁圣|梁祖|梁嗨|小难梁|大肥鱼)\s+/u,'')])){
    if(/^(?:\/(?:ds状态|deepseek状态)|(?:查(?:询)?(?:一下)?\s*)?(?:deepseek|深度求索|ds|大肥鱼)\s*(?:服务|运行)?状态)$/iu.test(query))return 'deepseek_service_status';
    if(/^(?:deepseek|深度求索|ds|大肥鱼)\s*(?:(?:现在|今天|目前)\s*)?(?:还\s*(?:活着|健在)(?:吗|么|没(?:有)?)|(?:还\s*)?(?:正常|能用)(?:吗|么|不)|(?:是不是|是否|又)?\s*(?:挂了|崩了|炸了|死了)(?:吗|么|没(?:有)?)?|恢复了(?:吗|么|没(?:有)?))$/iu.test(query))return 'deepseek_service_status';
  }
  if(/^(?:\/梁状态|(?:查(?:询)?(?:一下)?\s*)?滑动变[阻祖]器\s*(?:实时)?状态)$/u.test(value))return 'liang_status';
  return null;
}

export class PublicStatusService{
  constructor({home,worker}={}){
    this.home=home;
    this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python','public_status_worker.py'),timeoutMs:65000});
  }
  async handle(text,context){const name=parseStatusCommand(text);return name?this.execute(name,{},context):null;}
  async execute(name,args,context){
    if(!Object.hasOwn(names,name)||!argsSchema.safeParse(args).success)throw Error('STATUS_TOOL_DENIED');
    if(!fullAccess(context))return {text:RESTRICTED_REPLY,requiredAccess:'chat'};
    const service=names[name];
    try{
      const response=await this.worker.run({type:'public_status',name,args:{}},async()=>{throw Error('STATUS_RPC_DENIED');},async result=>{
        const value=resultSchema.parse(result.data);
        if(value.service!==service||value.source!==sources[service]||value.ok!==(value.artifact_id!==null)||!value.text.endsWith('来源：'+value.source)||/[@<>\x00-\x08\x0b-\x1f\x7f]/u.test(value.text))throw Error('STATUS_RESULT_INVALID');
        const age=Date.now()-Date.parse(value.checked_at);
        if(age< -60000||age>120000)throw Error('STATUS_RESULT_STALE');
        if(!value.ok)return {text:value.text,requiredAccess:'white'};
        const file=path.join(this.home,'.private','public-status',value.artifact_id+'.png');
        try{
          if((await fs.stat(file)).size>1500000)throw Error('STATUS_IMAGE_INVALID');
          const buffer=await fs.readFile(file);
          if(buffer.length<45||!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('STATUS_IMAGE_INVALID');
          const image=await loadImage(buffer);
          if(image.width!==1080||image.height<200||image.height>7000)throw Error('STATUS_IMAGE_INVALID');
          return {text:value.text,image:{buffer,mimeType:'image/png'},richMedia:true,requiredAccess:'white'};
        }finally{await fs.unlink(file).catch(()=>{});}
      });
      return fullAccess(context)?response:{text:RESTRICTED_REPLY,requiredAccess:'chat'};
    }catch(error){return {text:(timeoutNotice(error,{stage:service==='deepseek'?'DeepSeek状态查询':'滑动变祖器状态查询',seconds:65})||'这次状态查询没能完成，稍后再试一下')+'\n来源：'+sources[service],requiredAccess:'white'};}
  }
  close(){this.worker.close();}
}
