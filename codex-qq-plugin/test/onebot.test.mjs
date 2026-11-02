import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocketServer} from 'ws';
import {OneBotAdapter,validateOneBotProfile} from '../src/onebot-adapter.mjs';
import {BridgeCore} from '../src/core.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversionToolbox} from '../src/conversion-tools.mjs';
import {APP_ROOT} from '../src/runtime-paths.mjs';

const selfId = '100001', owner = '100002', group = '200001';
const ownerId = 'qq_100001_u_100002', groupId = 'qq_100001_g_200001';
const profile = {selfId,mode:'limited',token:'a'.repeat(64)};
const asText = text => ({type:'text',data:{text}});
const event = (overrides={}) => ({post_type:'message',message_type:'group',sub_type:'normal',user_id:Number(owner),
  group_id:Number(group),self_id:Number(selfId),message_id:-109,time:Math.floor(Date.now()/1000),message:[asText('hi')],...overrides});
async function gateway(t,{reply=(action)=>action==='get_login_info'?{user_id:Number(selfId)}:
    action==='get_status'?{online:true,good:true}:{message_id:-101},...options}={}) {
  const server = new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening');
  const actions = [];
  let peer;
  server.on('connection',(socket,req)=>{
    peer=socket;
    assert.equal(req.headers.authorization,'Bearer '+profile.token);
    socket.on('message',data=>{
      const {action,params,echo}=JSON.parse(data);
      actions.push({action,params});
      const packet=reply(action,socket);
      if (packet!==undefined) socket.send(JSON.stringify({status:'ok',retcode:0,data:packet,echo}));
    });
  });
  const adapter=new OneBotAdapter({endpoint:'ws://127.0.0.1:'+server.address().port+'/',canSend:()=>true,...options});
  t.after(async()=>{await adapter.disconnect();await new Promise(resolve=>server.close(resolve));});
  return {adapter,actions,push:p=>peer.send(JSON.stringify(p))};
}

test('authenticated handshake verifies this QQ identity and online status before accepting traffic',async t=>{
  for(const bad of ['wrong','offline']) {
    const g=await gateway(t,{reply:action=>action==='get_login_info'?{user_id:bad==='wrong'?owner:selfId}:{online:false,good:true}});
    await assert.rejects(g.adapter.connect(profile),/ONEBOT_ACCOUNT_MISMATCH|ONEBOT_OFFLINE/);
    assert.equal(g.adapter.status().state,'blocked');
  }
  assert.throws(()=>new OneBotAdapter({endpoint:'ws://0.0.0.0:19328/'}));
  assert.throws(()=>validateOneBotProfile({...profile,selfId:1}));
});
test('accepts only structured self mentions, fresh scoped messages and event-derived CDN attachments',async t=>{
  const events=[];
  let done;
  const received=new Promise(r=>done=r);
  const g=await gateway(t,{onMessage:e=>{events.push(e);if(events.length===2)done();}});
  await g.adapter.connect(profile);
  for (const ignored of [{post_type:'message_sent'},{user_id:selfId},{time:1},{message:'[CQ:at,qq=100001]'},
    {message_type:'private',sub_type:'group'}]) g.push(event(ignored));
  g.push(event({message:[asText('[CQ:at,qq=100001] hello')]}));
  g.push(event());
  g.push(event({message_id:-110,message:[{type:'at',data:{qq:selfId}},asText(' hello '),
    {type:'image',data:{file:'/tmp/file',url:'https://example.org/no.png'}},{type:'image',data:{url:'https://gchat.qpic.cn/a'}}]}));
  await received;
  assert.equal(events[0].mentioned,undefined);
  assert.equal(events[1].mentioned,true);
  assert.equal(events[1].senderId,ownerId);assert.equal(events[1].groupId,groupId);
  assert.equal(events[1].media.length,1);
  await assert.rejects(g.adapter.send({ownerId,groupId,text:'x'}),/CANCELLED/);
  const png={buffer:Buffer.from([137,80,78,71,13,10,26,10]),mimeType:'image/png'};
  const result=await g.adapter.send({ownerId,groupId,replyTarget:events[1].replyTarget,text:'[CQ:at,qq=all]',image:png,richMedia:true});
  assert.match(result.receiptHash,/^[a-f0-9]{64}$/);
  const wire=g.actions.at(-1);
  assert.equal(wire.action,'send_group_msg');assert.equal(wire.params.group_id,Number(group));
  assert.deepEqual(wire.params.message.map(x=>x.type),['text','image']);
  assert.equal(wire.params.message[0].data.text,'[CQ:at,qq=all]');
});
test('receive-only never submits, missing or lost send acknowledgments block and never retry',async t=>{
  const g=await gateway(t,{reply:(action,s)=>action==='get_login_info'?{user_id:selfId}:
    action==='get_status'?{online:true,good:true}:{}});
  await g.adapter.connect({...profile,mode:'receive-only'});
  await assert.rejects(g.adapter.send({ownerId,text:'x'}),/CANCELLED/);
  assert.equal(g.actions.length,2);
  await g.adapter.connect(profile);
  await assert.rejects(g.adapter.send({ownerId,text:'x'}),e=>e.messageAttempted===true);
  assert.equal(g.adapter.status().state,'blocked');
  await assert.rejects(g.adapter.send({ownerId,text:'x'}));
  assert.equal(g.actions.filter(a=>a.action.startsWith('send_')).length,1);
  const lost=await gateway(t,{reply:(a,s)=>a==='get_login_info'?{user_id:selfId}:a==='get_status'?{online:true,good:true}:void s.terminate()});
  await lost.adapter.connect(profile);
  await assert.rejects(lost.adapter.send({ownerId,text:'x'}),e=>e.messageAttempted===true);
  assert.equal(lost.actions.length,3);
});

