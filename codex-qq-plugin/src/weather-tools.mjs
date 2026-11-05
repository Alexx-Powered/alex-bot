import {z} from 'zod';
import {isCityQuery,parseWeatherCommand} from './weather-commands.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {setTraceParameters,recordRequestFailure} from './telemetry.mjs';
const location=z.string().max(60).refine(isCityQuery);
const target=z.string().trim().min(1).max(40).regex(/^[\p{Script=Han}\p{Script=Latin}0-9·（）() _.,'’-]+$/u);
const schemas={
  cloud_video:z.object({city:location,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),pm25_video:z.object({city:location,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),precipitation_video:z.object({city:location,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),temperature_video:z.object({city:location,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),
  weather_image:z.object({city:location,day:z.enum(['today','tomorrow']).optional()}).strict(),air_quality_image:z.object({city:location}).strict(),
  radar_image:z.object({target,source:z.enum(['auto','global']).optional()}).strict(),radar_catalog:z.object({query:z.string().max(40).regex(/^[\p{Script=Han}\p{Script=Latin}0-9·（）() _.,'’-]*$/u)}).strict(),
  local_weather_briefing:z.object({cities:z.array(location).min(1).max(2),renderImage:z.boolean().default(true)}).strict(),
};
export class WeatherToolbox{
  constructor(commands,worker){this.commands=commands;this.worker=worker;}
  async execute(name,args){
    if(!Object.hasOwn(schemas,name))throw new Error('UNKNOWN_WEATHER_TOOL');
    const a=schemas[name].parse(args);
    setTraceParameters({city:a.city??a.target??a.cities?.join(' / '),day:a.day,hours:a.hours});
    if(name==='local_weather_briefing'){const r=await this.commands.briefing(a);return r.image?{...r,text:'',richMedia:false}:r;}
    if(name==='weather_image'&&a.day==='tomorrow'){
      try{const r=await this.commands.briefing({cities:[a.city],day:a.day});return {text:'',image:r.image};}
      catch(error){recordRequestFailure(error);return {text:timeoutNotice(error)||'预报数据暂不可用，请稍后查询。'};}
    }
    if(name.endsWith('_video'))return this.handle((a.hours===48?'发 48h动态':'发 动态')+({cloud_video:'云图',pm25_video:'PM2.5',precipitation_video:'降水',temperature_video:'温度'})[name]+' '+a.city);
    const text=name==='weather_image'?'发 天气 '+a.city:name==='air_quality_image'?'发 雾霾 '+a.city:name==='radar_image'?(a.source==='global'?'发全球雷达 ':'发 雷达 ')+a.target:'雷达目录 '+a.query;
    return this.commands.handle(text);
  }
  async invoke(name,args){
    if(!Object.hasOwn(schemas,name))throw new Error('UNKNOWN_WEATHER_TOOL');
    schemas[name].parse(args);
    try{return await this.worker.run({type:'execute',name,args},(n,a)=>this.execute(n,a));}
    catch(error){if(error.toolExecuted)throw error;if(error.timedOut){recordRequestFailure(error,'worker_total');return {text:timeoutNotice(error)};}return this.execute(name,args);}
  }
  async handle(text){
    const c=parseWeatherCommand(text);if(!c)return null;
    setTraceParameters({city:c.city,layer:c.layer,hours:c.type==='video'&&!c.error?(c.layer==='cloud'?6:c.hours??24):undefined});
    if(c.type==='video')return this.commands.handle(text);
    if(c.type==='help')return this.commands.handle(text);
    if(c.type==='radar-list')return this.invoke('radar_catalog',{query:c.query});
    if(c.type==='radar')return this.invoke('radar_image',{target:c.city,...(c.source?{source:c.source}:{})});
    return this.invoke(c.type==='air'?'air_quality_image':'weather_image',{city:c.city});
  }
  briefing(args){return this.invoke('local_weather_briefing',args);}
}
