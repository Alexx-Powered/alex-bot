import {beijingDay,isCityQuery} from './weather-commands.mjs';
import {measureSpan,setTraceOperation} from './telemetry.mjs';
import {weatherReportCondition} from './weather-report-image.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {summarizeOutdoor} from './outdoor-summary.mjs';
import {withHeavyWork} from './heavy-work.mjs';
import {getMorningEcWeather} from './morning-ecmwf.mjs';
import {MORNING_PM25_SELECT_MS,selectMorningPm25} from './morning-pm25.mjs';
import {retryableWeatherSource} from './weather.mjs';
import {MORNING_WEATHER_SUMMARY_MS} from './wind-summary.mjs';

const morningRetryable = new Set(['FORECAST_SOURCE_TIMEOUT','FORECAST_SOURCE_UNAVAILABLE','FORECAST_COVERAGE_INCOMPLETE','FORECAST_DATA_MISSING',
  'MORNING_EC_CACHE_UNAVAILABLE','MORNING_EC_TIMELINE_UNAVAILABLE','MORNING_EC_ENSEMBLE_UNAVAILABLE','MORNING_PM25_UNAVAILABLE','MORNING_PM25_SELECT_TIMEOUT']);
const canRetryReport=error=>morningRetryable.has(error?.code)||retryableWeatherSource(error);
const morningWeatherFields = ['temperatureC','humidityPct','precipitationMm','precipitationProbabilityPct','cloudCoverPct','windSpeedMs','windDirectionDeg','windGustMs','rainMm','weatherCode'];

