import {currentCitySamples} from './city-air-observations.mjs';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';
import {WeatherAlertWorker} from './weather-alert-worker.mjs';

const periods=[['上午',6,12],['下午',12,18]];
const grades={gold:'夯',excellent:'夯',fair:'可',poor:'拉'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const safeText=value=>typeof value==='string'&&value.length<=100&&!/[<>@\r\n]/u.test(value);
const reportWarnings=new WeatherAlertWorker();

export function unavailableOutdoorIndex(date,city,reason='关键预报数据不足') {
  return {date,city,status:'unknown',periods:periods.map(([name,startHour,endHour])=>({
    name,startHour,endHour,status:'unknown',score:null,grade:'unknown',character:null,gold:false,reason,
  })),recommendation:{word:'数据不足',suffix:'暂不评级'}};
}

/** Validate a finite result from the fixed Python worker, without reimplementing scoring. */
export function validOutdoorIndex(value,date,city) {
  const rating=row=>Object.hasOwn(grades,row.grade)&&row.character===grades[row.grade]&&
    finite(row.score)&&row.score>=0&&row.score<=100&&finite(row.displayScore)&&row.displayScore>=0&&row.displayScore<=100&&
    row.gold===(row.grade==='gold');
  if (!value||value.date!==date||value.city!==city||!['complete','unknown'].includes(value.status)||
      !Array.isArray(value.periods)||value.periods.length!==2) return false;
  const danger=value.dailyDanger;
  if(danger&&(!Array.isArray(danger.reasons)||!danger.reasons.length||danger.reasons.length>97||
    !danger.reasons.every(safeText)||value.status!=='complete'||value.score!==0||value.grade!=='poor'))return false;
  if (!value.periods.every((row,i)=>{
    if (!row||row.name!==periods[i][0]||row.startHour!==periods[i][1]||row.endHour!==periods[i][2]||!safeText(row.reason)) return false;
    if (row.status==='unknown') return !danger&&row.score===null&&row.grade==='unknown'&&row.character===null&&row.gold===false;
    const d=row.conditions;
    if(danger&&(row.status!=='complete'||row.score!==0||row.grade!=='poor'||!rating(row)))return false;
    if(danger&&!d)return true;
    return row.status==='complete'&&rating(row)&&d&&finite(d.cloudMean)&&d.cloudMean>=0&&d.cloudMean<=100&&
      (d.pm25Peak===null||(finite(d.pm25Peak)&&d.pm25Peak>=0&&d.pm25Peak<=5000))&&
      ['windPeak','gustPeak','rainTotal','rainPeak','wetHours'].every(k=>finite(d[k])&&d[k]>=0);
  })) return false;
  const recommendation=value.recommendation;
  if (recommendation?.causes !== undefined && (!Array.isArray(recommendation.causes) ||
      recommendation.causes.length > 4 || !recommendation.causes.every(safeText))) return false;
  if (value.status==='unknown') return recommendation?.word==='数据不足'&&recommendation.suffix==='暂不评级';
  if(danger)return rating(value)&&recommendation?.word==='全天'&&recommendation.suffix==='应当避免外出';
  return value.periods.every(row=>row.status==='complete')&&rating(value)&&periods.some(([name])=>name===value.bestPeriod)&&
    ['上午','下午','全天'].includes(recommendation?.word)&&['宜户外活动','户外条件尚可','不宜户外活动'].includes(recommendation.suffix);
}

/** Public forecast samples only. No model keys, network, paths, commands or recipients in the protocol. */
export async function summarizeOutdoor({date,city,weather,air,warning},{scheduledMorning=false,onTimeout=()=>{}}={}) {
  warning??=await reportWarnings.forReport(city,date);
  const coverage=warning?.partial?{warningPartial:true}:{};
  const missing=()=>({...unavailableOutdoorIndex(date,city),...coverage});
  const start=Date.parse(date+'T00:00:00+08:00');
  function hourly(source){
    const rows=new Map();
    if(source?.city?.id!==city||source.timezone!=='Asia/Shanghai'||!Array.isArray(source.hourly)||source.hourly.length>48)return rows;
    for(const row of source.hourly){
      const time=Date.parse(row?.time);
      if(!Number.isFinite(time)||time%3600000!==0||rows.has(time))return new Map();
      rows.set(time,row);
    }
    return rows;
  }
  const forecasts=hourly(weather?.date===date?weather:null),pollution=hourly(air);
  if(!forecasts.size&&!pollution.size&&!warning?.hazards?.length)return missing();
  const measured=(n,max)=>finite(n)&&n>=0&&n<=max?n:null;
  const observations=await currentCitySamples(date,city,weather?.city);
  const hours=Array.from({length:24},(_,h)=>{
    const time=start+h*3600000,row=forecasts.get(time);
    return {time:date+'T'+String(h).padStart(2,'0')+':00:00+08:00',
      observed:observations.get(h)??null,cloud:measured(row?.cloudCoverPct,100),pm25:measured(pollution.get(time)?.pm25,5000),wind:measured(row?.windSpeedMs,150),
      gust:measured(row?.windGustMs,150),rain:measured(row?.rainMm,1000),code:Number.isInteger(row?.weatherCode)?measured(row.weatherCode,99):null};
  });
  return new Promise(resolveResult=>{
    const child=spawn(pythonExecutable(),['-B',resolve(APP_ROOT,'python/outdoor_index.py')],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:pythonEnvironment(),
    });
    let output='',done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolveResult(result);};
    const timeoutMs=scheduledMorning?30_000:10_000;
    const timer=setTimeout(()=>{onTimeout(timeoutMs);child.kill();finish(missing());},timeoutMs);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384){child.kill();finish(missing());}});
    child.stderr.resume();child.on('error',()=>finish(missing()));child.stdin.on('error',()=>finish(missing()));
    child.on('close',()=>{
      try {const result={...JSON.parse(output),city,...coverage};finish(validOutdoorIndex(result,date,city)?result:missing());}
      catch {finish(missing());}
    });
    child.stdin.end(JSON.stringify({date,hours,red_hazards:warning?.hazards||[]})+'\n');
  });
}
