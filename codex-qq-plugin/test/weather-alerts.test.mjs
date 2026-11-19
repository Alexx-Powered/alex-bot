import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BridgeCore} from '../src/core.mjs';
import {WeatherAlertsService,WeatherAlertWorker} from '../src/weather-alerts.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';
import {renderWeatherAlert} from '../src/weather-alert-image.mjs';
import {QQAdapter} from '../src/qq-adapter.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const area={code:'110108',name:'北京市·海淀',province:'北京市',level:'district'};
const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
const warning=(n=1)=>({id:'11010841600000_20261108003000',series:'11010841600000:p0007',fingerprint:hash('alert'+n),code:area.code,
  headline:'海淀区气象台发布大风蓝色预警',description:'预计未来6小时有大风，请注意防范。',title:'北京市海淀区发布大风蓝色预警',
  color:'蓝色',severity:1,issuer:'海淀区气象台',hazard:'大风',publishedAt:'2026-11-08T00:30:00+08:00',checkedAt:'2026-11-08T01:00:00+08:00',
  effective:'2026/11/08 02:00',level:'区县级',province:'北京市',matches:[{area,relation:'本地'}],provinceContext:[],change:n===1?'新增':'升级'});

async function setup({render=async()=>image,send}={}){
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'alex-warnings-')),messages=[];let now=Date.parse('2026-11-08T01:00:00+08:00');
  let state={version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:[{id:'group',name:'test group',enabled:true,features:{...defaultGroupFeatures('white'),chat:false}}],grayGroups:[]};
  let service,number=1,fetches=0,failed=false;
  const core=new BridgeCore({loadState:async()=>state,saveState:async s=>{state=structuredClone(s);},now:()=>now,
    send:send|| (async r=>{messages.push(r);return {ok:true};}),commandHandler:(t,c)=>service.handle(t,c)});
  await core.init();
  const worker={async run(p){if(p.action==='poll'){fetches++;return failed?{ok:false,code:'ALERT_SOURCE_UNAVAILABLE'}:{ok:true,schema:'weather.alerts.v1',alerts:[warning(number)],sourceCount:1,checkedAt:new Date(now).toISOString()};}
    return {ok:true,operation:p.query?.includes('关闭')?'disable':p.query==='/实时预警'?'list':'enable',area};},close(){}};
  service=new WeatherAlertsService({home,core,worker,adapter:{status:()=>({state:'connected'})},render,now:()=>now});
  const target=core.weatherAlertTargets()[0];
  return {home,core,service,worker,target,messages,get fetches(){return fetches;},advance:()=>{number++;now+=61000;},fail:()=>{failed=true;},
    async close(){service.close();await fs.rm(home,{recursive:true,force:true});}};
}

