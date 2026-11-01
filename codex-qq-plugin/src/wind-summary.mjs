import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';

/** Public samples only; fixed Python LangChain worker, no model, URL or recipient parameter. */
export function summarizeWind(hourly,{onTimeout=()=>{}}={}) {
  if (!Array.isArray(hourly) || hourly.length > 48 || !hourly.some(row => Number.isFinite(row.windSpeedMs))) return Promise.resolve(null);
  return new Promise(resolveResult => {
    const child=spawn(pythonExecutable(),['-B',resolve(APP_ROOT,'python/wind_brief.py')],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:pythonEnvironment()});
    let output='',done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolveResult(value);};
    const timer=setTimeout(()=>{onTimeout();child.kill();finish(null);},10000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>4096){child.kill();finish(null);}});
    child.stderr.resume();child.on('error',()=>finish(null));child.stdin.on('error',()=>finish(null));
    child.on('close',()=>{try{const days=JSON.parse(output);finish(Array.isArray(days)&&days.length===2&&days.every(line=>typeof line==='string'&&line.length<100&&!/[<>@\r\n]/.test(line))?days:null);}catch{finish(null);}});
    child.stdin.end(JSON.stringify({speeds:hourly.map(row=>row.windSpeedMs??null),directions:hourly.map(row=>row.windDirectionDeg??null),gusts:hourly.map(row=>row.windGustMs??null)})+'\n');
  });
}
