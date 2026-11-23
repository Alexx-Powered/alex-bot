import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';
import {atomicJson} from './storage.mjs';
import {CITIES,FORECAST_TIMEZONE,ForecastDataError,HOUR_MS,forecastDate,localDate} from './weather.mjs';
import {measureSpan} from './telemetry.mjs';
import {getAirQuality} from './air-quality.mjs';

const MAX_BYTES=16*1024;
export const MORNING_PM25_SELECT_MS=20_000;
const GEFS_SOURCE=Object.freeze({name:'NOAA GEFS-Aerosols',model:'gefs_aerosols',provider:'NOAA',type:'model_forecast'});
const allowedCities=new Set(['beijing','tianjin']);
const failure=code=>new ForecastDataError(code??'MORNING_PM25_UNAVAILABLE');
const workerErrors=new Set(['MORNING_GEFS_DECODER_UNAVAILABLE','FORECAST_SOURCE_TIMEOUT','FORECAST_SOURCE_UNAVAILABLE',
  'FORECAST_SOURCE_RATE_LIMITED','FORECAST_SOURCE_HTTP_ERROR']);
export function winterMorningPm25(date){
  const month=Number(date.slice(5,7));
  return month>=11||(month>=1&&month<=3);
}

function invoke(action,data,timeout){
  return new Promise((resolve,reject)=>{
    const child=execFile(pythonExecutable(),['-B',path.join(APP_ROOT,'python','morning_pm25.py')],{
      env:{...pythonEnvironment(),OPENBLAS_NUM_THREADS:'1'},windowsHide:true,timeout,maxBuffer:MAX_BYTES,
    },(error,stdout)=>{
      if(error){
        const timeoutCode=action==='choose'?'MORNING_PM25_SELECT_TIMEOUT':'FORECAST_SOURCE_TIMEOUT';
        reject(error.killed?Object.assign(failure(timeoutCode),{timedOut:true,timeoutMs:timeout}):failure());
        return;
      }
      try{
        const output=JSON.parse(stdout);
        if(!output||typeof output!=='object'||output.error){
          const error=failure(workerErrors.has(output?.error)?output.error:undefined);
          if(Number.isInteger(output?.httpStatus)&&output.httpStatus>=400&&output.httpStatus<=599)error.httpStatus=output.httpStatus;
          reject(error);
        }else resolve(output);
      }catch{reject(failure());}
    });
    child.stdin.on('error',()=>reject(failure()));
    child.stdin.end(JSON.stringify({action,data})+'\n');
  });
}

export function completeMorningPm25(value,date,city){
  const start=Date.parse(date+'T00:00:00+08:00');
  return value?.city?.id===city&&value.timezone===FORECAST_TIMEZONE&&Array.isArray(value.hourly)&&
    value.hourly.length===48&&value.hourly.every((row,i)=>Date.parse(row?.time)===start+i*HOUR_MS&&
      Number.isFinite(row.pm25)&&row.pm25>=0&&row.pm25<=5000);
}

const cacheFile=(home,city)=>path.join(home,'.private','morning-gefs-'+city+'.json');

function validatedForecast(data,city,date,now,partial=false){
  const run=Date.parse(data?.modelRunAt), start=Date.parse(date+'T00:00:00+08:00');
  const fetched=Date.parse(data?.fetchedAt);
  const forecast={kind:'air-quality',city:{...CITIES[city]},timezone:FORECAST_TIMEZONE,unit:'μg/m³',
    source:GEFS_SOURCE,hourly:data?.hourly,modelRunAt:data?.modelRunAt,fetchedAt:data?.fetchedAt};
  if(data?.city!==city||data.date!==date||!Number.isFinite(run)||run%(6*HOUR_MS)!==0||
     run>Math.min(start,now)||now-run>36*HOUR_MS||!Number.isFinite(fetched)||fetched>now+5*60_000||fetched<run||
     !(partial?Array.isArray(forecast.hourly)&&forecast.hourly.length===48&&forecast.hourly.every((r,i)=>
       Date.parse(r?.time)===start+i*HOUR_MS&&(r.pm25===null||(Number.isFinite(r.pm25)&&r.pm25>=0&&r.pm25<=5000))):completeMorningPm25(forecast,date,city)))throw failure();
  return forecast;
}

export async function captureMorningGefs({home,city,now=Date.now(),fetchTimeoutMs=180_000}){
  const date=localDate(now);
  if(!home||!allowedCities.has(city)||!winterMorningPm25(date))throw failure();
  const raw=await invoke('forecast',{city,date_iso:date,now_seconds:Math.floor(now/1000)},fetchTimeoutMs);
  const data={...raw,fetchedAt:new Date(now).toISOString()};
  const forecast=validatedForecast(data,city,date,now);
  await fs.mkdir(path.dirname(cacheFile(home,city)),{recursive:true,mode:0o700});
  await atomicJson(cacheFile(home,city),data);
  return forecast;
}

async function readCachedForecast(filename){
  const file=await fs.open(filename,'r');
  try{
    const buffer=Buffer.alloc(MAX_BYTES+1);
    const {bytesRead}=await file.read(buffer);
    if(!bytesRead||bytesRead>MAX_BYTES)throw failure();
    return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  }finally{await file.close();}
}

