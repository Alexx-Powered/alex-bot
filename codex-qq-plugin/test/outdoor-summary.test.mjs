import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeOutdoor,validOutdoorIndex} from '../src/outdoor-summary.mjs';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {MorningReportService} from '../src/morning-report.mjs';

function sample(date='2026-11-03') {
  const city='beijing',start=Date.parse(date+'T00:00:00+08:00');
  const weather={city:{id:city},date,timezone:'Asia/Shanghai',hourly:Array.from({length:48},(_,i)=>({
    time:new Date(start+i*3600000).toISOString(),cloudCoverPct:0,windSpeedMs:1,windGustMs:2,rainMm:0,weatherCode:0,
  }))};
  const air={city:{id:city},timezone:'Asia/Shanghai',hourly:weather.hourly.map(row=>({time:row.time,pm25:10}))};
  return {date,city,weather,air};
}

test('real LangChain bridge scores first day and rejects mismatched or incomplete air',async()=>{
  const input=sample(),result=await summarizeOutdoor(input);
  assert.equal(result.status,'complete');assert.equal(result.gold,true);assert.equal(result.character,'夯');
  assert.equal(validOutdoorIndex(result,input.date,input.city),true);
  for(const row of input.air.hourly.slice(24))row.pm25=500;
  assert.equal((await summarizeOutdoor(input)).score,result.score);
  input.air.hourly=input.air.hourly.slice(0,8);
  assert.equal((await summarizeOutdoor(input)).status,'unknown');
  input.air.city.id='guangzhou';assert.equal((await summarizeOutdoor(input)).status,'unknown');
  assert.equal(validOutdoorIndex({...result,date:'2026-11-04'},input.date,input.city),false);
});

test('normal tomorrow query and morning report use the new tool without the old exercise worker',async()=>{
  const input=sample('2026-11-04'),calls=[];
  const commands=new WeatherCommands({now:()=>Date.parse('2026-11-03T08:00:00+08:00'),
    locations:{resolve:async()=>({id:'beijing',name:'北京'})},radar:{},
    weather:async args=>{calls.push(args);return input.weather;},air:async()=>input.air,
    weatherChart:inputs=>{assert.equal(inputs.outdoorIndex.date,'2026-11-04');assert.equal(inputs.outdoorIndex.gold,true);return {buffer:Buffer.from('png')};}});
  const brief=await commands.briefing({cities:['北京'],day:'tomorrow',includeData:true});
  assert.equal(calls[0].exerciseFields,true);assert.equal(calls[0].day,'tomorrow');
  const service=new MorningReportService({now:()=>Date.parse('2026-11-04T07:30:00+08:00'),
    commands:{briefing:async()=>brief},worker:{run:async()=>{throw Error('old exercise worker must not run');}},
    chart:async({inputs,analysis})=>{assert.equal(analysis.outdoorIndex,inputs.outdoorIndex);return {buffer:Buffer.from('png')};}});
  const result=await service.create();assert.equal(result.analysis.outdoorIndex.gold,true);
});
