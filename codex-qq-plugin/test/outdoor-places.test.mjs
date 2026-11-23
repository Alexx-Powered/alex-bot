import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {LocationService} from '../src/locations.mjs';
import {searchOutdoorPlaces} from '../src/outdoor-places.mjs';
const fail=()=>{throw Error('must not query')};
test('weather selects the exact attraction ahead of a partial match and preserves its coordinates',async()=>{
 const rows=[{id:'osm-n-100',name:'样本峰步道',latitude:30,longitude:110},{id:'osm-n-101',name:'河北·样本峰',latitude:41.1,longitude:115.2}];
 const service=new LocationService({preferBest:true,fetchImpl:fail,outdoorLookup:async()=>rows});
 assert.deepEqual(await service.resolve('样本峰'),rows[1]);
 assert.deepEqual(await service.resolve('样本峰'),rows[1]);
});
test('known mountains and trail use explicitly labelled local representative coordinates',async()=>{
 const service=new LocationService({fetchImpl:fail,outdoorLookup:fail});
 for(const q of ['珠峰','武功山','华山','四姑娘山','北京 香山','麦理浩径']){
  const p=await service.resolve(q);assert.ok(p.latitude>20&&p.latitude<41);assert.ok(p.longitude>80&&p.longitude<120);
  assert.deepEqual(await service.resolve(`${p.name}（${p.id}）`),p);
 }
 assert.match((await service.resolve('麦理浩径')).name,/北潭涌代表点/);
 assert.equal((await service.resolve('海淀区')).id,'qweather-101010200');
 await assert.rejects(service.resolve('雨崩'),{code:'LOCATION_AMBIGUOUS'});
});
test('village crosses Node to real LangChain tool, then cache and stable candidate selection',async()=>{
 let calls=0;const service=new LocationService({fetchImpl:fail,outdoorLookup:q=>{calls++;return searchOutdoorPlaces(q,{workerPath:fileURLToPath(new URL('./fixtures/outdoor-places-worker.py',import.meta.url))})}});
 const [a,b]=await Promise.all([service.resolve('措玉村'),service.resolve('措玉村')]);
 assert.deepEqual(a,b);assert.equal(a.longitude,90.7924176);assert.match(a.name,/洛扎县/);
 assert.deepEqual(await service.resolve(a.id),a);assert.equal(calls,1);
});
test('POI failure and empty result never fall back to a similarly named county',async()=>{
 for(const outdoorLookup of [async()=>[],async()=>{throw Object.assign(Error(),{code:'LOCATION_SOURCE_UNAVAILABLE'})}]){
  const s=new LocationService({fetchImpl:fail,outdoorLookup});await assert.rejects(s.resolve('未知村'));
 }
});
test('generic missing city uses supplemental search; ambiguous dynamic IDs remain selectable',async()=>{
 const rows=[{id:'osm-n-1',name:'甲省·甲村',latitude:30,longitude:110},{id:'osm-n-2',name:'乙省·甲村',latitude:31,longitude:111}];
 const s=new LocationService({outdoorLookup:async()=>rows,fetchImpl:async()=>new Response(JSON.stringify({results:[]}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(s.resolve('甲村'),e=>e.code==='LOCATION_AMBIGUOUS'&&e.suggestions.length===2);
 assert.deepEqual(await s.resolve('乙省·甲村（osm-n-2）'),rows[1]);
});

test('weather briefing passes peak coordinates unchanged to both weather and air providers',async()=>{
 const {WeatherCommands}=await import('../src/weather-commands.mjs');const calls=[];
 const commands=new WeatherCommands({locations:new LocationService({fetchImpl:fail,outdoorLookup:fail}),radar:{close(){}},weather:async a=>{calls.push(a);return {hourly:[]}},air:async a=>{calls.push(a);return {}},weatherChart:()=>({buffer:Buffer.from('png')})});
 const result=await commands.briefing({cities:['珠峰'],renderImage:false});
 assert.equal(calls.length,2);for(const c of calls){assert.equal(c.place.latitude,27.9880614);assert.equal(c.place.longitude,86.92521);}
 assert.match(result.locationNote,/代表坐标/);
});
