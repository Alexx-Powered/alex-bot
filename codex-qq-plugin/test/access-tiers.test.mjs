import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {APP_ROOT} from '../src/runtime-paths.mjs';
import {CampusService} from '../src/campus-service.mjs';
import {fullAccess} from '../src/access-policy.mjs';
import {createBridgeServer} from '../src/server.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
const group=(id,text,key='g-white')=>({kind:'group',groupId:key,id,senderId:'member',text,replyTarget:{scope:'group',targetId:key,msgId:id}});
const privateMessage=(id,text)=>({kind:'c2c',id,senderId:'owner',text,replyTarget:{scope:'c2c',targetId:'owner',msgId:id}});
async function fixture(handler=async()=>null,sendOverride){
  let state=null;const sent=[],contexts=[];
  const core=new BridgeCore({loadState:async()=>state,saveState:async v=>{state=structuredClone(v);},
    send:async value=>{if(sendOverride)await sendOverride(value,core);sent.push(value);return {ok:true};},
    commandHandler:async(text,context)=>{contexts.push(context);return handler(text,context);},
    limits:{minuteAttempts:30,dailyAttempts:1000,reservedNotifications:10}});
  await core.init();const owner=await core.startPairing();await core.handleMessage(privateMessage('pair','/pair '+owner.pairingCode));await core.confirmPairing();
  async function allow(id,access='white'){
    const started=await core.startGroupPairing({name:id,access});
    const captured=await core.handleMessage(group('bind-'+id,'/group-bind '+started.groupPairingCode,id));
    const confirmed=await core.confirmGroupPairing({groupKey:captured.groupKey});
    assert.equal(confirmed.code,access==='white'?'GROUP_ALLOWED':'GRAY_GROUP_ALLOWED');return captured.groupKey;
  }
  return {core,sent,contexts,allow,state:()=>structuredClone(state)};
}
function agentFixture(overrides={}){
  return new ConversationAgent({toolbox:{handle:async()=>null,execute:async()=>assert.fail('query denied')},
    conversionTools:{handle:async text=>text==='1马里换公里'?{text:'1 马里 = 3.08 km'}:null},
    configStore:{read:async()=>({enabled:true,apiKey:'offline-key'})},
    modelBudget:{acquire:async()=>({ok:true})},policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),
    worker:{run:async(_p,_e,finish)=>finish({kind:'clarify',reason:'restricted_access'})},...overrides});
}

test('gray enrollment, tier changes and removal persist without duplicate membership or spontaneous sends',async()=>{
  const f=await fixture();const key=await f.allow('g-gray','gray');
  assert.equal(f.core.status().grayGroupCount,1);assert.equal(f.core.status().groupCount,0);
  assert.equal(f.core.groupAccess('g-gray'),'gray');assert.equal(f.sent.length,0);
  assert.equal((await f.core.setGroupAccess({groupKey:key,access:'white'})).code,'GROUP_ACCESS_CHANGED');
  assert.equal(f.core.status().grayGroupCount,0);assert.equal(f.core.status().groupCount,1);
  await f.core.setGroupAccess({groupKey:key,access:'gray'});
  assert.equal((await f.core.removeAllowedGroup({groupKey:key})).code,'GROUP_REMOVED');
  assert.equal(f.core.groupAccess('g-gray'),null);assert.equal(f.sent.length,0);
  const restored=new BridgeCore({loadState:async()=>f.state(),saveState:async()=>{},send:async()=>assert.fail('no sends')});
  await restored.init();assert.equal(restored.status().grayGroupCount,0);
});

test('legacy state remains white and duplicate white/gray IDs fail closed',async()=>{
  const f=await fixture();await f.allow('g-white');const legacy=f.state();delete legacy.grayGroups;
  const make=initial=>new BridgeCore({loadState:async()=>initial,saveState:async()=>{},send:async()=>assert.fail()});
  const restored=make(legacy);await restored.init();assert.equal(restored.groupAccess('g-white'),'white');assert.equal(restored.status().grayGroupCount,0);
  const corrupt={...legacy,grayGroups:[{id:'g-white',name:'duplicate'}]};await assert.rejects(make(corrupt).init(),/STATE_INVALID/);
  for(const entry of [null,[],{id:'g-gray',name:'valid',access:'white'},{id:'bad/id',name:'invalid'}]){
    await assert.rejects(make({...legacy,grayGroups:[entry]}).init(),/STATE_INVALID/);
  }
});

