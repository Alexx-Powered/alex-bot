import {z} from 'zod';
import {isCityQuery,parseWeatherCommand} from './weather-commands.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {setTraceParameters,recordRequestFailure} from './telemetry.mjs';
const location=z.string().max(60).refine(isCityQuery);
const target=z.string().trim().min(1).max(40).regex(/^[\p{Script=Han}\p{Script=Latin}0-9·（）() _.,'’-]+$/u);
const day=z.union([z.enum(['today','tomorrow']),z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional();
const schemas={
  satellite_video:z.object({city:location}).strict(),
  cloud_video:z.object({city:location,day,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),pm25_video:z.object({city:location,day,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),precipitation_video:z.object({city:location,day,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),temperature_video:z.object({city:location,day,hours:z.union([z.literal(24),z.literal(48)]).optional()}).strict(),
  weather_image:z.object({city:location,day}).strict(),air_quality_image:z.object({city:location}).strict(),
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
    if(name==='weather_image'&&a.day&&a.day!=='today'){
      try{
        const {image}=await this.commands.briefing({cities:[a.city],day:a.day});
        return {text:'',image};
      }catch(error){
        recordRequestFailure(error);
        if(error?.code==='LOCATION_AMBIGUOUS')return {text:'地名有重名，请加省市：\n'+(error.suggestions??[]).slice(0,8).join('\n')};
        if(['LOCATION_NOT_FOUND','LOCATION_INPUT_INVALID'].includes(error?.code))return {text:'未找到该地点，请补充省市或使用地名全称。'};
        if(error?.code==='LOCATION_SOURCE_UNAVAILABLE')return {text:'地点查询暂不可用，请稍后查询。'};
        return {text:timeoutNotice(error)||'预报数据暂不可用，请稍后查询。'};
      }
    }
    const layers={cloud_video:'cloud_cover',satellite_video:'cloud',pm25_video:'pm25',precipitation_video:'precipitation',temperature_video:'temperature'};
    if(Object.hasOwn(layers,name))return this.commands.execute({type:'video',layer:layers[name],...a});
    if(name==='radar_catalog')return this.commands.execute({type:'radar-list',query:a.query});
    if(name==='radar_image')return this.commands.execute({type:'radar',city:a.target,...(a.source==='global'?{source:'global'}:{})});
    return this.commands.execute({type:name==='air_quality_image'?'air':'weather',city:a.city});
  }
  async invoke(name,args){
    if(!Object.hasOwn(schemas,name))throw new Error('UNKNOWN_WEATHER_TOOL');
    schemas[name].parse(args);
    try{return await this.worker.run({type:'execute',name,args},(n,a)=>this.execute(n,a));}
    catch(error){if(error.toolExecuted)throw error;if(error.timedOut){recordRequestFailure(error,'worker_total');return {text:timeoutNotice(error)};}return this.execute(name,args);}
  }
  async handle(text,previousCity){
    const c=parseWeatherCommand(text,this.commands.now?.());if(!c)return null;
    setTraceParameters({city:c.city,layer:c.layer,hours:c.type==='video'&&!c.error?(c.layer==='cloud'?6:c.hours??24):undefined});
    if(c.type==='video')return this.commands.handle(text,previousCity);
    if(c.type==='help')return this.commands.handle(text);
    if(c.type==='radar-list')return this.invoke('radar_catalog',{query:c.query});
    if(c.type==='radar')return this.invoke('radar_image',{target:c.city,...(c.source?{source:c.source}:{})});
    return this.invoke(c.type==='air'?'air_quality_image':'weather_image',{city:c.city,...(c.day?{day:c.day}:{})});
  }
  briefing(args){return this.invoke('local_weather_briefing',args);}
}
