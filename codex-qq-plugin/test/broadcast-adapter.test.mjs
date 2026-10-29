import test from 'node:test';
import assert from 'node:assert/strict';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { QQAdapter } from '../src/qq-adapter.mjs';

async function fixture(denied=false){
  const real=new QQBot({appId:'test-only',appSecret:'test-only',markdownSupport:false,logger:{info(){},warn(){},error(){},debug(){}}});
  const requests=[],handlers=new Map();let finish;
  real.tokenManager.getAccessToken=async()=>'offline-fake-token';
  real.apiClient.request=async(_token,method,path,body)=>{
    requests.push({method,path,body});
    if(denied)throw Object.assign(new Error('PRIVATE_PLATFORM_BODY'),{httpStatus:403});
    return {id:'offline-message'};
  };
  const bot={on:(name,fn)=>handlers.set(name,fn),start:()=>new Promise(resolve=>{finish=resolve;}),stop:()=>finish?.(),sendText:real.sendText.bind(real)};
  const clock={value:Date.parse('2026-10-28T01:00:00Z')};
  const adapter=new QQAdapter({createBot:()=>bot,now:()=>clock.value});
  await adapter.connect({appId:'12345',appSecret:'test-only'});await handlers.get('ready')();
  return {adapter,requests,handlers,clock};
}
const input={ownerId:'OWNER_ID',groupId:'GROUP_ID',text:'完成简报',proactiveGroup:true};

test('explicit internal group broadcast sends one unreferenced message without observed events',async()=>{
  const f=await fixture();try{
    assert.deepEqual(await f.adapter.send(input),{ok:true});
    assert.deepEqual(f.requests,[{method:'POST',path:'/v2/groups/GROUP_ID/messages',body:{content:'完成简报',msg_type:0}}]);
    assert.doesNotMatch(JSON.stringify(f.requests[0].body),/msg_id|event_id|reference|mentions|OWNER_ID|@/);
  }finally{await f.adapter.disconnect();}
});

test('ordinary group replies still require observed fresh targets and explicit flags cannot smuggle malformed IDs',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.adapter.send({...input,proactiveGroup:false}),{code:'QQ_REPLY_TARGET_INVALID'});
    await assert.rejects(f.adapter.send({...input,proactiveGroup:'true'}),{code:'QQ_GROUP_INVALID'});
    await assert.rejects(f.adapter.send({...input,groupId:undefined}),{code:'QQ_GROUP_INVALID'});
    await assert.rejects(f.adapter.send({...input,ownerId:'../owner'}),{code:'QQ_OWNER_INVALID'});
    await assert.rejects(f.adapter.send({...input,groupId:'../group'}),{code:'QQ_GROUP_INVALID'});
    await assert.rejects(f.adapter.send({...input,replyTarget:{scope:'group',targetId:'OTHER_GROUP',msgId:'fake'}}),{code:'QQ_REPLY_TARGET_INVALID'});
    assert.equal(f.requests.length,0);
  }finally{await f.adapter.disconnect();}
});

test('broadcast permission rejection is sanitized, never retried and never falls back to a passive message',async()=>{
  const f=await fixture(true);try{
    await assert.rejects(f.adapter.send(input),error=>error.code==='QQ_PERMISSION_DENIED'&&error.httpStatus===403&&error.phase==='send'&&error.messageAttempted===true&&!JSON.stringify(error).includes('PRIVATE_PLATFORM_BODY'));
    assert.equal(f.requests.length,1);assert.deepEqual(f.requests[0].body,{content:'完成简报',msg_type:0});
  }finally{await f.adapter.disconnect();}
});

test('ordinary fresh group authorization remains time-limited when broadcast support is enabled',async()=>{
  const f=await fixture();try{
    const replyTarget={scope:'group',targetId:'GROUP_ID',msgId:'incoming'};
    await f.handlers.get('message')({}, {kind:'group',rawEventType:'GROUP_MESSAGE_CREATE',groupOpenid:'GROUP_ID',senderId:'MEMBER',messageId:'incoming',
      timestamp:new Date(f.clock.value).toISOString(),content:'梁祖 帮助',replyTarget});
    f.clock.value+=5*60_000;
    await assert.rejects(f.adapter.send({...input,proactiveGroup:false,replyTarget}),{code:'QQ_REPLY_TARGET_EXPIRED'});
    // Supplying a stale reference cannot silently downgrade to a fresh proactive request.
    await assert.rejects(f.adapter.send({...input,replyTarget}),{code:'QQ_REPLY_TARGET_EXPIRED'});
    assert.equal(f.requests.length,0);
  }finally{await f.adapter.disconnect();}
});
