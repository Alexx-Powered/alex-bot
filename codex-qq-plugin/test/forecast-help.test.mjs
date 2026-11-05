import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareHelpContent} from '../src/help-image.mjs';
import {parseWeatherCommand} from '../src/weather-commands.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';

test('hidden tools stay out of help including the generic enabled-feature fallback',()=>{
  for(const privateChat of [true,false]){
    for(const features of [defaultGroupFeatures('white'),{budget:true}]){
      const content=prepareHelpContent({features,privateChat,words:['大肥鱼']});
      assert.doesNotMatch(JSON.stringify(content),/生活费|预算|发薪|budget/);
    }
  }
});

test('the forecast examples in /help execute under the same group switches',()=>{
  const layers = features => prepareHelpContent({features,privateChat:true}).weather
    .map(row=>parseWeatherCommand(row.command)).filter(cmd=>cmd?.type==='video')
    .map(cmd=>[cmd.layer,cmd.hours ?? 24]);
  assert.deepEqual(layers({weather:true}),[['cloud_cover',24],['cloud',24],['temperature',48],['precipitation',24]]);
  assert.deepEqual(layers({air:true}),[['pm25',24]]);
  assert.deepEqual(layers({radar:true}),[]);
  const group=prepareHelpContent({features:{weather:true,air:true},words:['小瘦鱼']});
  assert.ok(group.weather.every(row=>row.command.startsWith('小瘦鱼 ')));
  assert.doesNotMatch(JSON.stringify(group.weather),/分辨率|\d+\s*(?:km|公里)|\d\.\d+°/u);
});
