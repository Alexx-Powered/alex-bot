import {videoOperation,videoRegion,WeatherVideoService} from './weather-video.mjs';
import {measureSpan,setTraceOperation} from './telemetry.mjs';
import { RadarRouter } from './global-radar.mjs';
import { CITIES, getWeatherBrief } from './weather.mjs';
import { getAirQuality } from './air-quality.mjs';
import { renderAirChart } from './air-chart.mjs';
import { renderWeatherChart } from './weather-chart.mjs';
import { renderWeatherReportImage } from './weather-report-image.mjs';
import { LocationService } from './locations.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {summarizeOutdoor} from './outdoor-summary.mjs';
import {withHeavyWork} from './heavy-work.mjs';

export const beijingDay = (now = Date.now()) => new Date(now + 8 * 3600000).toISOString().slice(0,10);
const names = Object.fromEntries(Object.entries(CITIES).map(([id, city]) => [id, city.name]));
const cityIds = new Map(Object.entries(names).map(([id, name]) => [name, id]));
export const isCityQuery = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 60 && /^[\p{Script=Han}\p{Script=Latin}\d ·（）()，,.'-]+$/u.test(value) && !['__proto__','constructor','toString'].includes(value);
const cityQuery = value => cityIds.get(value.trim().replace(/市$/, '')) ?? value.trim();
export function parseWeatherCommand(text) {
  if (typeof text !== 'string' || text.length > 100) return null;
  const input=text.trim();
  const history=/^发\s*历史云图\s+(.+)$/u.exec(input);
  if(history&&isCityQuery(history[1]))return {type:'video',layer:'cloud',city:history[1].trim()};
  const normalized=input.normalize('NFKC');
  const forecast=/^(?:发\s*)?(?:(?<hours>\d+)\s*(?:h|小时)\s*)?(?:动态|预报)\s*(?<kind>云图|PM2\.?5|降水|温度)(?<rest>.*)$/iu.exec(normalized)
    ?? /^发\s*(?<kind>云图|PM2\.?5|降水|温度)\s+(?<rest>.+)$/iu.exec(normalized);
  if(forecast){
    const {kind,hours,rest}=forecast.groups;
    const layer=({云图:'cloud_cover',降水:'precipitation',温度:'temperature'})[kind]??'pm25';
    let city=rest.trim();
    const afterKind=/^(\d+)\s*(?:h(?=\s|$|\p{Script=Han})|小时(?=\s|$))/iu.exec(city);
    if(afterKind)city=city.slice(afterKind[0].length).trim();
    const afterPlace=/\s+(\d+)\s*(?:h|小时)$/iu.exec(city);
    if(afterPlace)city=city.slice(0,afterPlace.index).trim();
    const windows=[hours,afterKind?.[1],afterPlace?.[1]].filter(Boolean).map(Number);
    if(windows.some(n=>n!==24&&n!==48)||new Set(windows).size>1)return {type:'video',layer,error:'duration'};
    if(!city&&windows.length)return {type:'video',layer,error:'place'};
    if(isCityQuery(city))return {type:'video',layer,city,...(windows[0]===48?{hours:48}:{})};
    return null;
  }
  const global=/^(?:发\s*)?全球雷达(?:图)?(?:\s*(.*))?$/u.exec(input);
  if(global&&(!global[1]||isCityQuery(global[1])))return {type:'radar',city:global[1]?.trim()||'全球',source:'global'};
  if (/^(帮助|菜单|\/help)$/.test(input)) return {type:'help'};
  let m=/^(?:雷达目录|雷达站点|发\s*雷达\s*目录)(?:\s*(.*))?$/.exec(input);
  if(m && /^[\p{Script=Han}A-Za-z0-9·（）() _-]{0,40}$/u.test(m[1]||'')) return {type:'radar-list',query:(m[1]||'').trim()};
  m=/^发\s*雷达\s*([\p{Script=Han}A-Za-z0-9·（）() _-]{1,40})$/u.exec(input);
  if(m) return {type:'radar',city:m[1].trim()};
  m=/^发\s*(?:雾霾|CAMS|PM2\.?5|空气(?:质量)?)(?:\s*曲线)?\s*(.*)$/i.exec(input);
  if(m && (!m[1] || isCityQuery(m[1]))) return {type:'air',city:m[1]?cityQuery(m[1]):'beijing'};
  m=/^发\s*天气\s*(.+)$/u.exec(input);
  if(m && isCityQuery(m[1])) return {type:'weather',city:cityQuery(m[1])};
  return null;
}
export class WeatherCommands {
  constructor({home,videos=new WeatherVideoService({home}),radar=new RadarRouter({home}),locations=new LocationService(),weather=getWeatherBrief,air=getAirQuality,chart=renderAirChart,weatherChart=input=>input.cities.length===1?renderWeatherReportImage({inputs:input}):renderWeatherChart(input),now=Date.now}={}) {
    this.videos=videos;this.radar=radar; this.locations=locations; this.weather=weather; this.air=air; this.chart=chart; this.weatherChart=weatherChart; this.now=now;
  }
  async handle(text) {
    const command=parseWeatherCommand(text); if(!command)return null;
    if(command.type==='help')return {text:'发 天气 城市或区县\n发 雾霾 城市或区县\n发 雷达 站名或区域\n雷达目录 [省名] [页码]\n换算 0.6 HU$ 人民币（也支持马里、马时）\n同名地点请加省市，例如：辽宁 朝阳。\n/pause 暂停；/status 状态\n每天08:00发送北京天气合成图。'};
    try {
      if(command.type==='video'){
        setTraceOperation(videoOperation(command.layer));
        if(command.error==='duration')return {text:'预报视频请选择 24 或 48 小时，例如「发 动态云图48h 北京」。'};
        if(command.error==='place')return {text:'请补充地点，例如「发 动态云图48h 华北」。'};
        const target=await measureSpan('resolve_location',()=>videoRegion(command.city)??this.locations.resolve(command.city));
        return await this.videos.get(command.layer,target,command.hours);
      }
      if(command.type==='radar-list') return {text:(await this.radar.list(command.query)).text};
      if(command.type==='radar') {
        setTraceOperation('weather.radar');
        const result=await measureSpan('radar_query',()=>this.radar.get(command.city,command.source?{source:command.source}:{}));
        return {text:result.global?result.caption:'',image:{buffer:result.buffer,mimeType:result.mimeType},...(result.global?{richMedia:true}:{})};
      }
      if(command.type==='air') {
        setTraceOperation('weather.air');
        const place=await measureSpan('resolve_location',()=>this.locations.resolve(command.city));
        const result=await measureSpan('air_fetch',()=>this.air({city:place.id,place,now:this.now()}));
        return {text:'',image:await measureSpan('weather_render',()=>this.chart(result))};
      }
      const result=await this.briefing({cities:[command.city]});
      return {text:'',image:result.image};
    } catch(error) {
      if(error?.code?.startsWith('VIDEO_'))return {text:error.message};
      const timeout=timeoutNotice(error);if(timeout)return {text:timeout};
      if(error?.code?.startsWith('GLOBAL_RADAR_'))return {text:error.message+'\n来源：RainViewer https://www.rainviewer.com/'};
      if(error?.code==='LOCATION_AMBIGUOUS') return {text:'地名有重名，请加省市：\n'+(error.suggestions??[]).slice(0,8).join('\n')};
      if(['LOCATION_NOT_FOUND','LOCATION_INPUT_INVALID'].includes(error?.code))return {text:'未找到该地点，请补充省市县，或使用景点、山峰、村庄、步道的完整名称。'};
      if(error?.code==='LOCATION_SOURCE_UNAVAILABLE')return {text:'地点查询暂不可用，请稍后查询。'};
      if(error?.code==='AMBIGUOUS_TARGET'&&Array.isArray(error.suggestions)) return {text:'匹配到多个雷达站点，请使用完整名称：\n'+error.suggestions.slice(0,25).join('\n')+'\n例如：发 雷达 完整站名'};
      if(['NOT_FOUND','RADAR_TARGET_NOT_FOUND','TARGET_NOT_FOUND'].includes(error?.code)) return {text:'未找到站点或区域，请发送“雷达目录”查询。'};
      if(error?.code==='RADAR_STALE') return {text:'该雷达图已过期，暂不发送。'};
      if(command.type==='video')return {text:'动态天气视频暂不可用，请稍后查询。'};
      if(command.type==='radar-list') return {text:'雷达目录暂不可用，请稍后查询。'};
      return {text:command.type==='radar'?'雷达图暂不可用，请稍后查询。':'预报数据暂不可用，请稍后查询。'};
    }
  }
  async briefing({cities=['beijing'],renderImage=true,includeData=false,day='today'}={}) {
    if(!['today','tomorrow'].includes(day))throw new Error('INVALID_WEATHER_DAY');
    if(!Array.isArray(cities)||cities.length<1||cities.length>2||cities.some(c=>!isCityQuery(c))||new Set(cities).size!==cities.length)throw new Error('INVALID_CITY');
    setTraceOperation('weather.report');
    const places=await measureSpan('resolve_location',()=>Promise.all(cities.map(city=>this.locations.resolve(city))));
    if(new Set(places.map(place=>place.id)).size!==places.length)throw new Error('INVALID_CITY');
    const now=this.now(), date=beijingDay(now+(day==='tomorrow'?86400000:0));
    const queries=places.map(place=>measureSpan('weather_fetch',()=>this.weather({city:place.id,place,day,days:2,now,...(includeData||places.length===1?{exerciseFields:true}:{})})));
    const airPlace=places.find(place=>place.id==='beijing')??places[0];
    queries.push(measureSpan('air_fetch',()=>this.air({city:airPlace.id,place:airPlace,window:'calendar',day,now})));
    const results=await Promise.allSettled(queries);
    const weather=cities.map((_,i)=>results[i].status==='fulfilled'?results[i].value:null);
    const airResult=results.at(-1);
    const air=airResult?.status==='fulfilled'?airResult.value:null;
    if(!weather.some(Boolean)&&!air){
      const timed=results.find(r=>r.status==='rejected'&&timeoutNotice(r.reason));
      if(timed)throw timed.reason;
      throw new Error('WEATHER_DATA_UNAVAILABLE');
    }
    const timeoutMessages=results.flatMap((r,i)=>r.status==='rejected'&&timeoutNotice(r.reason)?[`${i<places.length?places[i].name+'天气':'PM2.5'}：${timeoutNotice(r.reason)}`]:[]);
    const missing=places.filter((_,i)=>!weather[i]).map(place=>place.name+'天气缺数据');
    if(!air)missing.push(airPlace.name+'CAMS缺数据');
    weather.forEach((result,i)=>{if(result?.timeoutNotice)timeoutMessages.push(places[i].name+'：'+result.timeoutNotice);});
    const ids=places.map(place=>place.id);
    const text=`${date} ${places.map(place=>place.name).join('/')}天气图：${day==='tomorrow'?'明天00:00至后天24:00':'今天00:00至明天24:00'}，温度、PM2.5、逐小时降水概率、云量。${missing.length?' '+missing.join('；')+'。':''}`;
    const inputs={date,cities:ids,places,weather,air,now};
    if(ids.length===1)inputs.outdoorIndex=await summarizeOutdoor({date,city:ids[0],weather:weather[0],air},
      {onTimeout:()=>timeoutMessages.push('户外指数计算超时（10秒时限），其余预报正常展示')});
    const image=renderImage?await withHeavyWork(()=>measureSpan('weather_render',()=>this.weatherChart(inputs))):undefined;
    return {ok:true,date,cities:ids,text,...(places.some(p=>/^(osm-|landmark-)/.test(p.id))?{locationNote:'地点使用代表坐标；步道仅代表图中标注位置。地名数据：© OpenStreetMap contributors / Wikimedia。'}:{}),...(timeoutMessages.length?{timeoutNotice:timeoutMessages.join('\n')}:{}),...(image?{image}:{}),...(includeData?{inputs}:{})};
  }
  close(){this.radar.close?.();this.videos.close?.();}
}
