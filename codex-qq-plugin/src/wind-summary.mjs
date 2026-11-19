import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';
import {measureSpan} from './telemetry.mjs';

export const MORNING_WEATHER_SUMMARY_MS=30_000;

/** Public samples only; fixed Python LangChain worker, no model, URL or recipient parameter. */
export function summarizeWind(hourly,{onTimeout=()=>{}}={}) {
  return runSummary(hourly,{onTimeout});
}

/** Share the existing bounded worker; the optional weather packet leaves legacy wind callers unchanged. */
export function summarizeWeather(hourly,{date,weatherCode=null,scheduledMorning=false,onTimeout=()=>{}}={}) {
  const timeoutMs=scheduledMorning?MORNING_WEATHER_SUMMARY_MS:10_000;
  let timedOut=false;
  return measureSpan('weather_summary',()=>runSummary(hourly,{
    weather:{date,code:weatherCode},timeoutMs,onTimeout:()=>{timedOut=true;onTimeout(timeoutMs);},
  }),()=>timedOut?{code:'WEATHER_SUMMARY_TIMEOUT',timedOut,timeoutMs}:null);
}
const iconKeys=new Set(['sunny','partly-cloudy','overcast','light-rain','heavy-rain','thunderstorm','snow','fog']);
const validWind=days=>Array.isArray(days)&&days.length===2&&days.every(line=>typeof line==='string'&&line.length<100&&!/[<>@\r\n]/.test(line));
function runSummary(hourly,{onTimeout,weather,timeoutMs=10_000}={}) {
  const fallback=()=>weather?{windBrief:null,weatherSummary:null}:null;
  if (!Array.isArray(hourly) || !hourly.length || hourly.length > 48 ||
      (!hourly.some(row => Number.isFinite(row?.windSpeedMs)) && !Number.isInteger(weather?.code))) return Promise.resolve(fallback());
  return new Promise(resolveResult => {
    const child=spawn(pythonExecutable(),['-B',resolve(APP_ROOT,'python/wind_brief.py')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:pythonEnvironment()});
    let output='',done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolveResult(value);};
    const timer=setTimeout(()=>{onTimeout();child.kill();finish(fallback());},timeoutMs);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4096){child.kill();finish(fallback());}});
    child.stderr.resume();child.on('error',()=>finish(fallback()));child.stdin.on('error',()=>finish(fallback()));
    child.on('close',()=>{try{
      const result=JSON.parse(output);
      if(!weather)return finish(validWind(result)?result:null);
      const summary=result?.weatherSummary;
      const valid=summary?.date===weather.date && typeof summary.label==='string' && /^[\p{Script=Han}]{1,16}$/u.test(summary.label) &&
        ((summary.icon===null&&summary.code===null)||(iconKeys.has(summary.icon)&&summary.code===weather.code));
      finish(validWind(result?.windBrief)&&valid?result:fallback());
    }catch{finish(fallback());}});
    child.stdin.end(JSON.stringify({speeds:hourly.map(row=>row.windSpeedMs??null),directions:hourly.map(row=>row.windDirectionDeg??null),gusts:hourly.map(row=>row.windGustMs??null),...(weather?{weather}:{})})+'\n');
  });
}
