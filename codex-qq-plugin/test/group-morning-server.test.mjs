import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeServer} from '../src/server.mjs';
import {basicGroupFeatures} from '../src/group-features.mjs';

test('slow 07:28 preparation does not lock 07:30 dispatch or status; fixed integration route rejects parameters',async()=>{
  let now=new Date('2026-11-07T07:28:00+08:00'),entered,release,calls=0;
  const started=new Promise(r=>entered=r),blocked=new Promise(r=>release=r),sent=[];
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,
    saveState:async()=>{},loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,
      attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
      allowedGroups:[{id:'group',name:'fixture',features:{...basicGroupFeatures(),morningWeather:true,morningCampus:true}}],grayGroups:[]})};
  const app=await createBridgeServer({port:0,store,groupMorningNow:()=>now,
    morningReport:{create:async options=>{assert.equal(options.scheduledMorning,true);calls++;entered();await blocked;return {date:'2026-11-07',image};}},
    campusService:{status:async()=>({}),close(){},run:async()=>({image,data:{ok:true,date:'2026-11-07'}})},
    adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async r=>{sent.push(r);return {ok:true};}})});
  try {
    const port=await app.listen();
    const request=(route,body={},token=store.integrationToken)=>fetch('http://127.0.0.1:'+port+'/api/'+route,
      {method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await request('group/morning/prepare',{scheduledMorning:true})).status,400);
    const prepare=request('group/morning/prepare');await started;
    assert.equal(sent.length,0);
    assert.equal((await (await request('group/morning/run')).json()).code,'MORNING_NOT_DUE');
    now=new Date('2026-11-07T07:30:00+08:00');
    const dispatch=request('group/morning/run');
    for(let i=0;i<100&&!sent.length;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(sent.length,1,'ready campus leaves while weather preparation is still pending');
    const status=await fetch('http://127.0.0.1:'+port+'/api/status',{headers:{Authorization:'Bearer '+store.token}});
    assert.equal(status.status,200);
    release();
    assert.equal((await (await prepare).json()).code,'MORNING_PREPARED');
    assert.equal((await (await dispatch).json()).sent,2);
    assert.equal(calls,1);assert.equal(sent.length,2);
    assert.equal((await (await request('group/morning/run')).json()).code,'DUPLICATE');
  } finally {release();await app.close();}
});
