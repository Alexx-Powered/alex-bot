import test from 'node:test';
import assert from 'node:assert/strict';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {ScheduledMorningWeather,morningDataQuality} from '../src/morning-weather.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';
import {MorningReportService} from '../src/morning-report.mjs';
import {createCalendarAirQuality,readCachedMorningGefs,selectMorningPm25,winterMorningPm25} from '../src/morning-pm25.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const date='2026-11-07',now=Date.parse(date+'T07:25:00+08:00'),start=Date.parse(date+'T00:00:00+08:00');
function sample(kind){
  return {city:{id:'beijing'},date,timezone:'Asia/Shanghai',...(kind==='weather'?{windBrief:['东风 1–2级','东风 1–2级'],weatherSummary:{date,code:0,icon:'sunny',label:'晴'}}:{}),hourly:Array.from({length:48},(_,i)=>({
    time:new Date(start+i*3600000).toISOString(),periodEnd:new Date(start+(i+1)*3600000).toISOString(),
    ...(kind==='air'?{pm25:20}:{temperatureC:12,humidityPct:60,precipitationMm:0,precipitationProbabilityPct:0,cloudCoverPct:20,
      windSpeedMs:1,windDirectionDeg:90,windGustMs:2,rainMm:0,weatherCode:0}),
  }))};
}
const fail=code=>Object.assign(Error(code),{code});
const scheduledWeather=options=>new ScheduledMorningWeather(new WeatherCommands(options));

test('winter compares aligned 48-hour means and reuses the selected series for outdoor scoring',async()=>{
  const cams=sample('air'),gefs=sample('air');
  cams.source={model:'cams_global'};
  gefs.source={model:'gefs_aerosols'};
  cams.hourly.forEach(row=>{row.pm25=100;});
  gefs.hourly.forEach((row,i)=>{row.pm25=i===6?120:20;});
  const weather=sample('weather');
  const service=new MorningReportService({now:()=>now,scheduledCommands:new ScheduledMorningWeather(
    new WeatherCommands({now:()=>now,weather:async()=>weather,air:async()=>cams}),{gefs:async()=>gefs}),
    chart:async({inputs,analysis})=>{
      assert.equal(inputs.air,gefs);
      assert.equal(inputs.air.hourly[6].pm25,120,'do not splice a lower CAMS point into the NOAA curve');
      assert.deepEqual(analysis.outdoorIndex.periods.map(period=>period.conditions.pm25Peak),[120,20]);
      return {buffer:Buffer.alloc(16),mimeType:'image/png'};
    }});
  assert.equal((await service.create({scheduledMorning:true})).pm25Source,'gefs_aerosols');
});

test('winter includes both season boundaries and accepts only complete, matching source candidates',async()=>{
  for(const day of ['2026-11-01','2026-12-31','2027-01-01','2027-03-31'])assert.equal(winterMorningPm25(day),true);
  for(const day of ['2026-10-31','2027-04-01'])assert.equal(winterMorningPm25(day),false);
  const args={date,city:'beijing'},cams=sample('air'),gefs=sample('air');
  const readCams=async()=>cams,readGefs=async()=>gefs;
  assert.equal(await selectMorningPm25(args,{cams:readCams,gefs:readGefs}),cams);
  assert.equal(await selectMorningPm25({...args,date:'2026-04-01'},{cams:readCams,gefs:()=>assert.fail('NOAA is off outside winter')}),cams);
  gefs.hourly[9].pm25=0;gefs.hourly[10].pm25=null;
  assert.equal(await selectMorningPm25(args,{cams:readCams,gefs:readGefs}),cams);
  gefs.hourly[10].pm25=0;
  assert.equal(await selectMorningPm25(args,{cams:async()=>{throw fail('FORECAST_SOURCE_TIMEOUT');},gefs:readGefs}),gefs);
  gefs.hourly[0].time=gefs.hourly[1].time;
  assert.equal(await selectMorningPm25(args,{cams:readCams,gefs:readGefs}),cams);
  assert.equal(await selectMorningPm25(args,{cams:readCams,gefs:async()=>{throw fail('FORECAST_SOURCE_TIMEOUT');}}),cams);
});

