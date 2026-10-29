// Read-only full catalog probe. No QQ, credentials, server or bridge imports.
// Multi-coordinate requests are charged conservatively as one unit per location
// per source. Stop on platform limits; never retry or change hosts to evade them.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { getLocationCatalog, CITIES, LOCATION_METADATA } from '../src/locations.mjs';
import { getWeatherBrief, HOUR_MS, localDate } from '../src/weather.mjs';
import { getAirQuality } from '../src/air-quality.mjs';
import { renderWeatherChart } from '../src/weather-chart.mjs';

const output=new URL('../test-output/weather-catalog-live.json',import.meta.url);
await mkdir(new URL('../test-output/',import.meta.url),{recursive:true});
const places=[...new Map([...getLocationCatalog(),...Object.values(CITIES)].map(p=>[p.id,p])).values()];
if(LOCATION_METADATA.status==='BUILDING'||getLocationCatalog().length===0)throw Error('LOCATION_CATALOG_NOT_READY');
const report={version:1,startedAt:new Date().toISOString(),mode:'live-read-only',qqMessagesSent:0,
  catalog:LOCATION_METADATA,total:places.length,batchSize:25,requests:0,chargedLocationUnits:0,
  passed:0,failed:0,notRun:0,entries:[],stoppedReason:null};
