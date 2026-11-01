import fs from 'node:fs/promises';
import path from 'node:path';
import {loadImage} from '@napi-rs/canvas';
import {z} from 'zod';
import {PythonAgentWorker} from './python-agent.mjs';
import {APP_ROOT} from './runtime-paths.mjs';
import {RadarService} from './radar.mjs';

const source='https://www.rainviewer.com/';
const schema=z.object({ok:z.literal(true),artifact_id:z.string().regex(/^[a-f0-9]{32}$/),name:z.string().min(1).max(80),covered:z.boolean(),issued_at:z.string().datetime({offset:true}),source:z.literal(source)}).strict();
const messages={GLOBAL_RADAR_LOCATION_AMBIGUOUS:'地名有重名，请补充国家或省市',GLOBAL_RADAR_LOCATION_NOT_FOUND:'全球雷达未找到该地点，请使用城市或国家名称',GLOBAL_RADAR_LOCATION_INVALID:'请提供有效的城市、国家或地区名',GLOBAL_RADAR_STALE:'全球雷达数据已过期，暂不发送旧图',GLOBAL_RADAR_TIMEOUT:'全球雷达数据请求超时（单次10秒时限），请稍后重试'};
export class GlobalRadarService{
  constructor({home=process.env.QQ_BRIDGE_HOME||APP_ROOT,worker,now=Date.now}={}){
    Object.assign(this,{home,now});this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python/global_radar_worker.py'),timeoutMs:90000});
  }
  async get(target){
    if(typeof target!=='string'||target.length>60)throw Object.assign(Error('GLOBAL_RADAR_LOCATION_INVALID'),{code:'GLOBAL_RADAR_LOCATION_INVALID'});
    const result=await this.worker.run({type:'global_radar',name:'global_radar_image',args:{target}},async()=>{throw Error('GLOBAL_RADAR_RPC_DENIED');},v=>v.data);
    if(result?.ok!==true){const code=Object.hasOwn(messages,result?.code)?result.code:'GLOBAL_RADAR_SOURCE_UNAVAILABLE';throw Object.assign(Error(messages[code]||'全球雷达数据暂不可用，请稍后重试'),{code});}
    const data=schema.parse(result);const age=this.now()-Date.parse(data.issued_at);
    if(age< -300000||age>3600000)throw Object.assign(Error(messages.GLOBAL_RADAR_STALE),{code:'GLOBAL_RADAR_STALE'});
    const file=path.join(this.home,'.private/global-radar',data.artifact_id+'.png');
    try{
      const stat=await fs.stat(file);if(stat.size>4500000)throw Error('GLOBAL_RADAR_IMAGE_INVALID');
      const buffer=await fs.readFile(file);if(!buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('GLOBAL_RADAR_IMAGE_INVALID');
      const image=await loadImage(buffer);if(image.width!==1080||image.height!==1370)throw Error('GLOBAL_RADAR_IMAGE_INVALID');
      return {buffer,mimeType:'image/png',global:true,issuedAt:data.issued_at,
        caption:`${data.name} · 全球雷达拼图${data.covered?'':'\n目标位置暂无有效雷达覆盖，图中灰纹为缺测'}\n来源：RainViewer ${source}`};
    }finally{await fs.unlink(file).catch(()=>{});}
  }
  close(){this.worker.close();}
}

export class RadarRouter{
  constructor({home,domestic=new RadarService(),global=new GlobalRadarService({home})}={}){Object.assign(this,{domestic,global});}
  async get(target,{source='auto'}={}){
    if(!['auto','global'].includes(source))throw Error('INVALID_RADAR_SOURCE');
    if(source==='global'||/^(全球|世界|global|world)$/iu.test(target))return this.global.get(target);
    try{return await this.domestic.get(target);}catch(error){
      // Ambiguous stations need user disambiguation, never a guessed global center.
      if(['AMBIGUOUS_TARGET','LOCATION_AMBIGUOUS'].includes(error.code))throw error;
      if(!['NOT_FOUND','RADAR_TARGET_NOT_FOUND','TARGET_NOT_FOUND','RADAR_STALE','RADAR_SOURCE_CHANGED','RADAR_SOURCE_UNAVAILABLE','RADAR_TIMEOUT','RADAR_HTTP_ERROR','RADAR_NETWORK_ERROR','RADAR_UNAVAILABLE'].includes(error.code))throw error;
      return this.global.get(target);
    }
  }
  list(...args){return this.domestic.list(...args);}
  close(){this.global.close();}
}
