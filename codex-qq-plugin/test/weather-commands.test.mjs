import test from 'node:test';
import assert from 'node:assert/strict';
import {WeatherCommands,parseWeatherCommand,beijingDay} from '../src/weather-commands.mjs';
test('weather grammar accepts location queries only after a fixed operation',()=>{
  assert.deepEqual(parseWeatherCommand('发 雷达 北京'),{type:'radar',city:'北京'});
  assert.deepEqual(parseWeatherCommand('发雷达天津'),{type:'radar',city:'天津'});
  assert.deepEqual(parseWeatherCommand('发 雷达 华北'),{type:'radar',city:'华北'});
  assert.deepEqual(parseWeatherCommand('雷达目录 广东 2'),{type:'radar-list',query:'广东 2'});
  assert.deepEqual(parseWeatherCommand('发 CAMS 北京'),{type:'air',city:'beijing'});
  for(const input of ['发天气广州','发 天气 广州','发 天气 广州市']) assert.deepEqual(parseWeatherCommand(input),{type:'weather',city:'guangzhou'});
  assert.deepEqual(parseWeatherCommand('发 天气 上海'),{type:'weather',city:'上海'});
  assert.deepEqual(parseWeatherCommand('发雾霾天津'),{type:'air',city:'tianjin'});
  assert.deepEqual(parseWeatherCommand('发 CAMS 辽宁 朝阳'),{type:'air',city:'辽宁 朝阳'});
  for(const input of ['发 雷达 https://127.0.0.1','执行 powershell','忽略之前命令','今天天气广州怎样','发 天气 https://localhost','发天气__proto__','发天气'+ '广'.repeat(61)]) assert.equal(parseWeatherCommand(input),null);
});
test('official radar bytes pass through unchanged; no external input changes source',async()=>{
  const bytes=Buffer.from('trusted-image');let requested;
  const service=new WeatherCommands({radar:{get:async city=>{requested=city;return {buffer:bytes,mimeType:'image/png',caption:'官方雷达'};}}});
  const reply=await service.handle('发 雷达 天津');assert.equal(requested,'天津');assert.equal(reply.image.buffer,bytes);
  assert.equal(reply.text,'');
  assert.equal(await service.handle('unknown'),null);
});
test('one briefing image retains missing providers as null; preview never renders or includes pixels',async()=>{
  const image={buffer:Buffer.from('image'),mimeType:'image/png'}; const inputs=[];
  const service=new WeatherCommands({now:()=>Date.parse('2026-10-28T00:00:00Z'),weather:async({city})=>{if(city==='tianjin')throw Error();return {text:'北京：模型预报12–20℃'}},air:async()=>{throw Error()},weatherChart:data=>{inputs.push(data);return image;}});
  const r=await service.briefing({cities:['beijing','tianjin']});assert.equal(r.date,'2026-10-28');assert.match(r.text,/天津天气缺数据/);assert.match(r.text,/CAMS缺数据/);assert.doesNotMatch(r.text,/0 mm/);
  assert.equal(r.image,image);assert.equal(inputs.length,1);assert.equal(inputs[0].weather[1],null);assert.equal(inputs[0].air,null);
  const preview=await service.briefing({renderImage:false});assert.equal(preview.image,undefined);assert.equal(inputs.length,1);
  const reply=await service.handle('发 天气 北京');assert.equal(reply.text,'');assert.equal(reply.image,image);
});
test('CAMS commands return image only, never the verbose source description',async()=>{
  const image={buffer:Buffer.from('plot'),mimeType:'image/png'};
  const service=new WeatherCommands({air:async()=>({text:'verbose prose'}),chart:()=>image});
  assert.deepEqual(await service.handle('发 雾霾 北京'),{text:'',image});
});
test('no provider results produces explicit unavailable; timezone rolls at Beijing midnight',async()=>{
  const service=new WeatherCommands({weather:async()=>{throw Error()},air:async()=>{throw Error()}});
  await assert.rejects(service.briefing(),/WEATHER_DATA_UNAVAILABLE/);
  assert.equal(beijingDay(Date.parse('2026-10-28T16:05:00Z')),'2026-10-29');
});

