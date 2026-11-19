import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBridgeServer} from '../src/server.mjs';

test('admin warning API is scoped, validates parameters, persists changes, and preview never sends',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'alex-warning-api-'));let sent=0;
  const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,saveState:async()=>{},
    loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,allowedGroups:[],grayGroups:[]})};
  const app=await createBridgeServer({home,port:0,store,campusService:{status:async()=>({}),close(){}},
    adapterFactory:()=>({status:()=>({state:'connected'}),send:async()=>{sent++;},disconnect:async()=>{}})});
  const port=await app.listen(),request=async(route,data,token=store.token)=>{
    const response=await fetch('http://127.0.0.1:'+port+'/api/'+route,{method:data===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,data:await response.json()};};
  try{
    assert.equal((await request('weather-alerts/status',undefined,store.integrationToken)).status,403);
    assert.equal((await request('weather-alerts/configure',{},store.integrationToken)).status,403);
    assert.equal((await request('weather-alerts/search',{query:'海淀',recipient:'other'})).status,400);
    assert.equal((await request('weather-alerts/preview',{code:'http://localhost'})).status,400);
    const status=(await request('weather-alerts/status')).data;assert.equal(status.targets.length,1);
    const targetKey=status.targets[0].key;
    assert.equal((await request('weather-alerts/configure',{targetKey,operation:'add',query:'北京海淀',revision:0})).data.ok,true);
    assert.equal((await request('weather-alerts/status')).data.targets[0].regions[0].code,'110108');
    app.weatherAlerts.worker.close();app.weatherAlerts.worker={run:async()=>({ok:true,schema:'weather.alerts.v1',alerts:[],checkedAt:'2026-11-08T01:00:00+08:00'}),close(){}};
    assert.equal((await request('weather-alerts/preview',{code:'110108'})).data.code,'ALERT_NONE');assert.equal(sent,0);
    assert.equal((await request('weather-alerts/configure',{targetKey,operation:'master',enabled:false,revision:1})).data.ok,true);
    assert.equal((await request('weather-alerts/status')).data.targets[0].enabled,false);
  }finally{await app.close();await fs.rm(home,{recursive:true,force:true});}
});