test('ordinary weather tool and scheduled reports share calendar source selection and outdoor inputs',async()=>{
  const cams=sample('air'),gefs=sample('air');
  cams.source={model:'cams_global'};
  gefs.source={model:'gefs_aerosols'};
  cams.hourly.forEach(row=>{row.pm25=100;});
  gefs.hourly.forEach(row=>{row.pm25=30;});
  const calls=[];
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const air=createCalendarAirQuality(undefined,{
    cams:async args=>{calls.push(['cams',args]);return cams;},
    gefs:async args=>{calls.push(['gefs',args]);return gefs;},
  });
  const commands=new WeatherCommands({now:()=>now,weather:async()=>sample('weather'),air,chart:()=>image,
    weatherChart:inputs=>{
      assert.equal(inputs.air,gefs);
      assert.deepEqual(inputs.outdoorIndex.periods.map(period=>period.conditions.pm25Peak),[30,30]);
      return image;
    }});
  assert.equal((await new WeatherToolbox(commands).execute('weather_image',{city:'北京'})).image,image);
  assert.deepEqual(calls.map(([name,args])=>[name,args.date,args.fetchTimeoutMs]),[
    ['cams',date,8000],['gefs',date,8000],
  ]);
  const scheduled=await new ScheduledMorningWeather(commands).briefing({includeData:true,renderImage:false});
  assert.equal(scheduled.inputs.air,gefs);
  assert.equal(scheduled.morningQuality.complete,true);
  assert.equal((await commands.handle('发 雾霾 北京')).image,image);
  assert.deepEqual(calls.map(([name])=>name),['cams','gefs','cams','gefs','cams']);
});

test('calendar cache serves exact 48-hour windows for both cities and accepts the old same-day cache',async t=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'alex-calendar-air-'));
  t.after(()=>fs.rm(home,{recursive:true,force:true}));
  const cache=path.join(home,'.private');
  await fs.mkdir(cache);
  const tomorrow='2026-11-08';
  const make=city=>({city,date,modelRunAt:'2026-11-06T12:00:00Z',fetchedAt:new Date(now).toISOString(),
    hourly:Array.from({length:72},(_,i)=>({time:new Date(start+i*3600000).toISOString(),pm25:i}))});
  const bundle={date,forecasts:{beijing:make('beijing'),tianjin:make('tianjin')}};
  const packet=path.join(cache,'morning-gefs-calendar.json');
  await fs.writeFile(packet,JSON.stringify(bundle));
  for(const city of ['beijing','tianjin']){
    const today=await readCachedMorningGefs({home,city,date,now});
    const later=await readCachedMorningGefs({home,city,date:tomorrow,now});
    assert.equal(today.city.id,city);
    assert.equal(later.city.id,city);
    assert.deepEqual(today.hourly.map(row=>row.pm25),Array.from({length:48},(_,i)=>i));
    assert.deepEqual(later.hourly.map(row=>row.pm25),Array.from({length:48},(_,i)=>i+24));
  }
  bundle.forecasts.beijing.hourly[30].pm25=null;
  await fs.writeFile(packet,JSON.stringify(bundle));
  const legacy={...make('beijing'),hourly:make('beijing').hourly.slice(0,48)};
  await fs.writeFile(path.join(cache,'morning-gefs-beijing.json'),JSON.stringify(legacy));
  assert.equal((await readCachedMorningGefs({home,city:'beijing',date,now})).hourly[30].pm25,30);
  await assert.rejects(readCachedMorningGefs({home,city:'beijing',date:tomorrow,now}),{code:'MORNING_PM25_UNAVAILABLE'});
});

test('morning scheduled path uses its isolated service while ordinary create keeps the original briefing',async()=>{
  let ordinaryCalls=0;const profiles=[],inputs={date,cities:['beijing'],weather:[sample('weather')],air:sample('air'),outdoorIndex:{status:'complete'}};
  const commands=new WeatherCommands({now:()=>now,weather:async args=>{profiles.push(args);return sample('weather');},air:async()=>sample('air')});
  commands.briefing=async args=>{ordinaryCalls++;assert.equal(args.scheduledMorning,undefined);return {date,cities:['beijing'],inputs};};
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const service=new MorningReportService({commands,now:()=>now,worker:{run:()=>assert.fail('Completed outdoor index is reused')},chart:async()=>image});
  const prepared=await service.create({scheduledMorning:true});
  assert.equal(prepared.image,image);assert.equal(prepared.morningQuality.complete,true);assert.equal(ordinaryCalls,0);
  assert.equal(profiles.length,1);assert.equal(profiles[0].scheduledMorning,true);
  assert.equal((await service.create()).image,image);assert.equal(ordinaryCalls,1);
});

