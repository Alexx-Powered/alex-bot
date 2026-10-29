import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeServer} from '../src/server.mjs';
import {beijingDay} from '../src/weather-commands.mjs';

test('enhanced daily selects planned city, cannot be overridden, stays owner-only and keeps daily dedupe',async()=>{
  const sent=[],date=beijingDay();let enabled=false,enhancedCalls=0,legacyCalls=0;
  const image={buffer:Buffer.alloc(16,1),mimeType:'image/png'};
  const store={token:'a'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const app=await createBridgeServer({port:0,store,isMorningEnabled:async()=>enabled,
    morningReport:{plan:()=>({city:'tianjin'}),create:async()=>{enhancedCalls++;return {date,cities:['tianjin'],image,plan:{city:'tianjin'},analysis:{windows:[]}};}},
    weatherCommands:{briefing:async()=>{legacyCalls++;return {date,cities:['beijing'],image};}},
    adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async r=>{sent.push(r);return {ok:true};}})});
  try{
    const port=await app.listen(),headers={Authorization:'Bearer '+store.token,'Content-Type':'application/json'};
    const request=(path,data)=>fetch('http://127.0.0.1:'+port+path,{method:'POST',headers,body:JSON.stringify(data)});
    const pair=await app.core.startPairing();await app.core.handleMessage({kind:'c2c',id:'pair',senderId:'owner',text:'/pair '+pair.pairingCode,replyTarget:{scope:'c2c',targetId:'owner',msgId:'pair'}});await app.core.confirmPairing();
    const preview=await request('/api/morning/preview',{});assert.equal((await preview.json()).cities[0],'tianjin');assert.equal(sent.length,0);enhancedCalls=0;
    enabled=true;
    assert.equal((await(await request('/api/weather/briefing',{mode:'daily',cities:['beijing']})).json()).code,'DAILY_CITY_RESTRICTED');assert.equal(enhancedCalls,0);
    assert.equal((await(await request('/api/weather/briefing',{mode:'daily'})).json()).code,'SENT');assert.equal(enhancedCalls,1);assert.equal(legacyCalls,0);assert.equal(sent[0].ownerId,'owner');assert.equal(sent[0].groupId,undefined);assert.equal(sent[0].text,'');
    assert.equal((await(await request('/api/weather/briefing',{mode:'daily'})).json()).code,'DUPLICATE');assert.equal(sent.length,1);
    assert.equal((await request('/api/notify-all-allowed',{text:'x',idempotencyKey:'x',groupId:'attacker'})).status,400);
  }finally{await app.close();}
});

test('default disabled enhancement continues original Beijing daily without Python analysis',async()=>{
  const store={token:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};let calls=0;
  const app=await createBridgeServer({port:0,store,isMorningEnabled:async()=>false,morningReport:{plan:()=>{throw Error('Must stay disabled');},create:async()=>{throw Error('Must stay disabled');}},weatherCommands:{briefing:async args=>{calls++;assert.deepEqual(args.cities,['beijing']);return {date:beijingDay(),cities:['beijing'],image:{buffer:Buffer.alloc(8),mimeType:'image/png'}};}},adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async()=>({ok:true})})});
  try{
    const pair=await app.core.startPairing();await app.core.handleMessage({kind:'c2c',id:'pair',senderId:'owner',text:'/pair '+pair.pairingCode});await app.core.confirmPairing();
    const port=await app.listen();const r=await fetch('http://127.0.0.1:'+port+'/api/weather/briefing',{method:'POST',headers:{Authorization:'Bearer '+store.token,'Content-Type':'application/json'},body:'{"mode":"daily"}'});
    assert.equal((await r.json()).code,'SENT');assert.equal(calls,1);
  }finally{await app.close();}
});