function memoryStore(){
  let state=null;
  return {init:async()=>{},readCredentials:async()=>null,loadState:async()=>structuredClone(state),saveState:async s=>{state=structuredClone(s);}};
}
async function pairedCore(store,send,mode='limited'){
  const core=new BridgeCore({loadState:store.loadState,saveState:store.saveState,send,oneBotMode:mode,
    limits:{dailyAttempts:300,minuteAttempts:15,reservedNotifications:10}});
  await core.init();
  if(!core.status().paired){
    const {pairingCode}=await core.startPairing();
    await core.handleMessage({kind:'c2c',id:'1',senderId:ownerId,text:'/pair '+pairingCode});
    await core.confirmPairing();
  }
  return core;
}
test('limited mode persists target and caller quotas, receipt and uncertain send across a restart',async()=>{
  const store=memoryStore();let receipt=true,calls=0;
  const send=async()=>{calls++;return receipt?{ok:true,receiptHash:'b'.repeat(64)}:undefined;};
  const core=await pairedCore(store,send);
  assert.equal(core.status().limits.dailyAttempts,100);assert.equal(core.status().limits.minuteAttempts,6);
  const ping=id=>({kind:'c2c',id,senderId:ownerId,text:'/ping',replyTarget:{scope:'c2c',targetId:ownerId,msgId:id}});
  assert.equal((await core.handleMessage(ping('2'))).code,'SENT');
  assert.equal((await core.handleMessage(ping('3'))).code,'SENT');
  const reloaded=await pairedCore(store,send);
  assert.equal((await reloaded.handleMessage(ping('4'))).code,'RATE_LIMIT_CALLER');
  assert.equal((await reloaded.notify({text:'x',idempotencyKey:'third'})).code,'SENT');
  assert.equal((await reloaded.notify({text:'x',idempotencyKey:'fourth'})).code,'RATE_LIMIT_TARGET');
  assert.equal((await store.loadState()).deliveries[0].receiptHash,'b'.repeat(64));
  const fresh=memoryStore(), uncertain=await pairedCore(fresh,send);receipt=false;
  assert.equal((await uncertain.notify({text:'x',idempotencyKey:'unknown'})).code,'DELIVERY_UNCERTAIN');
  const again=await pairedCore(fresh,send);
  assert.equal(again.status().uncertainDeliveries,1);assert.equal(again.status().paused,true);
  assert.equal((await again.notify({text:'x',idempotencyKey:'unknown'})).code,'DUPLICATE');
  assert.equal(calls,4);
});
test('fresh OneBot state cannot adopt official permissions, online message traverses real LangChain conversion',async t=>{
  const store=memoryStore(),worker=new PythonAgentWorker({home:APP_ROOT}),calculator=new ConversionToolbox(worker);
  t.after(()=>worker.close());
  let handle,delivered;
  const finished=new Promise(r=>delivered=r);
  const g=await gateway(t,{onMessage:e=>handle(e),reply:a=>a==='get_login_info'?{user_id:selfId}:
    a==='get_status'?{online:true,good:true}:(delivered(),{message_id:19})});
  const app=await createBridgeServer({home:APP_ROOT,port:0,store,oneBotProfile:profile,conversationAgent:{handle:t=>calculator.handle(t)},
    adapterFactory:options=>{handle=options.onMessage;g.adapter.admit=options.admit;g.adapter.canSend=options.canSend;return g.adapter;}});
  t.after(()=>app.close());
  await app.adapter.connect(profile);
  const pair=await app.core.startPairing();
  await app.core.handleMessage({kind:'c2c',id:'pair',senderId:ownerId,text:'/pair '+pair.pairingCode});
  await app.core.confirmPairing();
  g.push(event({message_type:'private',sub_type:'friend',message:[asText('1马里换公里')]}));
  await finished;
  assert.equal(g.actions.at(-1).params.message[0].data.text,'1 马里 = 3.08 km');
  const state=await store.loadState();
  assert.equal(state.identityDomain,'qq_uin_'+selfId);
  await assert.rejects(createBridgeServer({home:APP_ROOT,store}),/STATE_LOAD_FAILED/);
});
