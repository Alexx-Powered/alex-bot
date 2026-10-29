// Public forecast diagnostic. Never reads application secrets or sends QQ messages.
import fs from 'node:fs/promises';
import net from 'node:net';
import dns from 'node:dns/promises';
import {getAirQuality} from '../src/air-quality.mjs';
import {renderAirChart} from '../src/air-chart.mjs';
console.log(JSON.stringify({addresses:await dns.lookup('air-quality-api.open-meteo.com',{all:true}),connectAttemptMs:net.getDefaultAutoSelectFamilyAttemptTimeout()}));
if(process.argv.includes('--patient-connect'))net.setDefaultAutoSelectFamilyAttemptTimeout(1500);
const fetchImpl=async(url,options)=>{
  const start=Date.now();
  try{const r=await fetch(url,options);console.log(JSON.stringify({path:new URL(url).pathname,status:r.status,ms:Date.now()-start}));return r;}
  catch(e){console.log(JSON.stringify({path:new URL(url).pathname,error:e.name,code:e.cause?.code,causes:e.cause?.errors?.map(x=>({code:x.code,address:x.address})),ms:Date.now()-start}));throw e;}
};
try{
  const data=await getAirQuality({fetchImpl});
  const {buffer:image}=renderAirChart(data);
  await fs.writeFile('/var/lib/alexbot/.private/preflight/air.png',image,{mode:0o600});
  console.log(JSON.stringify({ok:true,hours:data.hourly.length,bytes:image.length}));
}catch(e){console.log(JSON.stringify({ok:false,code:e.code||e.message}));process.exitCode=1;}
