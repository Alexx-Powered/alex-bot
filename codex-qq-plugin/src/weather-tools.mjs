import {z} from 'zod';
import {isCityQuery,parseWeatherCommand} from './weather-commands.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
const location=z.string().max(60).refine(isCityQuery);
const target=z.string().trim().min(1).max(40).regex(/^[\p{Script=Han}\p{Script=Latin}0-9·（）() _.,'’-]+$/u);
const schemas={
  weather_image:z.object({city:location,day:z.enum(['today','tomorrow']).optional()}).strict(),air_quality_image:z.object({city:location}).strict(),
  radar_image:z.object({target,source:z.enum(['auto','global']).optional()}).strict(),radar_catalog:z.object({query:z.string().max(40).regex(/^[\p{Script=Han}\p{Script=Latin}0-9·（）() _.,'’-]*$/u)}).strict(),
  local_weather_briefing:z.object({cities:z.array(location).min(1).max(2),renderImage:z.boolean().default(true)}).strict(),
};
export class WeatherToolbox{
  constructor(commands,worker){this.commands=commands;this.worker=worker;}
  async execute(name,args){
    if(!Object.hasOwn(schemas,name))throw new Error('UNKNOWN_WEATHER_TOOL');
    const a=schemas[name].parse(args);
    if(name==='local_weather_briefing')return this.commands.briefing(a);
    if(name==='weather_image'&&a.day==='tomorrow'){
      try{const r=await this.commands.briefing({cities:[a.city],day:a.day});return {text:r.timeoutNotice||'',image:r.image,...(r.timeoutNotice?{richMedia:true}:{})};}
      catch(error){return {text:timeoutNotice(error)||'预报数据暂不可用，请稍后查询。'};}
    }
    const text=name==='weather_image'?'发 天气 '+a.city:name==='air_quality_image'?'发 雾霾 '+a.city:name==='radar_image'?(a.source==='global'?'发全球雷达 ':'发 雷达 ')+a.target:'雷达目录 '+a.query;
    return this.commands.handle(text);
  }
  async invoke(name,args){
    if(!Object.hasOwn(schemas,name))throw new Error('UNKNOWN_WEATHER_TOOL');
    schemas[name].parse(args);
    try{return await this.worker.run({type:'execute',name,args},(n,a)=>this.execute(n,a));}
    catch(error){if(error.toolExecuted)throw error;if(error.timedOut)return {text:timeoutNotice(error)};return this.execute(name,args);}
  }
  async handle(text){
    const c=parseWeatherCommand(text);if(!c)return null;
    if(c.type==='help')return this.commands.handle(text);
    if(c.type==='radar-list')return this.invoke('radar_catalog',{query:c.query});
    if(c.type==='radar')return this.invoke('radar_image',{target:c.city,...(c.source?{source:c.source}:{})});
    return this.invoke(c.type==='air'?'air_quality_image':'weather_image',{city:c.city});
  }
  briefing(args){return this.invoke('local_weather_briefing',args);}
}
