import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeWind,summarizeWeather} from '../src/wind-summary.mjs';

test('real LangChain wind tool separates calendar days, handles north wrap and true calm',async()=>{
  const rows=Array.from({length:48},(_,i)=>({windSpeedMs:i<24?2:0,windDirectionDeg:i%2?359:1,windGustMs:i<24?8:0}));
  const result=await summarizeWind(rows);
  assert.match(result[0],/北风.*2–2级.*阵风最大5级/);
  assert.match(result[1],/静风.*0–0级.*阵风最大0级/);
});
test('missing wind stays missing and partial day is identified',async()=>{
  assert.equal(await summarizeWind(Array.from({length:48},()=>({windSpeedMs:null}))),null);
  const result=await summarizeWind([{windSpeedMs:5.5,windDirectionDeg:null}]);
  assert.match(result[0],/风向缺数据.*缺23小时/);assert.equal(result[1],'风速缺数据');
});

test('real combined LangChain worker returns weather even when wind is absent, with the requested date',async()=>{
  const rows=Array.from({length:48},()=>({windSpeedMs:null}));
  const result=await summarizeWeather(rows,{date:'2026-11-04',weatherCode:65});
  assert.deepEqual(result.weatherSummary,{date:'2026-11-04',code:65,icon:'heavy-rain',label:'大雨'});
  assert.deepEqual(result.windBrief,['风速缺数据','风速缺数据']);
  assert.deepEqual(await summarizeWeather(rows,{date:'2026-11-04'}),{windBrief:null,weatherSummary:null});
});