test('scheduled retry fetches only the timed out provider and retains successful source',async()=>{
  const calls=[],weather=sample('weather'),air=sample('air');let airs=0;
  const commands=scheduledWeather({now:()=>now,weather:async args=>{calls.push(['weather',args]);return weather;},
    air:async args=>{calls.push(['air',args]);if(++airs===1)throw fail('FORECAST_SOURCE_TIMEOUT');return air;}});
  const result=await commands.briefing({renderImage:false,includeData:true,scheduledMorning:true});
  assert.equal(result.ok,true);assert.deepEqual(result.morningQuality,{complete:true,missing:[],retried:['air']});
  assert.equal(calls.filter(([kind])=>kind==='weather').length,1);assert.equal(airs,2);
  assert.ok(calls.every(([,args])=>args.scheduledMorning===true&&args.fetchTimeoutMs>15000&&args.fetchTimeoutMs<=45000));
  assert.equal(result.inputs.weather[0],weather);assert.equal(result.inputs.air,air);
});

test('scheduled preview can recover from a missing weather endpoint without re-fetching air',async()=>{
  const attempts=[];let air=0;
  const commands=scheduledWeather({now:()=>now,weather:async args=>{
    attempts.push(Boolean(args.backupSource));
    if(args.backupSource)throw Object.assign(fail('FORECAST_SOURCE_HTTP_ERROR'),{httpStatus:404});
    return sample('weather');
  },air:async()=>{air++;return sample('air');}});
  const result=await commands.briefing({renderImage:false});
  assert.deepEqual(attempts,[true,false]);
  assert.deepEqual(result.morningQuality,{complete:true,missing:[],retried:['weather']});
  assert.equal(air,1);
});

test('Visual Crossing is selected only for the explicit scheduled attempt and still requires complete data',async()=>{
  const weather=sample('weather'),air=sample('air');
  weather.hourly[0].precipitationProbabilityPct=null;
  const calls=[];
  const commands=new ScheduledMorningWeather(new WeatherCommands({now:()=>now,
    weather:async()=>{calls.push('primary');return sample('weather');},air:async()=>air}),{
    home:'unused',
    ecWeather:async args=>{calls.push('ec');assert.equal(args.home,'unused');assert.equal(args.city,'beijing');return weather;},
  });
  const selected=await commands.briefing({renderImage:false,retrySources:false,visualCrossingWeather:true});
  assert.equal(selected.ok,false);
  assert.equal(selected.retryable,true);
  assert.deepEqual(selected.morningQuality.missing,['weather.precipitationProbabilityPct']);
  assert.deepEqual(calls,['ec']);
  const ordinary=await commands.briefing({renderImage:false,retrySources:false});
  assert.equal(ordinary.ok,true);
  assert.deepEqual(calls,['ec','primary']);
});

test('unfilled scheduled PM2.5 gap is retried once, remains missing and is never drawn',async()=>{
  let airs=0,renders=0;const air=sample('air');air.hourly[12].pm25=null;
  const commands=scheduledWeather({now:()=>now,weather:async()=>sample('weather'),air:async()=>{airs++;return air;},weatherChart:()=>{renders++;}});
  const result=await commands.briefing({scheduledMorning:true,includeData:true});
  assert.equal(airs,2);assert.equal(result.ok,false);assert.equal(renders,0);assert.equal(result.image,undefined);
  assert.equal(result.retryable,true);
  assert.ok(result.morningQuality.missing.includes('air.pm25'));assert.equal(result.inputs.air.hourly[12].pm25,null);
});

test('scheduled persistent outage has at most two attempts per transient provider',async()=>{
  let weather=0,air=0;
  const commands=scheduledWeather({now:()=>now,weather:async()=>{weather++;throw fail('FORECAST_SOURCE_TIMEOUT');},air:async()=>{air++;throw fail('FORECAST_SOURCE_UNAVAILABLE');}});
  const result=await commands.briefing({scheduledMorning:true,renderImage:false});
  assert.equal(result.ok,false);assert.deepEqual(result.morningQuality.missing,['weather','air']);
  assert.equal(weather,2);assert.equal(air,2);
});

test('orchestrated preparation makes one request per source and flags temporary HTTP failure for a separate retry',async()=>{
  let weather=0,air=0;
  const commands=scheduledWeather({now:()=>now,weather:async()=>{
    weather++;throw Object.assign(fail('FORECAST_SOURCE_HTTP_ERROR'),{httpStatus:503});
  },air:async()=>{air++;throw fail('FORECAST_SOURCE_TIMEOUT');}});
  const result=await commands.briefing({renderImage:false,retrySources:false});
  assert.equal(result.ok,false);assert.equal(result.retryable,true);
  assert.deepEqual(result.morningQuality,{complete:false,missing:['weather','air'],retried:[]});
  assert.equal(weather,1);assert.equal(air,1);
  assert.equal(result.causeCode,'FORECAST_SOURCE_HTTP_ERROR');assert.equal(result.httpStatus,503);
});

