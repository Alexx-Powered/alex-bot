// Offline operator only. Stop/drain the old transport, then preserve its pause choice.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {atomicJson} from '../src/storage.mjs';
import {projectStatus} from '../src/bridge-client.mjs';
const home=process.platform==='win32'?fileURLToPath(new URL('../',import.meta.url)):'/var/lib/alexbot';
const recordFile=path.join(home,'.private/migration/cutover-state.json');
const token=(await fs.readFile(path.join(home,'.private/admin-token'),'utf8')).trim();
async function call(route,body){
  const r=await fetch('http://127.0.0.1:19327/api/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...body?{'Content-Type':'application/json'}:{}},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(180000)});
  const value=await r.json();if(!r.ok||!value.ok)throw Error('CUTOVER_API_FAILED');return value;
}
try{
  if(process.argv[2]==='disconnect-local'&&process.platform==='win32'){
    const before=projectStatus(await call('status'));
    if(!before.configured||!before.core.paired)throw Error('OLD_SERVICE_UNREADY');
    await atomicJson(recordFile,{at:new Date().toISOString(),previousPaused:before.core.paused,before});
    await call('disconnect',{});
    const after=projectStatus(await call('status'));
    if(after.transport.state==='connected'||after.core.uncertainDeliveries)throw Error('OLD_SERVICE_NOT_QUIET');
    await fs.copyFile(path.join(home,'.private/state.json'),path.join(home,'.private/migration/rollback-state.json'));
    console.log(JSON.stringify({old_service_disconnected:true,status:after}));
  }else if(process.argv[2]==='resume-cloud'&&process.platform==='linux'){
    const record=JSON.parse(await fs.readFile(recordFile,'utf8'));
    if(typeof record.previousPaused!=='boolean')throw Error('INVALID_CUTOVER_RECORD');
    if(!record.previousPaused)await call('pause',{paused:false});
    console.log(JSON.stringify(projectStatus(await call('status'))));
  }else throw Error('INVALID_MODE');
}catch{console.error('CUTOVER_FAILED');process.exitCode=1;}