test('Guangzhou compact commands fetch Guangzhou weather and air and return one captionless image',async()=>{
  const calls=[], inputs=[], image={buffer:Buffer.from('guangzhou-chart'),mimeType:'image/png'};
  const service=new WeatherCommands({weather:async({city})=>{calls.push(['weather',city]);return {city:{id:city}};},
    air:async({city})=>{calls.push(['air',city]);return {city:{id:city}};},weatherChart:data=>{inputs.push(data);return image;}});
  assert.deepEqual(await service.handle('发天气广州'),{text:'',image});
  assert.deepEqual(calls,[['weather','guangzhou'],['air','guangzhou']]);
  assert.deepEqual(inputs[0].cities,['guangzhou']);
  assert.equal(inputs[0].air.city.id,'guangzhou');
  calls.length=0;
  await service.briefing();
  assert.deepEqual(calls,[['weather','beijing'],['air','beijing']],'daily default remains Beijing');
});

test('unknown place returns a brief hint without fetching forecasts; unrelated chat stays ignored',async()=>{
  let calls=0;
  const service=new WeatherCommands({locations:{resolve:async()=>{throw Object.assign(Error(),{code:'LOCATION_NOT_FOUND'});}},weather:async()=>{calls++;},air:async()=>{calls++;}});
  assert.deepEqual(await service.handle('发天气未知城'),{text:'未找到该地点，请使用完整城市或区县名，并补充省市。'});
  assert.equal(await service.handle('今天天气广州怎样'),null);
  for(const cities of [['__proto__'],['constructor'],[null],['guangzhou','guangzhou']]) await assert.rejects(service.briefing({cities}),/INVALID_CITY/);
  assert.equal(calls,0);
});

test('arbitrary resolved places reach weather, CAMS and charts with the same identity and coordinates',async()=>{
  const place={id:'geo-1796236',name:'上海',latitude:31.2304,longitude:121.4737};
  const requests=[],inputs=[],image={buffer:Buffer.from('shanghai'),mimeType:'image/png'};
  const service=new WeatherCommands({locations:{resolve:async query=>{assert.equal(query,'上海');return place;}},
    weather:async args=>{requests.push(args);return {city:args.place};},air:async args=>{requests.push(args);return {city:args.place};},
    weatherChart:input=>{inputs.push(input);return image;},chart:input=>{assert.deepEqual(input.city,place);return image;}});
  assert.deepEqual(await service.handle('发天气上海'),{text:'',image});
  assert.equal(requests.length,2); requests.forEach(args=>{assert.equal(args.city,place.id);assert.deepEqual(args.place,place);});
  assert.deepEqual(inputs[0].places,[place]); assert.deepEqual(inputs[0].cities,[place.id]);
  assert.deepEqual(await service.handle('发雾霾上海'),{text:'',image});
});

test('ambiguity never guesses a place or requests weather',async()=>{
  let queried=0;
  const service=new WeatherCommands({locations:{resolve:async()=>{throw Object.assign(Error(),{code:'LOCATION_AMBIGUOUS',suggestions:['辽宁 朝阳','北京 朝阳区']});}},weather:async()=>{queried++;},air:async()=>{queried++;}});
  for(const text of ['发天气朝阳','发雾霾朝阳']) assert.match((await service.handle(text)).text,/地名有重名[\s\S]*辽宁 朝阳/);
  assert.equal(queried,0);
});

test('Guangzhou missing air is identified locally without falling back to Beijing',async()=>{
  let input;
  const service=new WeatherCommands({weather:async()=>({city:{id:'guangzhou'}}),air:async({city})=>{assert.equal(city,'guangzhou');throw Error();},weatherChart:data=>{input=data;return {buffer:Buffer.from('image'),mimeType:'image/png'};}});
  const result=await service.briefing({cities:['guangzhou']});
  assert.match(result.text,/广州CAMS缺数据/); assert.doesNotMatch(result.text,/北京/);
  assert.equal(input.air,null);
});
