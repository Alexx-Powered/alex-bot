import test from 'node:test';
import assert from 'node:assert/strict';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {ScheduledMorningWeather,morningDataQuality} from '../src/morning-weather.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';
import {MorningReportService} from '../src/morning-report.mjs';

const date='2026-11-07',now=Date.parse(date+'T07:28:00+08:00'),start=Date.parse(date+'T00:00:00+08:00');
function sample(kind){
  return {city:{id:'beijing'},date,timezone:'Asia/Shanghai',...(kind==='weather'?{windBrief:['东风 1–2级','东风 1–2级'],weatherSummary:{date,code:0,icon:'sunny',label:'晴'}}:{}),hourly:Array.from({length:48},(_,i)=>({
    time:new Date(start+i*3600000).toISOString(),periodEnd:new Date(start+(i+1)*3600000).toISOString(),
    ...(kind==='air'?{pm25:20}:{temperatureC:12,humidityPct:60,precipitationMm:0,precipitationProbabilityPct:0,cloudCoverPct:20,
      windSpeedMs:1,windDirectionDeg:90,windGustMs:2,rainMm:0,weatherCode:0}),
  }))};
}
const fail=code=>Object.assign(Error(code),{code});
const scheduledWeather=options=>new ScheduledMorningWeather(new WeatherCommands(options));

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

test('unfilled scheduled PM2.5 gap is retried once, remains missing and is never drawn',async()=>{
  let airs=0,renders=0;const air=sample('air');air.hourly[12].pm25=null;
  const commands=scheduledWeather({now:()=>now,weather:async()=>sample('weather'),air:async()=>{airs++;return air;},weatherChart:()=>{renders++;}});
  const result=await commands.briefing({scheduledMorning:true,includeData:true});
  assert.equal(airs,2);assert.equal(result.ok,false);assert.equal(renders,0);assert.equal(result.image,undefined);
  assert.ok(result.morningQuality.missing.includes('air.pm25'));assert.equal(result.inputs.air.hourly[12].pm25,null);
});

test('scheduled persistent outage has at most two attempts per transient provider',async()=>{
  let weather=0,air=0;
  const commands=scheduledWeather({now:()=>now,weather:async()=>{weather++;throw fail('FORECAST_SOURCE_TIMEOUT');},air:async()=>{air++;throw fail('FORECAST_SOURCE_UNAVAILABLE');}});
  const result=await commands.briefing({scheduledMorning:true,renderImage:false});
  assert.equal(result.ok,false);assert.deepEqual(result.morningQuality.missing,['weather','air']);
  assert.equal(weather,2);assert.equal(air,2);
});

test('scheduled retry shrinks to the remaining shared acquisition budget',async t=>{
  let elapsed=0;const limits=[];
  t.mock.method(performance,'now',()=>elapsed);
  const commands=scheduledWeather({now:()=>now,weather:async args=>{
    limits.push(args.fetchTimeoutMs);
    if(limits.length===1){elapsed=80_000;throw fail('FORECAST_SOURCE_TIMEOUT');}
    return sample('weather');
  },air:async()=>sample('air')});
  const result=await commands.briefing({scheduledMorning:true,renderImage:false});
  assert.equal(result.ok,true);assert.deepEqual(limits,[45_000,15_000]);
});

test('invalid source metadata and rate limits do not trigger scheduled retries',async()=>{
  let weather=0,air=0;
  const commands=scheduledWeather({now:()=>now,weather:async()=>{weather++;throw fail('FORECAST_METADATA_INVALID');},air:async()=>{air++;throw fail('FORECAST_SOURCE_RATE_LIMITED');}});
  const result=await commands.briefing({scheduledMorning:true,renderImage:false});
  assert.equal(result.ok,false);assert.equal(weather,1);assert.equal(air,1);assert.deepEqual(result.morningQuality.retried,[]);
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
