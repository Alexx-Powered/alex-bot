import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {APP_ROOT,pythonExecutable} from './runtime-paths.mjs';
import {pythonEnvironment} from './python-agent.mjs';
let tail=Promise.resolve(),queued=0,lastStart=0;
const failure=()=>Object.assign(new Error('LOCATION_SOURCE_UNAVAILABLE'),{code:'LOCATION_SOURCE_UNAVAILABLE'});
/** One bounded process at a time; coalescing/cache lives in LocationService. */
export function searchOutdoorPlaces(query,{workerPath=resolve(APP_ROOT,'python/outdoor_places.py')}={}){
  if(queued>=4)return Promise.reject(failure());
  queued++;
  const task=tail.then(async()=>{
    await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-lastStart))));lastStart=Date.now();
    return new Promise((accept,reject)=>{
      const child=spawn(pythonExecutable(),['-B',workerPath],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:pythonEnvironment()});
      let output='',done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(failure()):accept(value);};
      const timer=setTimeout(()=>{child.kill();finish(true);},11000);
      child.stdout.on('data',data=>{output+=data;if(Buffer.byteLength(output)>32768){child.kill();finish(true);}});
      child.stderr.resume();child.on('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
      child.on('close',code=>{try{const result=JSON.parse(output);if(code!==0||!Array.isArray(result.places)||result.places.length>8)throw Error();finish(false,result.places);}catch{finish(true);}});
      child.stdin.end(JSON.stringify({query})+'\n');
    });
  }).finally(()=>queued--);
  tail=task.catch(()=>{});return task;
}