// This fixed profile is called only by the scheduled orchestrator. It is not a
// tool argument, a user-selectable timeout, or an alternate forecast source.
function morningSourceMissing(kind, value, date, city) {
  if (!value || value.city?.id !== city || value.timezone !== 'Asia/Shanghai' ||
      (kind === 'weather' && value.date !== date) || !Array.isArray(value.hourly) || value.hourly.length !== 48) return [kind];
  const start=Date.parse(date+'T00:00:00+08:00');
  if (!value.hourly.every((row,i)=>Date.parse(row?.time)===start+i*3600000)) return [kind+'.coverage'];
  return (kind==='weather'?morningWeatherFields:['pm25'])
    .filter(field=>value.hourly.some(row=>!Number.isFinite(row[field])||
      (field==='pm25'&&(row.pm25<0||row.pm25>5000)))).map(field=>kind+'.'+field);
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
  constructor(commands,{home,ecWeather=getMorningEcWeather,gefs}={}) {
    for(const field of ['locations','weather','weatherChart','now'])this[field]=commands[field];
    this.air=gefs?args=>selectMorningPm25(args,{cams:commands.air,gefs}):commands.air;
    this.ecWeather=args=>ecWeather({home,...args});
  }
  async briefing({cities=['beijing'],renderImage=true,includeData=false,day='today',retrySources=true,backupWeather=true,visualCrossingWeather=false}={}) {
    if(day!=='today')throw new Error('INVALID_WEATHER_DAY');
    if(!Array.isArray(cities)||cities.length!==1||cities.some(c=>!isCityQuery(c))||new Set(cities).size!==cities.length)throw new Error('INVALID_CITY');
    setTraceOperation('weather.report');
    const places=await measureSpan('resolve_location',()=>Promise.all(cities.map(city=>this.locations.resolve(city))));
    if(new Set(places.map(place=>place.id)).size!==places.length)throw new Error('INVALID_CITY');
    const now=this.now(), date=beijingDay(now+(day==='tomorrow'?86400000:0));
    const deadline=performance.now()+105_000,retried=[];
    const source=async(kind,place,query)=>{
      let first,error;
      const attempts=retrySources===false?1:2;
      for(let attempt=0;attempt<attempts;attempt++){
        // Reserve the post-fetch computation time inside the acquisition budget.
        const computeBudget=kind==='weather'?MORNING_WEATHER_SUMMARY_MS:MORNING_PM25_SELECT_MS;
        const remaining=Math.floor(deadline-performance.now()-computeBudget);
        if(remaining<=0)break;
        if(attempt)retried.push(kind);
        try{
          const value=await measureSpan(kind==='weather'?'weather_fetch':'air_fetch',
            ()=>query({scheduledMorning:true,fetchTimeoutMs:Math.min(45_000,remaining)},attempt),result=>{
              const missing=morningSourceMissing(kind,result,date,place.id);
              return missing.length?{code:'MORNING_SOURCE_FIELDS_MISSING',morningQuality:{missing}}:null;
            });
          if(!morningSourceMissing(kind,value,date,place.id).length)return value;
          first??=value;
        }catch(caught){
          error=caught;
          if(!(kind==='weather'?canRetryReport(caught):morningRetryable.has(caught?.code)))throw caught;
        }
      }
      if(first)return first;
      throw error??Object.assign(Error('FORECAST_SOURCE_TIMEOUT'),{code:'FORECAST_SOURCE_TIMEOUT'});
    };
    const queries=places.map(place=>source('weather',place,(profile,attempt)=>{
      if(visualCrossingWeather&&attempt===0)return this.ecWeather({city:place.id,now,fetchTimeoutMs:profile.fetchTimeoutMs});
      const backupSource=visualCrossingWeather|| (attempt===0?backupWeather:!backupWeather);
      return this.weather({city:place.id,place,day,days:2,now,exerciseFields:true,backupSource,...profile});
    }));
    const airPlace=places.find(place=>place.id==='beijing')??places[0];
    queries.push(source('air',airPlace,profile=>this.air({city:airPlace.id,place:airPlace,window:'calendar',day,now,date,...profile})));
    const results=await Promise.allSettled(queries);
    const weather=cities.map((_,i)=>results[i].status==='fulfilled'?results[i].value:null);
    const airResult=results.at(-1);
    const air=airResult?.status==='fulfilled'?airResult.value:null;
    const timeoutMessages=results.flatMap((r,i)=>r.status==='rejected'&&timeoutNotice(r.reason)?[`${i<places.length?places[i].name+'天气':'PM2.5'}：${timeoutNotice(r.reason)}`]:[]);
    const missing=places.filter((_,i)=>!weather[i]).map(place=>place.name+'天气缺数据');
    if(!air)missing.push(airPlace.name+'PM2.5缺数据');
    weather.forEach((result,i)=>{if(result?.timeoutNotice)timeoutMessages.push(places[i].name+'：'+result.timeoutNotice);});
    const ids=places.map(place=>place.id);
    const text=`${date} ${places.map(place=>place.name).join('/')}天气图：${day==='tomorrow'?'明天00:00至后天24:00':'今天00:00至明天24:00'}，温度、PM2.5、逐小时降水概率、云量。${missing.length?' '+missing.join('；')+'。':''}`;
    const inputs={date,cities:ids,places,weather,air,now};
    let outdoorTimeoutMs;
    if(ids.length===1){
      inputs.outdoorIndex=await measureSpan('morning_outdoor_index',
        ()=>summarizeOutdoor({date,city:ids[0],weather:weather[0],air},{scheduledMorning:true,onTimeout:ms=>{
          outdoorTimeoutMs=ms;timeoutMessages.push(`户外指数计算超时（${ms/1000}秒时限），其余预报正常展示`);
        }}),result=>weather[0]&&air&&result.status!=='complete'?
          outdoorTimeoutMs?{code:'MORNING_OUTDOOR_INDEX_TIMEOUT',timedOut:true,timeoutMs:outdoorTimeoutMs}:
            {code:'MORNING_OUTDOOR_INDEX_UNAVAILABLE'}:null);
    }
    const morningQuality=morningDataQuality(inputs,retried);
    const image=renderImage&&morningQuality.complete?await withHeavyWork(()=>measureSpan('weather_render',()=>this.weatherChart(inputs))):undefined;
    const sourceError=results.find(result=>result.status==='rejected')?.reason;
    const causeCode=outdoorTimeoutMs?'MORNING_OUTDOOR_INDEX_TIMEOUT':sourceError?.causeCode??sourceError?.code;
    const retryable=(outdoorTimeoutMs||morningQuality.missing.some(field=>field!=='outdoorIndex'))&&
      results.every(r=>r.status==='fulfilled'||canRetryReport(r.reason));
    return {ok:morningQuality.complete,date,cities:ids,text,morningQuality,retryable,
      ...(causeCode?{causeCode,httpStatus:sourceError?.httpStatus}:{}),
      ...(places.some(p=>/^(osm-|landmark-)/.test(p.id))?{locationNote:'地点使用代表坐标；步道仅代表图中标注位置。地名数据：© OpenStreetMap contributors / Wikimedia。'}:{}),...(timeoutMessages.length?{timeoutNotice:timeoutMessages.join('\n')}:{}),...(image?{image}:{}),...(includeData?{inputs}:{})};
  }
}
