import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {PythonAgentWorker} from './python-agent.mjs';
import {APP_ROOT} from './runtime-paths.mjs';
import {withHeavyWork} from './heavy-work.mjs';
import {measureSpan,setTraceOperation} from './telemetry.mjs';
const regions=JSON.parse(readFileSync(new URL('../data/weather-video-regions.json',import.meta.url),'utf8')).regions;
const regionAliases=new Map(regions.flatMap(row=>row.aliases.map(alias=>[alias,row])));
export function videoRegion(query){
  const row=regionAliases.get(query.normalize('NFKC').replace(/\s+/gu,''));
  return row?{id:'region:'+row.id,name:row.name,regionId:row.id,bounds:[...row.bounds]}:null;
}
function matchesTarget(data,place){
  if(!place.regionId)return data.region_id===undefined;
  const box=data.view_bounds;
  if(data.region_id!==place.regionId||!Array.isArray(box)||box.length!==4||!box.every(Number.isFinite))return false;
  const [w,s,e,n]=place.bounds;
  return -180<=box[0]&&box[0]<=w&&-85.06<=box[1]&&box[1]<=s&&e<=box[2]&&box[2]<=180&&n<=box[3]&&box[3]<=85.06;
}
const messages={VIDEO_NO_COVERAGE:'该地点不在当前葵花卫星云图覆盖内（主要为东亚及西太平洋）。',VIDEO_SOURCE_STALE:'卫星云图更新时间过旧，暂不发送。',VIDEO_DATA_MISSING:'时间轴或区域数据有缺测，暂时无法生成完整视频。',VIDEO_TIMEOUT:'动态天气视频生成超时，请稍后再试。',VIDEO_ENCODING_FAILED:'视频生成暂不可用。'};
export const videoOperation=layer=>'video.'+({cloud_cover:'cloud_forecast',cloud:'satellite'}[layer]??layer);
export function validVideoTimeline(data,layer,hours=24){
  if(data.forecast_detail!==undefined&&(layer==='cloud'||!['native','sampled'].includes(data.forecast_detail)))return false;
  if(!Number.isSafeInteger(data.start)||!Number.isSafeInteger(data.end)||!Number.isSafeInteger(data.frames))return false;
  const cloud=layer==='cloud';
  if(data.format_version===undefined){
    return hours===24&&data.width===720&&data.height===720&&data.frames===(cloud?13:24)&&data.end-data.start===(cloud?21600:82800);
  }
  const times=data.source_times;
  if(data.format_version!==2||data.width!==1080||data.height!==1080||data.fps!==12||!Array.isArray(times))return false;
  if(cloud?(times.length<2||times.length>37):times.length!==hours)return false;
  if(times[0]!==data.start||times.at(-1)!==data.end||!times.every(t=>Number.isSafeInteger(t)&&t%(cloud?600:3600)===0))return false;
  if(cloud&&(data.end-data.start<=0||data.end-data.start>21600||data.end>data.generated_at+60||data.generated_at-data.end>5400))return false;
  if(!cloud&&(data.start<data.generated_at||data.start-data.generated_at>3600))return false;
  let encoded=1;
  for(let i=1;i<times.length;i++){
    const gap=times[i]-times[i-1];
    if(cloud?gap<=0:gap!==3600)return false;
    encoded+=cloud?(gap===600?4:1):(hours===48?3:6);
  }
  return data.frames===encoded;
}
export class WeatherVideoService{
  #cache=new Map();
  constructor({home=process.env.QQ_BRIDGE_HOME||APP_ROOT,worker,now=Date.now}={}){Object.assign(this,{home,now});this.worker=worker||new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python/weather_video_worker.py'),timeoutMs:180000,idleMs:1000});}
  async get(layer,place,hours=24){
    if(![24,48].includes(hours)||(layer==='cloud'&&hours===48))throw Error('INVALID_VIDEO_WINDOW');
    if(!['cloud','cloud_cover','pm25','precipitation','temperature'].includes(layer))throw Error('INVALID_VIDEO_LAYER');
    const key=[layer,place.id,hours].join(':');
    setTraceOperation(videoOperation(layer));
    return measureSpan('weather_video',()=>withHeavyWork(async()=>{
      const now=this.now();
      for(const [id,entry] of this.#cache)if(entry.expiresAt<=now)this.#cache.delete(id);
      const cached=this.#cache.get(key);
      if(cached){
        this.#cache.delete(key);this.#cache.set(key,cached);
        return measureSpan('video_cache_hit',()=>({text:'',video:{...cached.video,buffer:Buffer.from(cached.video.buffer)}}));
      }
      const target=place.regionId?{region_id:place.regionId}:{latitude:place.latitude,longitude:place.longitude};
      const data=await this.worker.run({type:'weather_video',name:'weather_video',args:{layer,name:place.name,...target,...(hours===48?{hours}: {})}},()=>{throw Error('VIDEO_RPC_DENIED')},v=>v.data);
      if(!data?.ok)throw Object.assign(Error(messages[data?.code]||'动态天气数据源暂不可用，请稍后重试。'),{code:data?.code||'VIDEO_SOURCE_UNAVAILABLE'});
      if(!/^[a-f0-9]{32}$/.test(data.artifact_id)||data.layer!==layer||!Number.isSafeInteger(data.generated_at)||Math.abs(this.now()-data.generated_at*1000)>300000||!validVideoTimeline(data,layer,hours)||!matchesTarget(data,place))throw Error('VIDEO_RESULT_INVALID');
      const file=path.join(this.home,'.private/weather-video',data.artifact_id+'.mp4');
      try{
        const buffer=await measureSpan('video_read_mp4',async()=>{
          const stat=await fs.stat(file);
          if(stat.size>4*1024*1024||stat.size!==data.bytes)throw Error('VIDEO_RESULT_INVALID');
          const bytes=await fs.readFile(file);
          if(bytes.length<32||bytes.toString('ascii',4,8)!=='ftyp')throw Error('VIDEO_RESULT_INVALID');
          return bytes;
        });
        const video={buffer,mimeType:'video/mp4'};
        // Four final MP4s use at most 16 MiB. Keep each tied to its actual
        // forecast window (or satellite observation freshness) and original age.
        const expiresAt=Math.min(data.generated_at*1000+300000,layer==='cloud'?(data.end+5400)*1000:data.start*1000+1);
        // Retry the native grid on the next request after a coarse point fallback.
        if(data.forecast_detail!=='sampled'&&expiresAt>this.now()){
          if(this.#cache.size>=4)this.#cache.delete(this.#cache.keys().next().value);
          this.#cache.set(key,{video,expiresAt});
        }
        return {text:'',video:{...video,buffer:Buffer.from(buffer)}};
      }finally{await fs.unlink(file).catch(()=>{});}
    }));
  }
  close(){this.#cache.clear();this.worker.close();}
}
