import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {pythonExecutable} from './runtime-paths.mjs';
import {measureSpan} from './telemetry.mjs';
const fail=code=>Object.assign(new Error(code),{code});

/** Independent bounded subprocess: polling never joins the conversation/model worker queue. */
export class WeatherAlertWorker {
  #poll=null;#closed=false;#children=new Set();
  #reports=new Map();
  async forReport(city,date){
    const now=Date.now();
    const localDay=ts=>new Date(ts+8*3600000).toISOString().slice(0,10);
    const missing={hazards:[],partial:true};
    if(!city||![localDay(now),localDay(now+86400000)].includes(date))return missing;
    const key=city+'/'+date;
    for(const [id,row] of this.#reports)if(row.until<=now)this.#reports.delete(id);
    if(this.#reports.has(key))return this.#reports.get(key).job;
    const job=this.run({action:'outdoor',query:city,date}).then(r=>{
      if(!r.ok||r.placeId!==city||r.date!==date||!Array.isArray(r.hazards))return missing;
      return {hazards:r.hazards,partial:r.partial===true};
    }).catch(()=>missing);
    if(this.#reports.size<128)this.#reports.set(key,{until:now+60000,job});
    return job;
  }
  run(packet) {
    if(this.#closed)return Promise.reject(fail('ALERT_WORKER_CLOSED'));
    if(packet.action==='poll'&&this.#poll)return this.#poll;
    if(this.#children.size>=2)return Promise.reject(fail('ALERT_BUSY'));
    const task=measureSpan(['poll','outdoor'].includes(packet.action)?'warning_fetch':'warning_area',()=>new Promise((resolve,reject)=>{
      const child=execFile(pythonExecutable(),['-B',fileURLToPath(new URL('../python/weather_alerts.py',import.meta.url))],
        {windowsHide:true,timeout:20000,maxBuffer:6_000_000,env:{...process.env,PYTHONUTF8:'1'}},(error,stdout)=>{
          this.#children.delete(child);
          if(error)return reject(fail('ALERT_SOURCE_UNAVAILABLE'));
          try{const result=JSON.parse(stdout);if(typeof result.ok!=='boolean')throw Error();resolve(result);}catch{reject(fail('ALERT_SOURCE_SCHEMA'));}
        });
      this.#children.add(child);child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(packet));
    }));
    if(packet.action==='poll'){this.#poll=task;void task.finally(()=>{this.#poll=null;}).catch(()=>{});}
    return task;
  }
  close(){this.#closed=true;for(const child of this.#children)child.kill();}
}
