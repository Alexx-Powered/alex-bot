import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
import {renderWeatherReportImage} from '../src/weather-report-image.mjs';
import {summarizeOutdoor,validOutdoorIndex} from '../src/outdoor-summary.mjs';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {MorningReportService} from '../src/morning-report.mjs';
import {ScheduledMorningWeather} from '../src/morning-weather.mjs';
import {WeatherAlertWorker} from '../src/weather-alert-worker.mjs';

function sample(date='2026-11-03') {
  const city='beijing',start=Date.parse(date+'T00:00:00+08:00');
  const weather={city:{id:city},date,timezone:'Asia/Shanghai',hourly:Array.from({length:48},(_,i)=>({
    time:new Date(start+i*3600000).toISOString(),cloudCoverPct:0,windSpeedMs:1,windGustMs:2,rainMm:0,weatherCode:0,
  }))};
  const air={city:{id:city},timezone:'Asia/Shanghai',hourly:weather.hourly.map(row=>({time:row.time,pm25:10}))};
  return {date,city,weather,air};
}

test('tomorrow advice uses 全天宜 and keeps the reason between the verdict and score on one line',async t=>{
  const context=Object.getPrototypeOf(createCanvas(1,1).getContext('2d'));
  const draw=context.fillText, labels=new Map();
  t.mock.method(context,'fillText',function(value,x,y,maxWidth){
    const width=Math.min(this.measureText(value).width,maxWidth??Infinity);
    const left=this.textAlign==='right'?x-width:this.textAlign==='center'?x-width/2:x;
    if(!labels.has(value))labels.set(value,{left,right:left+width,y});
    return draw.apply(this,arguments);
  });
  const input=sample(),now=Date.parse(input.date+'T00:00:00+08:00')-3600_000;
  for(const pm25 of [10,165,240]){
    for(const row of input.air.hourly)row.pm25=pm25;
    const index=await summarizeOutdoor({...input,warning:{hazards:[]}});
    labels.clear();
    await renderWeatherReportImage({inputs:{date:input.date,cities:[input.city],weather:[input.weather],air:input.air,now,outdoorIndex:index}});
    const reason=index.dailyDanger?.reasons[0]??index.recommendation.causes?.[0];
    const words=reason?['明天全天不宜户外活动',reason]:['明天','全天','宜户外活动'];
    const boxes=[...words,index.displayScore+' 分'].map(word=>{
      assert.ok(labels.has(word),word);
      return labels.get(word);
    });
    for(let i=1;i<boxes.length;i++){
      assert.equal(boxes[i].y,boxes[0].y);
      assert.ok(boxes[i-1].right<boxes[i].left);
    }
  }
});

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

test('a windy forecast with no air source reaches the card with a grade and no invented PM2.5 peak',async()=>{
  const input=sample();
  for(const row of input.weather.hourly)row.windSpeedMs=3.4;
  const result=await summarizeOutdoor({...input,air:null,warning:{hazards:[]}});
  assert.equal(result.grade,'excellent');
  assert.equal(result.score,97.5);
  assert.ok(result.periods.every(p=>p.conditions.pm25Peak===null));
  assert.ok(validOutdoorIndex(result,input.date,input.city));
});

test('report applies official reds independently of forecasts and deduplicates the pollution reason',async t=>{
  const input=sample();
  input.air.hourly.forEach(row=>row.pm25=230);
  t.mock.method(WeatherAlertWorker.prototype,'forReport',async(city,date)=>{
    assert.equal(city,input.city);assert.equal(date,input.date);return {hazards:['空气重污染','冰雹'],partial:false};
  });
  const commands=new WeatherCommands({now:()=>Date.parse(input.date+'T09:00:00+08:00'),
    weather:async()=>input.weather,air:async()=>input.air,radar:{}});
  const {inputs}=await commands.briefing({cities:['北京'],includeData:true,renderImage:false});
  assert.deepEqual(inputs.outdoorIndex.dailyDanger.reasons,['冰雹红色预警','重污染天气红色预警']);
  assert.equal(inputs.outdoorIndex.score,0);
  const morning=await new ScheduledMorningWeather(commands).briefing({cities:['北京'],renderImage:false,includeData:true,retrySources:false});
  assert.deepEqual(morning.inputs.outdoorIndex.dailyDanger,inputs.outdoorIndex.dailyDanger);
  const airOnly=await summarizeOutdoor({...input,weather:null,warning:{hazards:[]}});
  assert.ok(airOnly.dailyDanger.reasons[0].includes('220'));
  const redOnly=await summarizeOutdoor({...input,weather:null,air:null,warning:{hazards:['雷电'],partial:true}});
  assert.equal(redOnly.score,0);assert.equal(redOnly.warningPartial,true);
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
