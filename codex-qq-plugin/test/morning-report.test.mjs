import test from 'node:test';
import assert from 'node:assert/strict';
import {MorningReportService} from '../src/morning-report.mjs';
import {morningPlan} from '../src/morning-calendar.mjs';
test('morning uses the calendar city, optional exercise fields, and no model or sending interface',async()=>{
  for(const date of ['2026-10-26','2026-05-01']){
    const now=Date.parse(date+'T08:00:00+08:00'),plan=morningPlan(now),calls=[];
    const inputs={weather:[{hourly:[]}],air:{hourly:[]}};
    const service=new MorningReportService({now:()=>now,commands:{briefing:async args=>{calls.push(args);return {date,cities:[plan.city],inputs};}},worker:{run:async(packet,execute,finish)=>{assert.equal(packet.type,'morning');assert.equal(packet.data.city,plan.city);assert.equal(packet.data.config,undefined);return finish({kind:'analysis',report:{date,city:plan.city,windows:[],recommendation:null}});}},chart:async({plan:p})=>({buffer:Buffer.from(p.city),mimeType:'image/png'})});
    const report=await service.create();assert.equal(report.cities[0],plan.city);assert.deepEqual(calls,[{cities:[plan.city],renderImage:false,includeData:true}]);assert.ok(Buffer.isBuffer(report.image.buffer));
  }
});
test('failed exercise analysis is labelled missing and never recommends a time',async()=>{
  const date='2026-10-26',service=new MorningReportService({now:()=>Date.parse(date+'T08:00:00+08:00'),commands:{briefing:async()=>({date,cities:['beijing'],inputs:{weather:[null],air:null}})},worker:{run:async()=>{throw Error('private backend error');}},chart:async args=>{assert.equal(args.analysis.recommendation,null);assert.match(args.analysis.summary,/未完成/);return {buffer:Buffer.alloc(8),mimeType:'image/png'};}});
  assert.match((await service.create()).analysis.title,/暂不可用/);
});

test('scheduled morning rejects incomplete weather before analysis or rendering',async()=>{
  const date='2026-10-26',quality={complete:false,missing:['air.pm25'],retried:['air']};let renders=0;
  const service=new MorningReportService({now:()=>Date.parse(date+'T07:28:00+08:00'),
    scheduledCommands:{briefing:async args=>{assert.equal(args.scheduledMorning,undefined);return {date,cities:['beijing'],morningQuality:quality};}},
    worker:{run:()=>assert.fail('No analysis of incomplete scheduled data')},chart:()=>{renders++;}});
  await assert.rejects(service.create({scheduledMorning:true}),error=>error.code==='MORNING_DATA_INCOMPLETE'&&error.morningQuality===quality);
  assert.equal(renders,0);
});

test('scheduled complete weather retains readiness detail with its prepared image',async()=>{
  const date='2026-10-26',quality={complete:true,missing:[],retried:['air']},image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const service=new MorningReportService({now:()=>Date.parse(date+'T07:28:00+08:00'),
    scheduledCommands:{briefing:async()=>({date,cities:['beijing'],morningQuality:quality,inputs:{weather:[{}],air:{},outdoorIndex:{status:'complete'}}})},
    worker:{run:()=>assert.fail('Existing outdoor index is reused')},chart:async()=>image});
  const result=await service.create({scheduledMorning:true});assert.equal(result.image,image);assert.deepEqual(result.morningQuality,quality);
});
