import test from 'node:test';
import assert from 'node:assert/strict';
import {createBridgeServer} from '../src/server.mjs';
test('model config remains authenticated, private and independent of QQ owner notifications',async()=>{
  let saved,config={enabled:false,configured:false,model:'deepseek-flash',baseURL:'https://api.deepseek.com',provider:'deepseek'};
  const store={token:'a'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const app=await createBridgeServer({port:0,store,agentConfigStore:{status:async()=>config,save:async data=>{saved=data;config={...config,enabled:data.enabled,configured:!!data.apiKey};}},adapterFactory:()=>({status:()=>({state:'disconnected'}),disconnect:async()=>{}})});
  try{
    const port=await app.listen(),url='http://127.0.0.1:'+port;
    assert.equal((await fetch(url+'/api/agent/config',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+store.token};
    assert.equal((await fetch(url+'/api/agent/config',{method:'POST',headers:{...headers,Origin:'https://attacker.invalid'},body:'{}'})).status,403);
    const response=await fetch(url+'/api/agent/config',{method:'POST',headers,body:JSON.stringify({enabled:true,model:'deepseek-flash',apiKey:'dummy-not-a-real-secret'})});
    assert.equal((await response.json()).code,'AGENT_CONFIG_SAVED');assert.equal(saved.apiKey,'dummy-not-a-real-secret');
    const status=await (await fetch(url+'/api/status',{headers})).text();assert.doesNotMatch(status,/dummy-not-a-real-secret|cipher|apiKey/);assert.equal(JSON.parse(status).agent.enabled,true);
  }finally{await app.close();}
});
