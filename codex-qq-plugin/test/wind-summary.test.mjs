import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeWind} from '../src/wind-summary.mjs';

test('real LangChain wind tool separates calendar days, handles north wrap and true calm',async()=>{
  const rows=Array.from({length:48},(_,i)=>({windSpeedMs:i<24?2:0,windDirectionDeg:i%2?359:1}));
  const result=await summarizeWind(rows);
  assert.match(result[0],/北风.*2\.0–2\.0 m\/s.*最高2级/);
  assert.match(result[1],/静风.*0\.0–0\.0 m\/s.*最高0级/);
});
test('missing wind stays missing and partial day is identified',async()=>{
  assert.equal(await summarizeWind(Array.from({length:48},()=>({windSpeedMs:null}))),null);
  const result=await summarizeWind([{windSpeedMs:5.5,windDirectionDeg:null}]);
  assert.match(result[0],/风向缺数据.*缺23小时/);assert.equal(result[1],'风速缺数据');
});