export async function readCachedMorningGefs({home,city,date,now}){
  if(!home||!allowedCities.has(city))throw failure();
  const candidates=[];
  try{
    const bundle=await readCachedForecast(path.join(home,'.private','morning-gefs-calendar.json'));
    const data=bundle.forecasts?.[city];
    const offset=(Date.parse(date)-Date.parse(bundle.date))/HOUR_MS;
    if((offset===0||offset===24)&&data?.date===bundle.date&&data.hourly?.length===72){
      candidates.push(validatedForecast({...data,date,hourly:data.hourly.slice(offset,offset+48)},city,date,now));
    }
  }catch{}
  try{candidates.push(validatedForecast(await readCachedForecast(cacheFile(home,city)),city,date,now));}catch{}
  if(!candidates.length)throw failure();
  return candidates.reduce((newest,forecast)=>Date.parse(forecast.modelRunAt)>Date.parse(newest.modelRunAt)?forecast:newest);
}

// Production gets the prepared forecast. An on-demand read is bounded by the
// report deadline and also refreshes the cache for that day's generation retries.
export function createMorningGefs(home){
  let pending=null;
  return async function getMorningGefs({city,date,now,fetchTimeoutMs,partialWindow}){
    if(!home||!allowedCities.has(city))throw failure();
    try{return await readCachedMorningGefs({home,city,date,now});}catch{}
    // The live downloader covers today's window. Tomorrow is served by the
    // calendar cache, without relabelling today's data.
    if(partialWindow){
      const raw=await invoke('dated',{city,date_iso:date,now_seconds:Math.floor(now/1000)},Math.max(fetchTimeoutMs,25_000));
      const result=validatedForecast({...raw,fetchedAt:new Date(now).toISOString()},city,date,now,true);
      if(result.hourly.every(row=>row.pm25===null))throw failure('FORECAST_OUTSIDE_WINDOW');
      return result;
    }
    if(date!==localDate(now))throw failure();
    const key=city+date;
    if(pending?.key===key)return pending.forecast;
    if(pending)throw failure();
    const forecast=captureMorningGefs({home,city,now,fetchTimeoutMs});
    pending={key,forecast};
    try{return await forecast;}finally{pending=null;}
  };
}

export async function selectMorningPm25(args,{cams,gefs}){
  if(!gefs||!winterMorningPm25(args.date)||!allowedCities.has(args.city))return cams(args);
  const fetchSource=(name,read)=>measureSpan(name,()=>read(args),value=>
    completeMorningPm25(value,args.date,args.city)?null:{code:'MORNING_SOURCE_FIELDS_MISSING',morningQuality:{missing:['air.pm25']}});
  const [a,b]=await Promise.allSettled([fetchSource('morning_air_cams',cams),fetchSource('morning_air_gefs',gefs)]);
  if(args.partialWindow&&!(completeMorningPm25(a.value,args.date,args.city)&&completeMorningPm25(b.value,args.date,args.city))){
    const start=Date.parse(args.date+'T00:00:00+08:00');
    const acceptable=f=>f?.city?.id===args.city&&f.timezone===FORECAST_TIMEZONE&&f.hourly?.length===48&&
      f.hourly.every((r,i)=>Date.parse(r?.time)===start+i*HOUR_MS&&(r.pm25===null||
        (Number.isFinite(r.pm25)&&r.pm25>=0&&r.pm25<=5000)))&&f.hourly.some(r=>r.pm25!==null);
    const forecasts=[a,b].map(r=>acceptable(r.value)?r.value:null);
    const [camsData,gefsData]=forecasts;
    if(!forecasts.some(Boolean)){
      const error=[a,b].map(r=>r.reason??failure()).find(e=>e.code!=='FORECAST_OUTSIDE_WINDOW')??failure('FORECAST_OUTSIDE_WINDOW');
      error.sources='CAMS / ECMWF、NOAA GEFS-Aerosols';
      throw error;
    }
    if(!camsData||!gefsData)return camsData??gefsData;
    const selected=await invoke('compare_partial',{cams:camsData.hourly.map(r=>r.pm25),gefs:gefsData.hourly.map(r=>r.pm25)},5000);
    if(!Array.isArray(selected)||selected.length!==2||selected.some(s=>!['gefs_aerosols','cams_global'].includes(s)))throw failure();
    const [first,second]=selected.map(model=>model==='gefs_aerosols'?gefsData:camsData);
    if(first===second||!second.hourly.slice(24).some(r=>Number.isFinite(r.pm25)))return first;
    if(!first.hourly.slice(0,24).some(r=>Number.isFinite(r.pm25)))return second;
    return {kind:first.kind,city:first.city,timezone:first.timezone,unit:first.unit,fetchedAt:first.fetchedAt,
      hourly:[...first.hourly.slice(0,24),...second.hourly.slice(24)],
      source:{model:'daily_selection',name:selected.map(s=>s==='gefs_aerosols'?'NOAA GEFS-Aerosols':'CAMS / ECMWF').join(' → ')}};

  }
  if(!completeMorningPm25(b.value,args.date,args.city)){
    if(a.status==='fulfilled')return a.value;
    throw a.reason;
  }
  if(!completeMorningPm25(a.value,args.date,args.city))return b.value;
  const values=forecast=>forecast.hourly.map(row=>row.pm25);
  const selected=await measureSpan('morning_air_select',()=>invoke('choose',{
    cams:values(a.value),gefs:values(b.value),
  },args.scheduledMorning===true?MORNING_PM25_SELECT_MS:5_000));
  if(!['gefs_aerosols','cams_global'].includes(selected.model))throw failure();
  return selected.model==='gefs_aerosols'?b.value:a.value;
}

export function createCalendarAirQuality(home,{cams=getAirQuality,gefs=createMorningGefs(home)}={}){
  return args=>{
    if(args.window!=='calendar')return cams(args);
    const now=args.now??Date.now();
    const date=forecastDate(args.day??'today',now);
    return selectMorningPm25({...args,now,date,fetchTimeoutMs:args.fetchTimeoutMs??8000},{cams,gefs});
  };
}
