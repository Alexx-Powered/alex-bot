import test from 'node:test';
import assert from 'node:assert/strict';
import {parseWeatherCommand,WeatherCommands} from '../src/weather-commands.mjs';
import {parseGroupWake,DEFAULT_WAKE_WORDS} from '../src/wake-words.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';
import {validVideo} from '../src/video-media.mjs';
import {validVideoTimeline,videoRegion,WeatherVideoService} from '../src/weather-video.mjs';
import {checkChatInput} from '../src/chat-safety.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const bytes=Buffer.alloc(64);bytes.writeUInt32BE(24);bytes.write('ftypisom',4);const video={buffer:bytes,mimeType:'video/mp4'};
test('recent clips are reused across queries, bounded, isolated and fresh',async t=>{
 const home=await mkdtemp(join(tmpdir(),'alex-wx-video-cache-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const dir=join(home,'.private','weather-video');await mkdir(dir,{recursive:true});
 let now=Date.UTC(2026,10,4,8,57,0),renders=0,detail;
 const worker={async run({args}){
   const artifact=(++renders).toString(16).padStart(32,'0');
   await writeFile(join(dir,artifact+'.mp4'),bytes);
   const start=Math.ceil(now/3600000)*3600, hours=args.hours||24;
   return {ok:true,artifact_id:artifact,bytes:bytes.length,layer:args.layer,generated_at:Math.floor(now/1000),
     format_version:2,width:1080,height:1080,fps:12,start,end:start+(hours-1)*3600,frames:hours===24?139:142,
     source_times:Array.from({length:hours},(_,i)=>start+3600*i),forecast_detail:detail};
 },close(){}};
 const service=new WeatherVideoService({worker,home,now:()=>now});
 const get=(id,hours=24)=>service.get('temperature',{id,name:id,latitude:32,longitude:118},hours);
 const a=await get('A');a.video.buffer.fill(0);
 await get('B');await get('A',48);await get('C');
 assert.deepEqual((await get('A')).video.buffer,bytes);
 await get('D');await get('A',48);assert.equal(renders,5);
 await get('B');assert.equal(renders,6); // B was the least recently used.
 now=Date.UTC(2026,10,4,9,0,1);
 await get('B');assert.equal(renders,7); // New forecast window, within five minutes.
 now+=300001;await get('B');assert.equal(renders,8);
 detail='sampled';await get('F');await get('F');assert.equal(renders,10);
 detail='native';await get('F');await get('F');assert.equal(renders,11);
 service.close();
});
test('HD source times are distinct from encoded frames, missing observations cut directly, legacy packets still work',()=>{
 const end=1793718000;const full=Array.from({length:37},(_,i)=>end-(36-i)*600);const times=full.filter((_,i)=>i!==15);
 const hd={format_version:2,width:1080,height:1080,fps:12,start:full[0],end,generated_at:end+300,source_times:times,frames:138};
 assert.equal(validVideoTimeline(hd,'cloud'),true);assert.equal(validVideoTimeline({...hd,frames:141},'cloud'),false);
 assert.equal(validVideoTimeline({...hd,source_times:times.toReversed()},'cloud'),false);
 const forecast={...hd,start:end,end:end+23*3600,generated_at:end-120,source_times:Array.from({length:24},(_,i)=>end+i*3600),frames:139};
 assert.equal(validVideoTimeline(forecast,'temperature'),true);assert.equal(validVideoTimeline({...forecast,frames:24},'temperature'),false);
 assert.equal(validVideoTimeline({width:720,height:720,frames:13,start:end-21600,end},'cloud'),true);
});
test('four video commands parse without stealing existing weather commands',()=>{
 assert.deepEqual(parseWeatherCommand('发 历史云图 南京'),{type:'video',layer:'cloud',city:'南京'});
 for(const [kind,layer] of [['云图','cloud_cover'],['PM2.5','pm25'],['降水','precipitation'],['温度','temperature']]){
  assert.deepEqual(parseWeatherCommand('发 动态'+kind+' 广州'),{type:'video',layer,city:'广州'});
  assert.equal(parseWeatherCommand('发 '+kind+' 珠峰').type,'video');
 }
 assert.equal(parseWeatherCommand('发 天气 广州').type,'weather');assert.equal(parseWeatherCommand('动态温度 https://bad.invalid'),null);
});
test('video requests resolve the existing place and return no text',async()=>{
 const calls=[];const c=new WeatherCommands({videos:{get:async(layer,place)=>{calls.push({layer,place});return {text:'',video}}}});
 const toolbox=new WeatherToolbox(c,{run:()=>assert.fail('no model/outer worker')});
 const r=await toolbox.handle('发 动态温度 珠峰');assert.equal(r.text,'');assert.equal(r.video,video);assert.equal(calls[0].place.latitude,27.9880614);
});
test('QQ fixed commands preserve forecast, satellite and requested duration',async()=>{
 const calls=[];
 const commands=new WeatherCommands({videos:{get:async(layer,place,hours=24)=>{calls.push([layer,hours]);return {text:'',video};}}});
 const toolbox=new WeatherToolbox(commands,{run:()=>assert.fail('unexpected worker')});
 for(const text of ['发 云图 南京','发 历史云图 南京','发 48h动态pm2.5 北京'])
   assert.equal((await toolbox.handle(text)).video,video);
 assert.deepEqual(calls,[['cloud_cover',24],['cloud',24],['pm25',48]]);
});
test('the group commands in the screenshots keep the duration out of both city and region lookup',async()=>{
 const calls=[];
 const commands=new WeatherCommands({videos:{get:async(layer,place,hours)=>{calls.push([layer,place.regionId??place.id,hours]);return {text:'',video};}}});
 const toolbox=new WeatherToolbox(commands,{run:()=>assert.fail('fixed command invoked a model')});
 for(const place of ['北京','华北']){
   const wake=parseGroupWake('大肥鱼 发 动态云图48h '+place,false,DEFAULT_WAKE_WORDS);
   assert.ok(wake.addressed);assert.equal((await toolbox.handle(wake.command)).video,video);
 }
 assert.deepEqual(calls,[['cloud_cover','beijing',48],['cloud_cover','cn-north',48]]);
 for(const [kind,layer] of [['云图','cloud_cover'],['PM2.5','pm25'],['降水','precipitation'],['温度','temperature']]){
   for(const t of ['发 48h动态'+kind+' 北京','发 动态'+kind+' ４８Ｈ 北京','发 动态'+kind+'48h北京','发 动态'+kind+'48小时 北京','发 动态'+kind+' 北京 48h']){
     assert.deepEqual(parseWeatherCommand(t),{type:'video',layer,city:'北京',hours:48});
   }
 }
 assert.deepEqual(parseWeatherCommand('发 动态温度24h 北京'),{type:'video',layer:'temperature',city:'北京'});
 assert.equal(parseWeatherCommand('发 动态温度 24小时书店').city,'24小时书店');
 for(const input of ['发 动态云图72h 北京','发 24h动态云图48h 北京'])assert.match((await toolbox.handle(input)).text,/24 或 48/);
 assert.match((await toolbox.handle('发 动态云图48h')).text,/补充地点/);
 assert.equal(calls.length,2);
});
test('video regions use exact aliases and a separate cache identity from point requests',async()=>{
 for(const [name,id] of [['华北','cn-north'],['华东地区','cn-east'],['整个西藏','cn-54'],['新疆维吾尔自治区','cn-65'],['北京市全域','cn-11']]){
  assert.equal(videoRegion(name).regionId,id);
 }
 for(const name of ['乌鲁木齐','新疆乌鲁木齐','吉林市','北京','北京市','华北海道'])assert.equal(videoRegion(name),null);
 const seen=[];
 const cmd=new WeatherCommands({locations:{resolve:async q=>{seen.push(q);return {id:'town',name:q,latitude:43,longitude:87}}},
   videos:{get:async(layer,place)=>({text:'',video,target:place.id})}});
 assert.equal((await cmd.handle('发 动态降水 华东地区')).target,'region:cn-east');
 assert.equal((await cmd.handle('发 动态降水 新疆乌鲁木齐')).target,'town');assert.deepEqual(seen,['新疆乌鲁木齐']);
});
test('region requests reject a point video before reading its media and never retry as a city',async()=>{
 const now=Date.now();const start=Math.ceil(now/3600000)*3600;const calls=[];
 const data={ok:true,format_version:2,layer:'temperature',artifact_id:'a'.repeat(32),generated_at:Math.floor(now/1000),
  width:1080,height:1080,fps:12,start,end:start+23*3600,source_times:Array.from({length:24},(_,i)=>start+i*3600),frames:139};
 const worker={run:async(packet)=>{calls.push(packet.args);return data},close(){}};
 const service=new WeatherVideoService({worker,now:()=>now});const region=videoRegion('新疆');
 await assert.rejects(service.get('temperature',region),/VIDEO_RESULT_INVALID/);
 data.region_id='cn-65';data.view_bounds=[86,42,89,45];
 const cmd=new WeatherCommands({videos:service,locations:{resolve:()=>assert.fail('city lookup')}});
 assert.match((await cmd.handle('发 动态温度 新疆')).text,/暂不可用/);
 assert.deepEqual(calls,[{layer:'temperature',name:'新疆',region_id:'cn-65'},{layer:'temperature',name:'新疆',region_id:'cn-65'}]);
});
test('PM2.5 obeys air switch; other video layers obey weather switch before generation',async()=>{
 let generated=0;const a=new ConversationAgent({toolbox:{handle:async()=>{generated++;return {text:'',video}}},modelBudget:{acquire:()=>assert.fail()},configStore:{read:()=>assert.fail()}});
 for(const cmd of ['发 动态云图 广州','发 动态云图48h 华北','发 动态温度 广州','发 动态降水 广州','发 动态PM2.5 广州']){
  const r=await a.handle(cmd,{scope:'group',access:'white',features:{...defaultGroupFeatures('white'),weather:false,air:false}});assert.equal(r.video,undefined);
 }
 assert.equal(generated,0);
 const r=await a.handle('发 动态PM2.5 广州',{scope:'group',access:'white',features:{...defaultGroupFeatures('white'),weather:false}});assert.equal(r.video,video);assert.equal(r.requiredFeature,'air');assert.equal(generated,1);
});
test('video bytes reject URLs, file paths, wrong signatures and oversized buffers',()=>{
 assert.equal(validVideo(video),true);
 for(const value of [{url:'https://example.com/a.mp4'}, {...video,path:'x'}, {...video,mimeType:'image/png'}, {buffer:Buffer.alloc(64),mimeType:'video/mp4'},{buffer:Buffer.alloc(5*1024*1024),mimeType:'video/mp4'}])assert.equal(validVideo(value),false);
});
test('weather video generation reaches natural-language tools without accepting video attachments',()=>{
 for(const text of ['看看广州温度变化视频','给我北京的PM2.5预报视频','看看成都的动态云图'])assert.equal(checkChatInput(text).ok,true,text);
 for(const text of ['看看这段温度视频','分析广州温度视频','看看广州温度视频 https://example.com/a.mp4','读取上传的降水视频','看广州温度视频附件'])assert.equal(checkChatInput(text).reason,'CHAT_INPUT_ATTACHMENT',text);
});