test('real Node → Python → LangChain resolves commands without model configuration',async()=>{
  const w=new WeatherAlertWorker();try{
    const r=await w.run({action:'command',query:'/开启实时预警 北京海淀'});assert.equal(r.ok,true);assert.equal(r.area.code,'110108');
    const list=await w.run({action:'search',query:'海淀'});assert.equal(list.suggestions[0].code,'110108');
  }finally{w.close();}
});
test('unsubscribed is idle, subscribe sends once, restart keeps dedup, then update sends once',async()=>{
  const a=await setup();try{
    assert.equal((await a.service.poll()).code,'ALERT_IDLE');assert.equal(a.fetches,0);
    await a.service.configure({targetKey:a.target.key,operation:'add',query:'北京海淀'});
    assert.equal((await a.service.poll()).sent,1);assert.equal((await a.service.poll()).sent,0);assert.equal(a.messages.length,1);
    const second=new WeatherAlertsService({home:a.home,core:a.core,adapter:{status:()=>({state:'connected'})},worker:a.worker,render:async()=>image});
    assert.equal((await second.poll()).sent,0);second.close();
    a.advance();assert.equal((await a.service.poll()).sent,1);assert.equal(a.messages.length,2);
  }finally{await a.close();}
});
test('source failure preserves existing dedup and reports unhealthy, no made-up all-clear',async()=>{
  const a=await setup();try{await a.service.configure({targetKey:a.target.key,operation:'add',query:'海淀'});await a.service.poll();a.fail();
    assert.equal((await a.service.poll()).ok,false);assert.equal(a.messages.length,1);assert.equal((await a.service.status()).health.lastCode,'ALERT_SOURCE_UNAVAILABLE');
  }finally{await a.close();}
});
test('persisted pre-send claim after crash is never automatically replayed',async()=>{
  const a=await setup();try{await a.service.configure({targetKey:a.target.key,operation:'add',query:'海淀'});
    const file=path.join(a.home,'.private/weather-alerts.json'),state=JSON.parse(await fs.readFile(file,'utf8'));
    state.history.push({key:hash(a.target.key+':'+warning().fingerprint),state:'claimed',at:Date.now()});await fs.writeFile(file,JSON.stringify(state));
    const restarted=new WeatherAlertsService({home:a.home,core:a.core,adapter:{status:()=>({state:'connected'})},worker:a.worker,render:async()=>image});
    try{assert.equal((await restarted.poll()).sent,0);assert.equal(a.messages.length,0);}finally{restarted.close();}
  }finally{await a.close();}
});
test('loss of chat permission while area resolves prevents subscription creation',async()=>{
  const a=await setup();try{const r=await a.service.configure({targetKey:a.target.key,operation:'add',query:'海淀',authorize:()=>false});
    assert.equal(r.code,'ALERT_TARGET_DENIED');assert.equal((await a.service.status()).targets[0].regions.length,0);
  }finally{await a.close();}
});
test('closing region during render cancels delivery and survives restart',async()=>{
  let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
  const a=await setup({render:async()=>{entered();await gate;return image;}});try{
    await a.service.configure({targetKey:a.target.key,operation:'add',query:'海淀'});const poll=a.service.poll();await start;
    await a.service.configure({targetKey:a.target.key,operation:'toggle',code:area.code,enabled:false});release();await poll;
    assert.equal(a.messages.length,0);assert.equal((await a.service.status()).targets[0].regions[0].enabled,false);
  }finally{release();await a.close();}
});
test('current group command works with chat disabled and never changes owner subscriptions',async()=>{
  const a=await setup();try{const result=await a.core.handleMessage({kind:'group',groupId:'group',id:'message1',senderId:'member',text:'大肥鱼 /开启实时预警 北京海淀',replyTarget:{scope:'group',targetId:'group',msgId:'message1'}});
    assert.equal(result.code,'SENT');assert.equal(a.messages[0].groupId,'group');assert.match(a.messages[0].text,/已开启/);
    const s=await a.service.status();assert.equal(s.targets.find(t=>t.scope==='group').regions.length,1);assert.equal(s.targets.find(t=>t.scope==='c2c').regions.length,0);
  }finally{await a.close();}
});
test('invalid target cannot subscribe and forged alert permit cannot authorize sending',async()=>{
  const a=await setup();try{
    assert.equal((await a.service.configure({targetKey:'f'.repeat(64),operation:'add',query:'海淀'})).code,'ALERT_TARGET_DENIED');
    assert.equal(a.core.canDeliver({groupId:'group',proactiveGroup:true,requiredFeature:'weather',weatherAlertPermit:{current:()=>true}}),false);
  }finally{await a.close();}
});
test('one source request is shared across concurrent polls and conversations; only selected target gets image',async()=>{
  const a=await setup();try{const group=a.core.weatherAlertTargets().find(t=>t.scope==='group');await a.service.configure({targetKey:group.key,operation:'add',query:'海淀'});
    await Promise.all([a.service.poll(),a.service.poll()]);assert.equal(a.fetches,1);assert.equal(a.messages.length,1);assert.equal(a.messages[0].groupId,'group');
  }finally{await a.close();}
});
test('stale console revision is rejected, pause retains subscriptions and suppresses query',async()=>{
  const a=await setup();try{await a.service.configure({targetKey:a.target.key,operation:'add',query:'海淀'});
    assert.equal((await a.service.configure({targetKey:a.target.key,operation:'master',enabled:false,revision:0})).code,'ALERT_CONFIG_CHANGED');
    await a.core.setPaused(true);assert.equal((await a.service.poll()).code,'PAUSED');assert.equal(a.fetches,0);assert.equal((await a.service.status()).targets[0].enabled,true);
  }finally{await a.close();}
});
test('actual card produces valid PNG matching weather width',async()=>{
  const result=await renderWeatherAlert({...warning(),change:'升级',previousColor:'黄色',color:'橙色'});
  assert.equal(result.mimeType,'image/png');assert.deepEqual([...result.buffer.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.equal(result.buffer.readUInt32BE(16),1867);assert.ok(result.buffer.length<5*1024*1024);
});
test('QQ adapter rechecks subscription after media upload and suppresses closed subscription',async()=>{
  let check=true,posted=0;const handlers=new Map();const bot={on:(n,f)=>handlers.set(n,f),start:()=>new Promise(()=>{}),stop(){},
    api:{post:async()=>{check=false;return {file_info:'file'};}},send:async()=>{posted++;}};
  const adapter=new QQAdapter({createBot:()=>bot,canSend:({weatherAlertPermit})=>weatherAlertPermit?.current()===true});
  await adapter.connect({appId:'123',appSecret:'offline'});await handlers.get('ready')({});
  try{await assert.rejects(adapter.send({ownerId:'owner',text:'',image:await renderWeatherAlert(warning()),weatherAlertPermit:{current:()=>check}}),/QQ_SEND_CANCELLED/);assert.equal(posted,0);}finally{await adapter.disconnect();}
});

test('partial source failure retains previous and pending, recovery stays deduplicated',async()=>{
  const a=await setup();try{
    await a.service.configure({targetKey:a.target.key,operation:'add',query:'海淀'});
    const original=a.worker.run.bind(a.worker);await a.service.poll();
    a.worker.run=async p=>p.action==='poll'?{ok:true,schema:'weather.alerts.v1',alerts:[],checkedAt:new Date().toISOString(),sourceCount:0,sourceFailures:['cma']}:original(p);
    await a.service.poll();
    assert.equal((await a.service.status()).health.lastCode,'ALERT_SOURCE_PARTIAL');
    const state=JSON.parse(await fs.readFile(path.join(a.home,'.private/weather-alerts.json'),'utf8'));
    assert.equal(state.previous.length,1);assert.equal(state.history.length,1);
    a.worker.run=original;assert.equal((await a.service.poll()).sent,0);assert.equal(a.messages.length,1);
  }finally{await a.close();}
});


test('partial preview cannot misreport no warnings',async()=>{
  const a=await setup();try{
    a.worker.run=async()=>({ok:true,schema:'weather.alerts.v1',alerts:[],sourceFailures:['beijing_air']});
    const result=await a.service.preview('110108');assert.equal(result.ok,false);assert.equal(result.code,'ALERT_SOURCE_PARTIAL');assert.equal(a.messages.length,0);
  }finally{await a.close();}
});