test('gray fixed conversion works without a model and cannot access balance or weather',async t=>{
  const worker=new PythonAgentWorker({home:APP_ROOT});
  t.after(()=>worker.close());
  let reads=0;
  const agent=agentFixture({worker,configStore:{read:async()=>{reads++;return {enabled:false};}},
    modelBudget:{acquire:()=>assert.fail('fixed commands need no model quota')}});
  const context={scope:'group',access:'gray',groupContext:[]};
  assert.match((await agent.handle('1马里换公里',context)).text,/3.08/);assert.equal(reads,1);
  assert.match((await agent.handle('查DeepSeek余额',context)).text,/灰名单/);assert.equal(reads,2);
  assert.equal(await agent.handle('北京天气怎么样',context),null);
  assert.match((await agent.handle('发天气北京',context)).text,/灰名单/);
});

test('white natural balance reply is marked sensitive; gray forced balance/status results are blocked',async()=>{
  let packet;
  const agent=agentFixture({worker:{run:async(p,_e,finish)=>{packet=p;return finish({kind:'balance',text:'DeepSeek余额：110 CNY'});}}});
  const reply=await agent.handle('deepseek账户还有多少钱',{scope:'group',access:'white',groupContext:[]});
  assert.equal(packet.context.access,'white');assert.match(reply.text,/110 CNY/);assert.equal(reply.sensitive,true);assert.equal(reply.requiredAccess,'white');
  const denied=await agent.handle('deepseek账户还有多少钱',{scope:'group',access:'gray',groupContext:[]});assert.doesNotMatch(denied.text,/110/);
  const conversion=agentFixture({worker:{run:async(_p,_e,finish)=>finish({kind:'reasoned',source:'conversion',text:'全马约为13.7马里。'})}});
  assert.match((await conversion.handle('全马多少马里',{scope:'group',access:'gray',groupContext:[]})).text,/13.7/);
  const status=agentFixture({worker:{run:async(_p,_e,finish)=>finish({kind:'reasoned',source:'openai-status',text:'must not disclose query'})}});
  assert.match((await status.handle('OpenAI状态',{scope:'group',access:'gray',groupContext:[]})).text,/灰名单/);
});

test('white campus calls have full access; gray campus never reads saved credentials',async()=>{
  let reads=0;
  const campus=new CampusService({home:'D:/unused',configStore:{read:async()=>{reads++;return {};}} ,worker:{close(){}}});
  assert.equal((await campus.workerGrant('buaa_classroom_query',{scope:'group',access:'gray'})).code,'CAMPUS_OWNER_ONLY');assert.equal(reads,0);
  const result=await campus.workerGrant('buaa_classroom_query',{scope:'group',access:'white'});assert.equal(result.code,'CAMPUS_NOT_CONFIGURED');assert.equal(reads,1);
  assert.equal(fullAccess({scope:'group',access:'white',authorize:()=>false}),false);
});

test('downgrade immediately blocks an in-flight core reply, clears background and retains basic chat',async()=>{
  const entered=deferred(),release=deferred();
  const f=await fixture(async text=>{if(text==='core query'){entered.resolve();await release.promise;return {text:'',image,requiredAccess:'white'};}return {text:'基础聊天',requiredAccess:'chat'};});
  const key=await f.allow('g-white');await f.core.handleMessage(group('background','before downgrade background'));
  const pending=f.core.handleMessage(group('query','梁祖 core query'));await entered.promise;
  const change=f.core.setGroupAccess({groupKey:key,access:'gray'});
  assert.equal(f.core.groupAccess('g-white'),'gray');assert.equal(f.contexts[0].authorize('white'),false);
  release.resolve();assert.equal((await pending).code,'GROUP_ACCESS_DENIED');await change;assert.equal(f.sent.length,0);
  assert.equal((await f.core.handleMessage(group('after','梁祖 你好'))).code,'SENT');
  assert.deepEqual(f.contexts.at(-1).groupContext,[]);assert.equal(f.contexts.at(-1).access,'gray');
});

