import test from 'node:test';
import assert from 'node:assert/strict';
import {timeoutNotice} from '../src/timeout-notice.mjs';
import {WeatherCommands} from '../src/weather-commands.mjs';
test('timeout text contains only verified stage and duration, never upstream exception text',()=>{
  assert.match(timeoutNotice({reason:'MODEL_TIMEOUT',message:'SECRET key'}),/模型.*20秒/);
  assert.equal(timeoutNotice({code:'FORECAST_SOURCE_UNAVAILABLE'}),null);
  const notice=timeoutNotice({timedOut:true,timeoutMs:120000,stage:'buaa_classroom_query',message:'SECRET'});
  assert.match(notice,/校园.*120秒/);assert.doesNotMatch(notice,/SECRET/);
});
test('weather reports total source timeouts and attaches one notice to partial images',async()=>{
  const timed=Object.assign(Error('SECRET source'),{code:'FORECAST_SOURCE_TIMEOUT'}),image={buffer:Buffer.from('image'),mimeType:'image/png'};
  const service=new WeatherCommands({weather:async()=>{throw timed;},air:async()=>{throw timed;},weatherChart:()=>image});
  const failed=await service.handle('发天气北京');assert.match(failed.text,/超时.*15秒/);assert.equal(failed.image,undefined);
  service.air=async()=>({});const partial=await service.handle('发天气北京');
  assert.equal(partial.image,image);assert.equal(partial.richMedia,true);assert.match(partial.text,/北京天气.*超时/);assert.doesNotMatch(partial.text,/SECRET/);
});
