import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';

const msg=(id,text,senderId='owner')=>({kind:'c2c',id,text,senderId,replyTarget:{scope:'c2c',targetId:senderId,msgId:id}});
async function setup(handler){
  const sent=[];const core=new BridgeCore({loadState:async()=>null,saveState:async()=>{},send:async request=>{sent.push(request);return {ok:true};},commandHandler:handler});
  await core.init();const pair=await core.startPairing();await core.handleMessage(msg('pair','/pair '+pair.pairingCode));await core.confirmPairing();
  return {core,sent};
}
test('unauthorized and paused messages never invoke the model',async()=>{
  let calls=0;const f=await setup(async()=>{calls++;return {text:'ok'};});
  await f.core.handleMessage(msg('x','北京要带伞吗','stranger'));assert.equal(calls,0);
  await f.core.setPaused(true);await f.core.handleMessage(msg('y','北京要带伞吗'));assert.equal(calls,0);
});
test('pause received during generation suppresses pending reply; context hashed',async()=>{
  let release,entered;const started=new Promise(r=>entered=r);const pending=new Promise(r=>release=r);
  const f=await setup(async(text,context)=>{assert.match(context.sessionKey,/^[a-f0-9]{64}$/);entered();await pending;return {text:'do not send'};});
  const query=f.core.handleMessage(msg('query','北京天气'));await started;
  const pause=f.core.handleMessage(msg('pause','/pause'));release();
  assert.equal((await query).code,'PAUSED');await pause;assert.equal(f.sent.length,0);assert.equal(f.core.status().paused,true);
});
