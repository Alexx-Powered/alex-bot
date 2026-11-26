import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {BridgeCore} from '../src/core.mjs';
import {QQAdapter} from '../src/qq-adapter.mjs';
import {WeatherAlertsService} from '../src/weather-alerts.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';

for(const scope of ['c2c','group'])test(`subscribed ${scope} warning renders, uploads and submits exactly one image through official adapter`,async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'alex-warning-delivery-'));let core;
  const now=Date.parse('2026-11-08T01:00:00+08:00'),events=new Map(),uploads=[],messages=[];
  const bot={on:(n,f)=>events.set(n,f),start:()=>new Promise(()=>{}),stop(){},api:{post:async(p,b)=>{uploads.push({p,b});return {file_info:'offline-warning'};}},
    send:async m=>{messages.push(m);return {id:'offline-message'};},sendText:()=>assert.fail('Warning must be image only')};
  const adapter=new QQAdapter({createBot:()=>bot,now:()=>now,canSend:r=>core.canDeliver(r)});
  core=new BridgeCore({now:()=>now,loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:[{id:'group',name:'测试群',enabled:true,features:{...defaultGroupFeatures('white'),chat:false}}],grayGroups:[]}),saveState:async()=>{},send:r=>adapter.send(r)});
  await core.init();await adapter.connect({appId:'12345',appSecret:'offline'});await events.get('ready')({});
  const area={code:'110108',name:'北京市·海淀',province:'北京市',level:'district'};
  const alert={id:'11010841600000_20261108003000',series:'11010841600000:p0007',fingerprint:createHash('sha256').update('fixture').digest('hex'),
    color:'蓝色',severity:1,province:'北京市',level:'区县级',hazard:'大风',issuer:'海淀区气象台',publishedAt:'2026-11-08T00:30:00+08:00',
    headline:'海淀区气象台发布大风蓝色预警',description:'离线测试数据：预计有大风，请注意防范。',change:'新增',matches:[{area,relation:'本地'}],provinceContext:[]};
  const worker={run:async p=>p.action==='poll'?{ok:true,schema:'weather.alerts.v1',checkedAt:new Date(now).toISOString(),sourceCount:1,alerts:[alert]}:{ok:true,area},close(){}};
  const service=new WeatherAlertsService({home,core,adapter,worker,now:()=>now});
  try{
    const target=core.weatherAlertTargets().find(t=>t.scope===scope);
    await service.configure({targetKey:target.key,operation:'add',query:'北京海淀'});
    assert.equal((await service.poll()).sent,1);assert.equal(uploads.length,1);assert.equal(messages.length,1);
    assert.equal(uploads[0].p,scope==='group'?'/v2/groups/group/files':'/v2/users/owner/files');assert.equal(uploads[0].b.srv_send_msg,false);
    const png=Buffer.from(uploads[0].b.file_data,'base64');assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10]);
    assert.equal(messages[0].msgType,7);assert.equal(messages[0].content,undefined);assert.equal(messages[0].target.scope,scope);
    await service.poll();assert.equal(messages.length,1);
  }finally{service.close();await adapter.disconnect();await fs.rm(home,{recursive:true,force:true});}
});
