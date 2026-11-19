import fs from 'node:fs/promises';
import path from 'node:path';
import {APP_ROOT,pythonExecutable} from '../src/runtime-paths.mjs';
import {winterMorningPm25} from '../src/morning-pm25.mjs';
import {localDate} from '../src/weather.mjs';

try{
  const home=process.env.QQ_BRIDGE_HOME;
  if(!home)throw Error('MORNING_GEFS_HOME_REQUIRED');
  const now=Date.now();
  if(winterMorningPm25(localDate(now))){
    const memory=await fs.readFile('/proc/meminfo','utf8');
    if(Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(memory)?.[1])>=600*1024){
      // Replace the status reader before starting the decoder in this cgroup.
      const python=pythonExecutable();
      process.execve(python,[python,'-B',path.join(APP_ROOT,'python','morning_pm25.py'),
        '--calendar-cache',String(Math.floor(now/1000))],{
        PATH:process.env.PATH||'/usr/bin',QQ_BRIDGE_HOME:home,PYTHONUTF8:'1',OPENBLAS_NUM_THREADS:'1',
        LANGCHAIN_TRACING:'false',LANGSMITH_TRACING:'false',
      });
    }else console.log(JSON.stringify({ok:true,code:'MORNING_GEFS_LOW_MEMORY'}));
  }
}catch(error){
  console.error(JSON.stringify({code:error.code||'MORNING_PM25_UNAVAILABLE'}));
  process.exitCode=1;
}
