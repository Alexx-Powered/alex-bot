import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';

const periods=[['上午',6,12],['下午',12,18]];
const grades={gold:'夯',excellent:'夯',fair:'可',poor:'拉'};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const safeText=value=>typeof value==='string'&&value.length<=100&&!/[<>@\r\n]/u.test(value);

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
  if (!value.periods.every((row,i)=>{
    if (!row||row.name!==periods[i][0]||row.startHour!==periods[i][1]||row.endHour!==periods[i][2]||!safeText(row.reason)) return false;
    if (row.status==='unknown') return row.score===null&&row.grade==='unknown'&&row.character===null&&row.gold===false;
    const d=row.conditions;
    return row.status==='complete'&&rating(row)&&d&&finite(d.cloudMean)&&d.cloudMean>=0&&d.cloudMean<=100&&
      ['pm25Peak','windPeak','gustPeak','rainTotal','rainPeak','wetHours'].every(k=>finite(d[k])&&d[k]>=0);
  })) return false;
  const recommendation=value.recommendation;
  if (value.status==='unknown') return recommendation?.word==='数据不足'&&recommendation.suffix==='暂不评级';
  return value.periods.every(row=>row.status==='complete')&&rating(value)&&periods.some(([name])=>name===value.bestPeriod)&&
    ['上午','下午','全天'].includes(recommendation?.word)&&['宜户外活动','户外条件尚可','不宜户外活动'].includes(recommendation.suffix);
}

/** Public forecast samples only. No model keys, network, paths, commands or recipients in the protocol. */
export async function summarizeOutdoor({date,city,weather,air},{onTimeout=()=>{}}={}) {
  const missing=()=>unavailableOutdoorIndex(date,city);
  if (weather?.city?.id!==city||weather.date!==date||weather.timezone!=='Asia/Shanghai'||
      air?.city?.id!==city||air.timezone!=='Asia/Shanghai'||
      !Array.isArray(weather.hourly)||!weather.hourly.length||weather.hourly.length>48||
      !Array.isArray(air.hourly)||air.hourly.length>48) return missing();
  const airByTime=new Map();
  for (const row of air.hourly) {
    const stamp=Date.parse(row?.time);
    if (!Number.isFinite(stamp)||airByTime.has(stamp)) return missing();
    airByTime.set(stamp,row.pm25);
  }
  const hours=[];
  for (const row of weather.hourly) {
    const stamp=Date.parse(row?.time);
    if (!Number.isFinite(stamp)||stamp%3600000!==0) return missing();
    hours.push({time:new Date(stamp+8*3600000).toISOString().slice(0,19)+'+08:00',
      cloud:row.cloudCoverPct??null,pm25:airByTime.get(stamp)??null,wind:row.windSpeedMs??null,
      gust:row.windGustMs??null,rain:row.rainMm??null,code:row.weatherCode??null});
  }
  return new Promise(resolveResult=>{
    const child=spawn(pythonExecutable(),['-B',resolve(APP_ROOT,'python/outdoor_index.py')],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:pythonEnvironment(),
    });
    let output='',done=false;
    const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolveResult(result);};
    const timer=setTimeout(()=>{onTimeout();child.kill();finish(missing());},10000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16384){child.kill();finish(missing());}});
    child.stderr.resume();child.on('error',()=>finish(missing()));child.stdin.on('error',()=>finish(missing()));
    child.on('close',()=>{
      try {const result={...JSON.parse(output),city};finish(validOutdoorIndex(result,date,city)?result:missing());}
      catch {finish(missing());}
    });
    child.stdin.end(JSON.stringify({date,hours})+'\n');
  });
}
