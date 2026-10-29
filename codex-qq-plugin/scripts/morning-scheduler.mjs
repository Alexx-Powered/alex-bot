import {mkdir,open,appendFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createBridgeClient} from '../src/bridge-client.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
export function beijingClock(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(p=>[p.type,p.value]));
  return {date:`${parts.year}-${parts.month}-${parts.day}`,due:Number(parts.hour)>=8};
}

export function createMorningTick({client,stateDir,ensureService,log=async()=>{},now=()=>new Date()}) {
  let busy=false,lastStart=0;
  return async function tick() {
    if(busy)return;
    busy=true;
    try {
      let status;
      try {status=await client.status();} catch {
        if(!lastStart||Date.now()-lastStart>=300000){lastStart=Date.now();await ensureService();}
        return;
      }
      const clock=beijingClock(now());
      if(!clock.due||!status.configured||!status.core?.paired||status.core.paused||status.transport?.state!=='connected')return;
      // Do not consume today's one-shot claim while only a local quota window blocks it.
      if(status.core.remainingDailyAttempts===0||status.core.minuteAttempts>=(status.core.limits?.minuteAttempts??3))return;
      await mkdir(stateDir,{recursive:true});
      let claim;
      try {claim=await open(resolve(stateDir,`${clock.date}.json`),'wx');}
      catch(error){if(error.code==='EEXIST')return;throw error;}
      // Claim before sending: a crash or uncertain delivery never causes an automatic resend.
      await claim.writeFile(JSON.stringify({date:clock.date,state:'attempted',at:now().toISOString()}));
      await claim.sync();
      await claim.close();
      let result;
      try {result=await client.weatherBriefing({mode:'daily'});}
      catch(error){result={ok:false,code:error.code||'DELIVERY_UNKNOWN'};}
      await log({date:clock.date,event:'briefing',ok:result.ok===true,code:result.code||'UNKNOWN'});
    } catch(error) {await log({event:'scheduler-error',code:error.code||'ERROR'});}
    finally {busy=false;}
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const privateDir=resolve(process.env.QQ_BRIDGE_HOME||root,'.private');
  await mkdir(privateDir,{recursive:true});
  const log=async event=>appendFile(resolve(privateDir,'morning-scheduler.log'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
  const tick=createMorningTick({
    client:createBridgeClient({timeoutMs:60000}),
    stateDir:resolve(privateDir,'morning-scheduler'),log,
    ensureService:async()=>{
      await run('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve(root,'scripts/start-service.ps1'),'-AutoConnect'],{windowsHide:true,timeout:30000});
      await log({event:'service-started'});
    },
  });
  await log({event:'scheduler-started'});
  await tick();
  setInterval(tick,15000);
}