test('scheduled retry shrinks to the remaining shared acquisition budget',async t=>{
  let elapsed=0;const limits=[];
  t.mock.method(performance,'now',()=>elapsed);
  const commands=scheduledWeather({now:()=>now,weather:async args=>{
    limits.push(args.fetchTimeoutMs);
    if(limits.length===1){elapsed=60_000;throw fail('FORECAST_SOURCE_TIMEOUT');}
    return sample('weather');
  },air:async()=>sample('air')});
  const result=await commands.briefing({scheduledMorning:true,renderImage:false});
  assert.equal(result.ok,true);assert.deepEqual(limits,[45_000,15_000]);
});

test('invalid source metadata and rate limits do not trigger scheduled retries',async()=>{
  let weather=0,air=0;
  const commands=scheduledWeather({now:()=>now,weather:async()=>{weather++;throw fail('FORECAST_METADATA_INVALID');},air:async()=>{air++;throw fail('FORECAST_SOURCE_RATE_LIMITED');}});
  const result=await commands.briefing({scheduledMorning:true,renderImage:false});
  assert.equal(result.ok,false);assert.equal(result.retryable,false);assert.equal(weather,1);assert.equal(air,1);assert.deepEqual(result.morningQuality.retried,[]);
});

test('ordinary weather keeps the single-attempt partial behavior and tool schema rejects profile injection',async()=>{
  let airs=0;const calls=[];
  const commands=new WeatherCommands({now:()=>now,weather:async args=>{calls.push(args);return sample('weather');},air:async args=>{calls.push(args);airs++;throw fail('FORECAST_SOURCE_TIMEOUT');}});
  const result=await commands.briefing({renderImage:false});
  assert.equal(airs,1);assert.equal(result.ok,true);assert.equal(result.morningQuality,undefined);
  assert.ok(calls.every(args=>!Object.hasOwn(args,'scheduledMorning')&&!Object.hasOwn(args,'fetchTimeoutMs')));
  await assert.rejects(new WeatherToolbox(commands,{}).execute('local_weather_briefing',{cities:['beijing'],scheduledMorning:true}));
});

test('morning readiness rejects wrong day, identity, hourly coverage and missing displayed data',()=>{
  const inputs={date,cities:['beijing'],weather:[sample('weather')],air:sample('air'),outdoorIndex:{status:'complete'}};
  assert.equal(morningDataQuality(inputs).complete,true);
  for(const edit of [v=>{v.weather[0].date='2026-11-06';},v=>{v.air.city.id='tianjin';},v=>{v.air.hourly[1].time=v.air.hourly[0].time;},v=>{v.weather[0].hourly[10].precipitationProbabilityPct=null;},v=>{v.outdoorIndex.status='unknown';},v=>{v.weather[0].weatherSummary=null;},v=>{v.weather[0].windBrief=null;}]){
    const changed=structuredClone(inputs);edit(changed);assert.equal(morningDataQuality(changed).complete,false);
  }
  // Solar radiation and apparent temperature are not prerequisites for the
  // current report's main data and custom outdoor index.
  assert.equal(morningDataQuality(inputs).complete,true);
});

test('partial winter comparison follows the source available at each calendar midnight',async()=>{
  const cams=sample('air'),gefs=sample('air');
  cams.source={model:'cams_global'};gefs.source={model:'gefs_aerosols'};
  cams.hourly.forEach((r,i)=>{r.pm25=i===24?null:5;});
  gefs.hourly.forEach((r,i)=>{r.pm25=i===0?null:10;});
  const query={window:'calendar',city:'beijing',partialWindow:true,now};
  const get=createCalendarAirQuality(undefined,{cams:async()=>cams,gefs:async()=>gefs});
  const result=await get(query);
  assert.equal(result.source.model,'daily_selection');
  assert.deepEqual(result.hourly.map(r=>r.pm25),[...Array(24).fill(5),...Array(24).fill(10)]);
  const outside=async()=>{throw Object.assign(Error(),{code:'FORECAST_OUTSIDE_WINDOW'});};
  const empty=createCalendarAirQuality(undefined,{cams:outside,gefs:outside});
  await assert.rejects(empty(query),{code:'FORECAST_OUTSIDE_WINDOW',sources:'CAMS / ECMWF、NOAA GEFS-Aerosols'});
  const failed=createCalendarAirQuality(undefined,{cams:outside,gefs:async()=>{throw Object.assign(Error(),{code:'FORECAST_SOURCE_TIMEOUT'});}});
  await assert.rejects(failed(query),{code:'FORECAST_SOURCE_TIMEOUT'});
});
