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

test('help omits marked rows and account balances, and lists AI status providers once',()=>{
  const content=prepareHelpContent({features:defaultGroupFeatures('white'),privateChat:true});
  assert.doesNotMatch(JSON.stringify(content),/发 空气|雷达目录|实时预警|徒步|记忆|余额/);
  const radar=content.weather.find(row=>row.tag==='支持全球');
  assert.equal(radar.command,'发 雷达 华北');
  assert.deepEqual(parseWeatherCommand(radar.command),{type:'radar',city:'华北'});

  const serviceRows=content.utilities.filter(row=>row.group==='AI 服务');
  assert.equal(serviceRows.length,1);
  assert.equal(serviceRows[0].command,'查 OpenAI 状态');
  assert.equal(serviceRows[0].detail,'支持 OpenAI、DeepSeek、Gemini、Claude、Kimi');
  const statusOnly=prepareHelpContent({features:{status:true},privateChat:true});
  assert.deepEqual(statusOnly.utilities[0],serviceRows[0]);
  const balanceOnly=prepareHelpContent({features:{balance:true},privateChat:true});
  assert.deepEqual(balanceOnly.utilities,[]);
  assert.deepEqual(balanceOnly.extra,[]);
  assert.deepEqual(balanceOnly.examples,[]);
});

test('help examples draw from all enabled two-character wake words',()=>{
  const words=['梁圣','大肥鱼','梁祖','梁嗨','小难梁','梁子','梁神','牢梁'];
  const short=words.filter(word=>word.length===2);
  const features={weather:true,radar:true,air:true,status:true,balance:true};
  const content=prepareHelpContent({features,words},()=>0.999);
  const prefixes=content.weather.map(row=>row.command.split(' ')[0]);
  assert.deepEqual(prefixes.slice(0,short.length),short.toReversed());
  for (const example of [...content.examples,...content.utilities.map(row=>row.command)]) {
    assert.ok(short.includes(example.split(' ')[0]));
  }
  assert.equal(prepareHelpContent({features}).weather[0].command,'@机器人 发 云图 南京');
});
