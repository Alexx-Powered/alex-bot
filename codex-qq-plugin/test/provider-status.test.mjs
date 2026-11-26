import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {loadImage} from '@napi-rs/canvas';
import {PublicStatusService,parseStatusCommand} from '../src/public-status.mjs';
import {PROVIDER_BRANDS} from '../src/provider-status-image.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {APP_ROOT,pythonExecutable} from '../src/runtime-paths.mjs';
import {defaultGroupFeatures} from '../src/group-features.mjs';

const providers=['openai','deepseek','gemini','claude','kimi'];
test('five providers have deterministic commands; unsupported providers do not match',()=>{
  for(const p of providers)for(const q of [`查 ${p} 状态`,`/${p}状态`,`发 ${p} 服务状态`,`/status ${p}`])assert.equal(parseStatusCommand(q),p+'_service_status',q);
  for(const q of ['GLM状态','查Kimi余额','Claude写个故事','https://localhost/status','Gemini 状态和天气'])assert.equal(parseStatusCommand(q),null,q);
  assert.equal(parseStatusCommand('查询克劳德状态'),'claude_service_status');
});

test('all five commands cross real Node/Python/LangChain boundary without model config or budget',async()=>{
  const worker=new PythonAgentWorker({home:APP_ROOT,pythonPath:pythonExecutable(),workerPath:path.join(APP_ROOT,'test/fixtures/public-status-worker.py'),timeoutMs:20000});
  const agent=new ConversationAgent({worker,configStore:{read:async()=>({enabled:false})},modelBudget:{acquire:async()=>assert.fail('no model budget')}});
  try{for(const p of providers){
    const answer=await agent.handle(`查 ${p} 状态`,{scope:'group',access:'white',features:defaultGroupFeatures('white')});
    assert.equal(answer.richMedia,true,answer.text);assert.equal(answer.requiredFeature,'status');
    assert.match(answer.text,/运行正常/);assert.ok(answer.text.toLowerCase().includes(p));
    const image=await loadImage(answer.image.buffer);assert.equal(image.width,1867);assert.ok(answer.image.buffer.length<1500000);
  }}finally{worker.close();}
});

test('group feature switch, gray access and invalid parameters deny before querying',async()=>{
  let queries=0;const service=new PublicStatusService({home:APP_ROOT,worker:{run:async()=>{queries++;throw Error('unreachable');},close(){}}});
  for(const p of providers){
    for(const context of [{scope:'group',access:'gray'},{scope:'group',access:'white',features:{...defaultGroupFeatures('white'),status:false}}]){
      assert.equal((await service.handle(`查 ${p} 状态`,context)).image,undefined);
    }
  }
  for(const args of [{provider:'glm'},{provider:'claude',url:'http://localhost'},{provider:'kimi',key:'secret'}])await assert.rejects(service.execute('ai_service_status',args,{scope:'c2c'}));
  assert.equal(queries,0);
});

test('natural-language provider queries run in LangChain and authorize one worker attachment each',async()=>{
  const worker=new PythonAgentWorker({home:APP_ROOT,pythonPath:pythonExecutable(),workerPath:path.join(APP_ROOT,'test/fixtures/public-status-worker.py'),timeoutMs:15000});
  const calls=[],run=worker.run.bind(worker);
  worker.run=(packet,execute,finish,authorize,events)=>run(packet,execute,finish,(feature,name)=>{
    calls.push({feature,name});return authorize(feature,name);
  },events);
  const agent=new ConversationAgent({worker,
    configStore:{read:async()=>({enabled:true,apiKey:'offline-test-key',model:'deepseek-flash',baseURL:'https://api.deepseek.com'})},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})}});
  try{for(const p of ['openai','gemini','claude','kimi']){
    const reply=await agent.handle(`${p}是不是恢复了`,{scope:'c2c',sessionKey:'provider-'+p});
    assert.ok(reply.text.toLowerCase().includes(p),reply.text);assert.match(reply.text,/运行正常/);
    assert.equal(reply.richMedia,true);assert.equal((await loadImage(reply.image.buffer)).width,1867);
  }}finally{worker.close();}
  assert.deepEqual(calls,Array.from({length:4},()=>({feature:'status',name:'ai_service_status'})));
});

test('permission revoked during a provider query suppresses its in-flight image',async()=>{
  let allowed=true;
  const service=new PublicStatusService({home:APP_ROOT,worker:{run:async()=>{allowed=false;return{image:{buffer:Buffer.alloc(12)}};},close(){}}});
  const answer=await service.execute('ai_service_status',{provider:'claude'},{scope:'group',access:'white',authorize:()=>allowed});
  assert.equal(answer.image,undefined);assert.match(answer.text,/灰名单/);
});

test('brand card small text maintains contrast, including translucent metric panels',()=>{
  const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
  const lum=rgb=>rgb.map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
  const contrast=(a,b)=>(Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
  for(const [provider,b] of Object.entries(PROVIDER_BRANDS))for(const background of [b.heroFrom,b.heroTo]){
    const plain=rgb(background),alpha=parseInt(b.mini.slice(7),16)/255,mini=plain.map((x,i)=>x*(1-alpha)+rgb(b.mini)[i]*alpha);
    for(const color of [b.heroInk,b.heroMuted])for(const bg of [plain,mini])assert.ok(contrast(rgb(color),bg)>=4.5,provider+' '+contrast(rgb(color),bg));
  }
});
