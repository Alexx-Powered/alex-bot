import test from 'node:test';
import assert from 'node:assert/strict';
import {RadarRouter} from '../src/global-radar.mjs';
import {parseWeatherCommand,WeatherCommands} from '../src/weather-commands.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';

test('China radar stays preferred; absence falls back globally; ambiguity and invalid sources do not',async()=>{
  let calls=0;const domestic={get:async()=>({domestic:true}),list:async()=>({text:'目录'})},global={get:async target=>{calls++;return {target,global:true};},close(){}};
  const radar=new RadarRouter({domestic,global});assert.equal((await radar.get('北京')).domestic,true);assert.equal(calls,0);
  domestic.get=async()=>{throw {code:'NOT_FOUND'};};assert.equal((await radar.get('东京')).global,true);assert.equal(calls,1);
  domestic.get=async()=>{throw {code:'RADAR_STALE'};};assert.equal((await radar.get('北京')).global,true);
  domestic.get=async()=>{throw {code:'AMBIGUOUS_TARGET'};};await assert.rejects(radar.get('广东'),e=>e.code==='AMBIGUOUS_TARGET');
  assert.equal((await radar.get('纽约',{source:'global'})).global,true);
  await assert.rejects(radar.get('北京',{source:'http://localhost'}));assert.equal((await radar.list()).text,'目录');
});
test('explicit global commands and optional source flow through the existing bounded tool',async()=>{
  assert.deepEqual(parseWeatherCommand('发全球雷达 东京'),{type:'radar',city:'东京',source:'global'});
  assert.deepEqual(parseWeatherCommand('全球雷达图'),{type:'radar',city:'全球',source:'global'});
  let selected;const radar={get:async(target,options)=>{selected={target,...options};return {global:true,buffer:Buffer.from('png'),mimeType:'image/png',caption:'来源 RainViewer'};}};
  const commands=new WeatherCommands({radar});const tools=new WeatherToolbox(commands,{});
  const response=await tools.execute('radar_image',{target:'东京',source:'global'});
  assert.deepEqual(selected,{target:'东京',source:'global'});assert.equal(response.richMedia,true);assert.match(response.text,/RainViewer/);
  await assert.rejects(tools.execute('radar_image',{target:'东京',url:'https://evil.test'}));
});
