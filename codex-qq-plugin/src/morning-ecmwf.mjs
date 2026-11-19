import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';
import {atomicJson} from './storage.mjs';
import {CITIES,ForecastDataError,FORECAST_TIMEZONE,localDate} from './weather.mjs';
import {summarizeWeather} from './wind-summary.mjs';
import {measureSpan} from './telemetry.mjs';

const MAX_BYTES = 32 * 1024;
const errors = new Set(['MORNING_EC_CACHE_UNAVAILABLE','MORNING_EC_TIMELINE_UNAVAILABLE','MORNING_EC_ENSEMBLE_UNAVAILABLE']);

function invoke(payload,timeout) {
  return new Promise((resolve,reject)=>{
    const unavailable = () => reject(new ForecastDataError('MORNING_EC_TIMELINE_UNAVAILABLE'));
    const child = execFile(pythonExecutable(),['-B',path.join(APP_ROOT,'python','morning_ecmwf.py')],{
      env:{...pythonEnvironment(),OPENBLAS_NUM_THREADS:'1'},windowsHide:true,timeout,maxBuffer:MAX_BYTES,
    },(error,stdout)=>{
      if(error){
        if(error.killed)return reject(new ForecastDataError('FORECAST_SOURCE_TIMEOUT'));
        return unavailable();
      }
      try {
        const data=JSON.parse(stdout);
        if(errors.has(data.error))return reject(new ForecastDataError(data.error));
        if(!data||data.error||typeof data!=='object')return unavailable();
        resolve(data);
      }catch{unavailable();}
    });
    child.stdin.on('error',unavailable);
    child.stdin.end(JSON.stringify(payload)+'\n');
  });
}

const snapshotPath = (home,city) => path.join(home,'.private','morning-ecmwf-'+city+'.json');
const isMorningCity = city => city==='beijing'||city==='tianjin';

export async function captureMorningEc({home,city,now=Date.now()}) {
  if(!isMorningCity(city))throw new ForecastDataError('WEATHER_CITY_UNSUPPORTED');
  const target=snapshotPath(home,city);
  const data=await invoke({action:'capture',city,now:Math.floor(now/1000)},15000);
  if(data.city!==city||typeof data.date!=='string'||!Array.isArray(data.rows)||data.rows.length!==8)throw new ForecastDataError('MORNING_EC_TIMELINE_UNAVAILABLE');
  await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
  await atomicJson(target,data);
  return {date:data.date,city:data.city,run:data.run,hours:data.rows.length};
}

async function readSnapshot(home,city) {
  if(!home)throw new ForecastDataError('MORNING_EC_CACHE_UNAVAILABLE');
  const file=await fs.open(snapshotPath(home,city),'r').catch(()=>null);
  if(!file)throw new ForecastDataError('MORNING_EC_CACHE_UNAVAILABLE');
  try {
    const buffer=Buffer.alloc(MAX_BYTES+1);
    const {bytesRead}=await file.read(buffer);
    if(!bytesRead||bytesRead>MAX_BYTES)throw Error();
    return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  }catch{throw new ForecastDataError('MORNING_EC_CACHE_UNAVAILABLE');}
  finally{await file.close();}
}

export async function getMorningEcWeather({home,city,now,fetchTimeoutMs}) {
  if(!isMorningCity(city))throw new ForecastDataError('WEATHER_CITY_UNSUPPORTED');
  const snapshot=await measureSpan('weather_ecmwf_snapshot',()=>readSnapshot(home,city));
  const result=await measureSpan('weather_ecmwf_backup',()=>invoke({
    action:'forecast',city,now:Math.floor(now/1000),snapshot,
  },fetchTimeoutMs));
  const date=localDate(now);
  const {windBrief,weatherSummary}=await summarizeWeather(result.hourly,{date,weatherCode:result.weatherCode,scheduledMorning:true});
  return {city:CITIES[city],date,timezone:FORECAST_TIMEZONE,hourly:result.hourly,windBrief,weatherSummary,
    source:{model:'ecmwf_2',provider:'Visual Crossing',precipitationProbability:'ECMWF ENS / Open-Meteo'},
    fetchedAt:new Date(now).toISOString(),modelRunAt:result.modelRunAt,archiveFetchedAt:result.archiveFetchedAt};
}