test('removal immediately blocks pending results and upload cancellation does not pause other groups',async()=>{
  const entered=deferred(),release=deferred();
  const f=await fixture(async()=>({text:'',image,requiredAccess:'white'}),async(value,core)=>{
    entered.resolve();await release.promise;
    if(!core.canDeliver(value))throw Object.assign(new Error('cancelled'),{code:'QQ_SEND_CANCELLED',messageAttempted:false});
  });
  const key=await f.allow('g-white');const pending=f.core.handleMessage(group('query','梁祖 test'));await entered.promise;
  const removed=f.core.removeAllowedGroup({groupKey:key});assert.equal(f.core.groupAccess('g-white'),null);
  release.resolve();assert.equal((await pending).deliveryState,'rejected');await removed;
  assert.equal(f.sent.length,0);assert.equal(f.core.status().paused,false);
});

test('balance values are not added to group memory; broadcasts continue to exclude gray groups',async()=>{
  const f=await fixture(async text=>text==='balance'?{text:'可用 110.00 CNY',sensitive:true,requiredAccess:'white'}:null);
  await f.allow('g-white');await f.allow('g-gray','gray');
  await f.core.handleMessage(group('balance','梁祖 balance'));
  await f.core.handleMessage(group('probe','梁祖 next'));
  assert.ok(f.contexts.at(-1).groupContext.some(row=>row.text==='[已查询账户余额]'));
  assert.doesNotMatch(JSON.stringify(f.contexts.at(-1).groupContext),/110/);
  f.sent.length=0;
  const broadcast=await f.core.notifyAllAllowed({text:'explicit operation summary',idempotencyKey:'tier-broadcast'});
  assert.equal(broadcast.sent,2);assert.deepEqual(f.sent.map(x=>x.groupId||'owner'),['owner','g-white']);
});

test('local HTTP gray enrollment and promotion stay authenticated; group text cannot change its tier',async()=>{
  const store={token:'a'.repeat(64),init:async()=>{},readCredentials:async()=>null,loadState:async()=>null,saveState:async()=>{}};
  const app=await createBridgeServer({port:0,store,conversationAgent:{handle:async()=>null},adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{},send:async()=>assert.fail('no actual send')})});
  try{
    const port=await app.listen(),url='http://127.0.0.1:'+port;
    const post=(route,data,auth=true)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+store.token}:{})},body:JSON.stringify(data)});
    const owner=await app.core.startPairing();await app.core.handleMessage(privateMessage('pair','/pair '+owner.pairingCode));await app.core.confirmPairing();
    assert.equal((await post('/api/group/start',{name:'gray',access:'gray'},false)).status,401);
    const binding=await(await post('/api/group/start',{name:'gray',access:'gray'})).json();
    const candidate=await app.core.handleMessage(group('bind','/group-bind '+binding.groupPairingCode,'http-gray'));
    assert.equal((await(await post('/api/group/confirm',{groupKey:candidate.groupKey})).json()).code,'GRAY_GROUP_ALLOWED');
    await app.core.handleMessage(group('untrusted','梁祖 /group/access white','http-gray'));assert.equal(app.core.groupAccess('http-gray'),'gray');
    assert.equal((await post('/api/group/access',{groupKey:candidate.groupKey,access:'all'})).status,400);
    assert.equal((await(await post('/api/group/access',{groupKey:candidate.groupKey,access:'white'})).json()).code,'GROUP_ACCESS_CHANGED');
    assert.equal(app.core.groupAccess('http-gray'),'white');
  }finally{await app.close();}
});
