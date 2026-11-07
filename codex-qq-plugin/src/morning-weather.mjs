import {beijingDay,isCityQuery} from './weather-commands.mjs';
import {measureSpan,setTraceOperation} from './telemetry.mjs';
import {weatherReportCondition} from './weather-report-image.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {summarizeOutdoor} from './outdoor-summary.mjs';
import {withHeavyWork} from './heavy-work.mjs';

const morningRetryable = new Set(['FORECAST_SOURCE_TIMEOUT','FORECAST_SOURCE_UNAVAILABLE','FORECAST_COVERAGE_INCOMPLETE','FORECAST_DATA_MISSING']);
const morningWeatherFields = ['temperatureC','humidityPct','precipitationMm','precipitationProbabilityPct','cloudCoverPct','windSpeedMs','windDirectionDeg','windGustMs','rainMm','weatherCode'];

// This fixed profile is called only by the scheduled orchestrator. It is not a
// tool argument, a user-selectable timeout, or an alternate forecast source.
function morningSourceMissing(kind, value, date, city) {
  if (!value || value.city?.id !== city || value.timezone !== 'Asia/Shanghai' ||
      (kind === 'weather' && value.date !== date) || !Array.isArray(value.hourly) || value.hourly.length !== 48) return [kind];
  const start=Date.parse(date+'T00:00:00+08:00');
  if (!value.hourly.every((row,i)=>Date.parse(row?.time)===start+i*3600000)) return [kind+'.coverage'];
  return (kind==='weather'?morningWeatherFields:['pm25'])
    .filter(field=>value.hourly.some(row=>!Number.isFinite(row[field]))).map(field=>kind+'.'+field);
}
export function morningDataQuality({date,cities,weather,air,outdoorIndex},retried=[]) {
  const missing=cities.flatMap((city,i)=>morningSourceMissing('weather',weather[i],date,city));
  missing.push(...morningSourceMissing('air',air,date,cities[0]));
  weather.forEach(value=>{
    if(!value)return;
    if(!weatherReportCondition(value,date))missing.push('weather.summary');
    if(typeof value.windBrief?.[0]!=='string'||!value.windBrief[0].trim()||value.windBrief[0].includes('缺'))missing.push('weather.windBrief');
  });
  if (!missing.length && outdoorIndex?.status !== 'complete') missing.push('outdoorIndex');
  return {complete:missing.length===0,missing:[...new Set(missing)],retried:[...retried]};
}
/** Scheduled static morning data only. Never selected by a chat tool or map route. */
export class ScheduledMorningWeather {
  constructor(commands) {
    for(const field of ['locations','weather','air','weatherChart','now'])this[field]=commands[field];
  }
  async briefing({cities=['beijing'],renderImage=true,includeData=false,day='today'}={}) {
    if(day!=='today')throw new Error('INVALID_WEATHER_DAY');
    if(!Array.isArray(cities)||cities.length!==1||cities.some(c=>!isCityQuery(c))||new Set(cities).size!==cities.length)throw new Error('INVALID_CITY');
    setTraceOperation('weather.report');
    const places=await measureSpan('resolve_location',()=>Promise.all(cities.map(city=>this.locations.resolve(city))));
    if(new Set(places.map(place=>place.id)).size!==places.length)throw new Error('INVALID_CITY');
    const now=this.now(), date=beijingDay(now+(day==='tomorrow'?86400000:0));
    const deadline=performance.now()+105_000,retried=[];
    const source=async(kind,place,query)=>{
      let first,error;
      for(let attempt=0;attempt<2;attempt++){
        // Leave room for the weather summary subprocess (10s) inside the
        // shared acquisition budget. Successful sources are never fetched twice.
        const remaining=Math.floor(deadline-performance.now()-(kind==='weather'?10_000:0));
        if(remaining<=0)break;
        if(attempt)retried.push(kind);
        try{
          const value=await query({scheduledMorning:true,fetchTimeoutMs:Math.min(45_000,remaining)});
          if(!morningSourceMissing(kind,value,date,place.id).length)return value;
          first??=value;
        }catch(caught){error=caught;if(!morningRetryable.has(caught?.code))throw caught;}
      }
      if(first)return first;
      throw error??Object.assign(Error('FORECAST_SOURCE_TIMEOUT'),{code:'FORECAST_SOURCE_TIMEOUT'});
    };
    const queries=places.map(place=>measureSpan('weather_fetch',()=>source('weather',place,profile=>this.weather({city:place.id,place,day,days:2,now,...(includeData||places.length===1?{exerciseFields:true}:{}),...profile}))));
    const airPlace=places.find(place=>place.id==='beijing')??places[0];
    queries.push(measureSpan('air_fetch',()=>source('air',airPlace,profile=>this.air({city:airPlace.id,place:airPlace,window:'calendar',day,now,...profile}))));
    const results=await Promise.allSettled(queries);
    const weather=cities.map((_,i)=>results[i].status==='fulfilled'?results[i].value:null);
    const airResult=results.at(-1);
    const air=airResult?.status==='fulfilled'?airResult.value:null;
    const timeoutMessages=results.flatMap((r,i)=>r.status==='rejected'&&timeoutNotice(r.reason)?[`${i<places.length?places[i].name+'天气':'PM2.5'}：${timeoutNotice(r.reason)}`]:[]);
    const missing=places.filter((_,i)=>!weather[i]).map(place=>place.name+'天气缺数据');
    if(!air)missing.push(airPlace.name+'CAMS缺数据');
    weather.forEach((result,i)=>{if(result?.timeoutNotice)timeoutMessages.push(places[i].name+'：'+result.timeoutNotice);});
    const ids=places.map(place=>place.id);
    const text=`${date} ${places.map(place=>place.name).join('/')}天气图：${day==='tomorrow'?'明天00:00至后天24:00':'今天00:00至明天24:00'}，温度、PM2.5、逐小时降水概率、云量。${missing.length?' '+missing.join('；')+'。':''}`;
    const inputs={date,cities:ids,places,weather,air,now};
    if(ids.length===1)inputs.outdoorIndex=await summarizeOutdoor({date,city:ids[0],weather:weather[0],air},
      {onTimeout:()=>timeoutMessages.push('户外指数计算超时（10秒时限），其余预报正常展示')});
    const morningQuality=morningDataQuality(inputs,retried);
    const image=renderImage&&morningQuality.complete?await withHeavyWork(()=>measureSpan('weather_render',()=>this.weatherChart(inputs))):undefined;
    return {ok:morningQuality.complete,date,cities:ids,text,...(morningQuality?{morningQuality}:{}),...(places.some(p=>/^(osm-|landmark-)/.test(p.id))?{locationNote:'地点使用代表坐标；步道仅代表图中标注位置。地名数据：© OpenStreetMap contributors / Wikimedia。'}:{}),...(timeoutMessages.length?{timeoutNotice:timeoutMessages.join('\n')}:{}),...(image?{image}:{}),...(includeData?{inputs}:{})};
  }
}