const recheck=process.argv.includes('--recheck-failed-and-renamed');
const resume=process.argv.includes('--resume')||recheck;
const waitForBudget=process.argv.includes('--wait-for-budget');
if(resume) {
  const prior=JSON.parse(await readFile(output,'utf8'));
  if(prior.total!==places.length)throw Error('CATALOG_CHANGED');
  report.entries=prior.entries.filter(e=>e.status!=='not-run');
  report.requests=prior.requests; report.chargedLocationUnits=prior.chargedLocationUnits;
  report.chargedEvents=prior.chargedEvents??[];
  report.startedAt=prior.startedAt;
  report.followUpAttempts=prior.followUpAttempts??[];
  if(recheck){
    const current=new Map(places.map(p=>[p.id,p]));
    const affected=report.entries.filter(e=>e.status==='failed'||e.name!==current.get(e.id)?.name);
    report.followUpAttempts.push(...affected.map(e=>({...e,reason:e.status==='failed'?'source failure follow-up':'display-name correction',supersededAt:new Date().toISOString()})));
    const ids=new Set(affected.map(e=>e.id));report.entries=report.entries.filter(e=>!ids.has(e.id));
  }
}
const done=new Set(report.entries.map(e=>e.id));
const pending=places.filter(p=>!done.has(p.id));
const charged=report.chargedEvents??=[];
const metadata=new Map();
const tally=()=>{report.passed=report.entries.filter(e=>e.status==='passed').length;report.failed=report.entries.filter(e=>e.status==='failed').length;report.notRun=report.entries.filter(e=>e.status==='not-run').length;};
async function save(){tally();report.updatedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2)+'\n');}
async function waitUntilBudget(units){
  for(;;){
    const now=Date.now();while(charged.length&&charged[0].time<=now-HOUR_MS)charged.shift();
    if(charged.reduce((sum,x)=>sum+x.units,0)+units<=4400){delete report.waitingUntil;return;}
    if(!waitForBudget)throw Object.assign(Error(),{code:'LOCAL_HOURLY_BUDGET'});
    const until=charged[0].time+HOUR_MS+1000;
    if(report.waitingUntil!==new Date(until).toISOString()){
      report.waitingUntil=new Date(until).toISOString();await save();
      console.log(JSON.stringify({waitingFor:'hourly public API budget',until:report.waitingUntil,completed:report.entries.length,pending:places.length-report.entries.length,qqMessagesSent:0}));
    }
    await delay(Math.min(60000,Math.max(1000,until-Date.now())));
  }
}
async function fetchJson(url,units=1){
  const now=Date.now(); while(charged.length && charged[0].time<=now-HOUR_MS)charged.shift();
  if(charged.reduce((sum,x)=>sum+x.units,0)+units>4400)throw Object.assign(Error(),{code:'LOCAL_HOURLY_BUDGET'});
  // Leave a reserve for normal bot use and other work on this public API.
  if(report.chargedLocationUnits+units>9000)throw Object.assign(Error(),{code:'LOCAL_DAILY_BUDGET'});
  charged.push({time:now,units});report.chargedLocationUnits+=units;report.requests++;
  const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(45000),headers:{Accept:'application/json'}});
  if(response.status===429)throw Object.assign(Error(),{code:'SOURCE_RATE_LIMITED'});
  if(!response.ok)throw Object.assign(Error(),{code:'SOURCE_HTTP_'+response.status});
  const headers={date:response.headers.get('date'),'content-type':response.headers.get('content-type')};
  const rateHeaders=Object.fromEntries([...response.headers].filter(([key])=>key.startsWith('x-ratelimit')||key==='retry-after'));
  if(Object.keys(rateHeaders).length)report.latestSourceRateHeaders={host:new URL(url).hostname,...rateHeaders};
  if(!/application\/json/i.test(headers['content-type']??''))throw Object.assign(Error(),{code:'SOURCE_FORMAT'});
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>8*1024*1024)throw Object.assign(Error(),{code:'SOURCE_SIZE'});chunks.push(Buffer.from(chunk));}
  return {data:JSON.parse(Buffer.concat(chunks).toString('utf8')),headers};
}
async function getMeta(kind){
  const cached=metadata.get(kind);if(cached && Date.now()-cached.time<15*60000)return cached;
  const url=kind==='weather'?'https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json':'https://air-quality-api.open-meteo.com/data/cams_global/static/meta.json';
  const result={...await fetchJson(url),time:Date.now()};metadata.set(kind,result);return result;
}
function batchUrl(kind,batch,now){
  const url=new URL(kind==='weather'?'https://api.open-meteo.com/v1/ecmwf':'https://air-quality-api.open-meteo.com/v1/air-quality');
  const params={latitude:batch.map(p=>p.latitude).join(','),longitude:batch.map(p=>p.longitude).join(','),timezone:'Asia/Shanghai'};
  if(kind==='weather')Object.assign(params,{hourly:'temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,rain,snowfall',models:'ecmwf_ifs025',start_date:localDate(now),end_date:localDate(now+24*HOUR_MS),temperature_unit:'celsius',precipitation_unit:'mm'});
  else Object.assign(params,{hourly:'pm2_5',domains:'cams_global',forecast_hours:'48'});
  url.search=new URLSearchParams(params).toString();return url;
}
function replayFetch(place,kind,result,index,meta){
  return async input=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/static/meta.json'))return new Response(JSON.stringify(meta.data),{headers:meta.headers});
    if(Number(url.searchParams.get('latitude'))!==place.latitude||Number(url.searchParams.get('longitude'))!==place.longitude)throw Error('COORDINATE_MISMATCH');
    const expected=kind==='weather'?'api.open-meteo.com':'air-quality-api.open-meteo.com';
    if(url.hostname!==expected)throw Error('HOST_MISMATCH');
    return new Response(JSON.stringify(result.data[index]),{headers:result.headers});
  };
}
for(let offset=0;offset<pending.length;offset+=25){
  const batch=pending.slice(offset,offset+25);let now=Date.now();
  try{
    await waitUntilBudget(batch.length*2+2);now=Date.now();
    const wMeta=await getMeta('weather'),aMeta=await getMeta('air');
    const weather=await fetchJson(batchUrl('weather',batch,now),batch.length);
    await delay(600);
    const air=await fetchJson(batchUrl('air',batch,now),batch.length);
    for(const data of [weather,air]){
      if(!Array.isArray(data.data))data.data=[data.data];
      if(data.data.length!==batch.length)throw Object.assign(Error(),{code:'BATCH_LENGTH_MISMATCH'});
      data.data.forEach((row,index)=>{if(row.location_id!==undefined && row.location_id!==index)throw Object.assign(Error(),{code:'BATCH_ID_MISMATCH'});});
    }
    for(let i=0;i<batch.length;i++){
      const place=batch[i];
      try{
        const w=await getWeatherBrief({place,now,fetchImpl:replayFetch(place,'weather',weather,i,wMeta)});
        const a=await getAirQuality({place,now,fetchImpl:replayFetch(place,'air',air,i,aMeta)});
        const image=renderWeatherChart({date:w.date,cities:[place.id],places:[place],weather:[w],air:a,now});
        if(image.buffer.readUInt32BE(16)!==1200||image.buffer.readUInt32BE(20)!==1800)throw Error('RENDER_DIMENSIONS');
        const missingWeather=w.hourly.filter(p=>Object.values(p).includes(null)).length;
        const missingAir=a.hourly.filter(p=>p.pm25===null).length;
        const entry={id:place.id,name:place.name,status:'passed',weatherHours:w.hourly.length,airHours:a.hourly.length,missingWeather,missingAir,imageBytes:image.buffer.length};
        if(missingWeather||missingAir){entry.status='failed';entry.code='PARTIAL_SOURCE_DATA';}
        report.entries.push(entry);
        if(place.id==='beijing'||place.id==='guangzhou'||offset+i===0)await writeFile(new URL('../test-output/live-'+place.id.replace(/[^a-zA-Z0-9-]/g,'')+'.png',import.meta.url),image.buffer);
      }catch(error){report.entries.push({id:place.id,name:place.name,status:'failed',code:error.code??error.message??'VALIDATION_FAILED'});}
    }
  }catch(error){
    const code=error.code??(error.name==='TypeError'?'SOURCE_NETWORK_ERROR':error.name)??'SOURCE_UNAVAILABLE';
    if(['SOURCE_RATE_LIMITED','LOCAL_HOURLY_BUDGET','LOCAL_DAILY_BUDGET'].includes(code)){
      report.stoppedReason=code; for(const place of pending.slice(offset))report.entries.push({id:place.id,name:place.name,status:'not-run',code});await save();break;
    }
    for(const place of batch)report.entries.push({id:place.id,name:place.name,status:'failed',code});
  }
  await save();console.log(JSON.stringify({tested:report.passed+report.failed,total:report.total,passed:report.passed,failed:report.failed,units:report.chargedLocationUnits}));
  globalThis.gc?.();
  // 25 locations x 2 sources / >=6 seconds: <=500 location units per minute.
  await delay(Math.max(0,6000-(Date.now()-now)));
}
report.finishedAt=new Date().toISOString();await save();
console.log(JSON.stringify({file:'test-output/weather-catalog-live.json',passed:report.passed,failed:report.failed,notRun:report.notRun,stoppedReason:report.stoppedReason,qqMessagesSent:0}));
if(report.failed||report.notRun)process.exitCode=1;
