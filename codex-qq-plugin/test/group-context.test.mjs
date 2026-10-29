import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BridgeCore } from '../src/core.mjs';

const OWNER='private-owner-openid', A='private-group-a', B='private-group-b', MEMBER='private-member-openid';
const hash=value=>createHash('sha256').update(value).digest('hex');
const group=(text,id,groupId=A,senderId=MEMBER)=>({kind:'group',groupId,id,senderId,text,
  replyTarget:{scope:'group',targetId:groupId,msgId:id}});
const privateMessage=(text,id,senderId=OWNER)=>({kind:'c2c',id,senderId,text,
  replyTarget:{scope:'c2c',targetId:senderId,msgId:id}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture({handler=async()=>null,send=async()=>({ok:true}),beforeSave=async()=>{},paired=true,groups=[A,B]}={}) {
  let state={version:1,ownerId:paired?OWNER:null,paused:!paired,pauseReason:paired?null:'UNPAIRED',attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:paired?groups.map((id,i)=>({id,name:'测试群'+i})):[]};
  const clock={now:Date.parse('2026-10-29T02:00:00Z')},calls=[],sent=[],writes=[];
  const deps={loadState:async()=>structuredClone(state),saveState:async value=>{await beforeSave(value);state=structuredClone(value);writes.push(structuredClone(value));},
    now:()=>clock.now,limits:{dailyAttempts:200,minuteAttempts:10,reservedNotifications:10},
    commandHandler:async(text,context)=>{calls.push({text,context:structuredClone(context)});return handler(text,context);},
    send:async request=>{sent.push(request);return send(request);}};
  return {core:new BridgeCore(deps),deps,clock,calls,sent,writes,state:()=>structuredClone(state)};
}
async function ready(options){const f=fixture(options);await f.core.init();return f;}
async function probe(f,id='probe',groupId=A,senderId=MEMBER){await f.core.handleMessage(group('梁祖 看看上下文',id,groupId,senderId));return f.calls.at(-1).context;}

test('forgetting personal memory discards ephemeral group context so erased facts cannot leak back through recent messages',async()=>{
  const f=await ready({handler:async text=>text==='清空我的记忆'?{text:'已经清空',memoryReset:true,requiredAccess:'chat'}:null});
  await f.core.handleMessage(group('我叫需要忘掉的名字','old-name'));
  await f.core.handleMessage(group('梁祖 清空我的记忆','forget-memory'));
  const next=await probe(f,'after-forget');
  assert.ok(next.groupContext.every(row=>!row.text.includes('需要忘掉的名字')));
});

test('allowed ordinary group messages keep only the preceding ten anonymous entries without writes or handler work',async()=>{
  const f=await ready(),before=f.state(),writes=f.writes.length;
  for(let i=0;i<12;i++)assert.equal((await f.core.handleMessage(group('普通消息'+i,'ordinary-'+i))).code,'IGNORED');
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);assert.equal(f.writes.length,writes);assert.deepEqual(f.state(),before);
  const context=await probe(f);
  assert.deepEqual(context.groupContext.map(row=>row.text),Array.from({length:10},(_,i)=>'普通消息'+(i+2)));
  assert.ok(context.groupContext.every(row=>row.speaker===context.currentSpeaker&&row.role==='member'));
  assert.equal(context.currentSpeaker,'member-'+hash('group-sender:'+A+':'+MEMBER).slice(0,12));
  assert.equal(context.scope,'group');assert.equal(context.sessionKey,hash('chat:group:'+A+':'+MEMBER));
  assert.equal(context.scopeKey,hash('chat-scope-group:'+A));assert.equal(context.userKey,hash('chat-user:'+MEMBER));
  assert.doesNotMatch(JSON.stringify(context),/private-|ordinary-|probe/);
  assert.ok(!JSON.stringify(f.state()).includes('普通消息'));
});

test('groups are isolated, sender pseudonyms are group scoped, and private requests receive no group background',async()=>{
  const f=await ready();
  await f.core.handleMessage(group('甲群话题','a'));await f.core.handleMessage(group('乙群话题','b',B));
  const first=await probe(f,'probe-a',A),second=await probe(f,'probe-b',B);
  assert.deepEqual(first.groupContext.map(row=>row.text),['甲群话题']);assert.deepEqual(second.groupContext.map(row=>row.text),['乙群话题']);
  assert.notEqual(first.currentSpeaker,second.currentSpeaker);assert.notEqual(first.sessionKey,second.sessionKey);
  assert.equal(first.userKey,second.userKey);
  await f.core.handleMessage(privateMessage('本人的问题','private-query'));
  assert.deepEqual(f.calls.at(-1).context,{scope:'c2c',sessionKey:hash('chat:c2c:'+OWNER),scopeKey:hash('chat-scope-c2c:'+OWNER),userKey:hash('chat-user:'+OWNER)});
  const other=await probe(f,'member-two',A,'another-member');
  assert.notEqual(other.currentSpeaker,first.currentSpeaker);assert.notEqual(other.sessionKey,first.sessionKey);
});

test('duplicate IDs, unknown groups, private traffic, management commands and credentials do not enter background',async()=>{
  const f=await ready();
  await f.core.handleMessage(group('保留一条','same-id'));
  await f.core.handleMessage(group('重复内容不得追加','same-id'));
  for(const [i,text] of ['/pair abc','/group-bind '+ 'a'.repeat(32),'/pause','梁祖 /status','梁祖 /resume','请执行 /pair abc','token=private-token-value','apiKey=sk-'+ 'a'.repeat(40)].entries()){
    assert.equal((await f.core.handleMessage(group(text,'control-'+i))).code,'IGNORED');
  }
  assert.equal((await f.core.handleMessage(group('不允许的群消息','unknown','unknown-group'))).code,'GROUP_DENIED');
  assert.equal((await f.core.handleMessage(privateMessage('别人的私聊','unknown-private','other-owner'))).code,'SENDER_DENIED');
  await f.core.handleMessage(privateMessage('本人的私聊','own-private'));
  const context=await probe(f);
  assert.deepEqual(context.groupContext.map(row=>row.text),['保留一条']);
  assert.doesNotMatch(JSON.stringify(f.state()),/private-token-value|保留一条|重复内容|本人的私聊/);
});

test('unpaired and unconfirmed groups retain no conversation after later authorization',async()=>{
  const unpaired=await ready({paired:false});
  assert.equal((await unpaired.core.handleMessage(group('未配对内容','unpaired'))).code,'NOT_PAIRED');
  assert.equal(unpaired.calls.length,0);
  const f=await ready({groups:[]}),binding=await f.core.startGroupPairing({name:'新群'});
  assert.equal((await f.core.handleMessage(group('未授权内容','before-bind'))).code,'GROUP_DENIED');
  const candidate=await f.core.handleMessage(group('/group-bind '+binding.groupPairingCode,'bind'));
  assert.equal(candidate.code,'GROUP_PAIRING_PENDING');
  assert.equal((await f.core.handleMessage(group('待确认内容','candidate'))).code,'GROUP_DENIED');
  await f.core.confirmGroupPairing({groupKey:candidate.groupKey});
  assert.deepEqual((await probe(f)).groupContext,[]);
});

test('a persisted duplicate trigger cannot repopulate cleared context after restart',async()=>{
  const f=await ready();
  await f.core.handleMessage(group('梁祖 先前已处理请求','processed'));
  const restarted=new BridgeCore(f.deps);await restarted.init();
  assert.equal((await restarted.handleMessage(group('梁祖 先前已处理请求','processed'))).code,'DUPLICATE');
  await restarted.handleMessage(group('梁祖 重启后的新请求','new-request'));
  assert.deepEqual(f.calls.at(-1).context.groupContext,[]);
});

test('context text is sanitized and capped at 240 Unicode code points before it reaches a handler',async()=>{
  const f=await ready();
  await f.core.handleMessage(group('<@!123456789> @全体成员 https://example.test/path '+ '鱼'.repeat(300),'long'));
  const context=await probe(f),text=context.groupContext[0].text;
  assert.ok([...text].length<=240);assert.doesNotMatch(text,/@|123456789|https:|example\.test/);
});

test('thirty-minute TTL, pause and disconnect discard ephemeral group background without persistence',async()=>{
  const f=await ready();
  await f.core.handleMessage(group('旧消息','old'));f.clock.now+=30*60_000;
  assert.deepEqual((await probe(f,'after-ttl')).groupContext,[]);
  await f.core.setPaused(true);
  assert.equal((await f.core.handleMessage(group('暂停中消息','paused'))).code,'PAUSED');
  await f.core.setPaused(false);
  assert.deepEqual((await probe(f,'after-resume')).groupContext,[]);
  await f.core.handleMessage(group('断开前消息','before-disconnect'));
  await f.core.cancelPairing();
  assert.deepEqual((await probe(f,'after-disconnect')).groupContext,[]);
  const restarted=new BridgeCore(f.deps);await restarted.init();
  await restarted.handleMessage(group('梁圣 重启查询','restart'));
  assert.deepEqual(f.calls.at(-1).context.groupContext,[]);
});

test('removing one allowed group clears only that group, including when it is later re-added',async()=>{
  const f=await ready();
  await f.core.handleMessage(group('甲群旧消息','a'));await f.core.handleMessage(group('乙群保留消息','b',B));
  await f.core.removeAllowedGroup({groupKey:hash('group:'+A)});
  assert.equal((await f.core.handleMessage(group('已移除消息','removed'))).code,'GROUP_DENIED');
  const binding=await f.core.startGroupPairing({name:'重新授权'});
  const candidate=await f.core.handleMessage(group('/group-bind '+binding.groupPairingCode,'rebind'));
  await f.core.confirmGroupPairing({groupKey:candidate.groupKey});
  assert.deepEqual((await probe(f,'a-again')).groupContext,[]);
  assert.deepEqual((await probe(f,'b-still',B)).groupContext.map(row=>row.text),['乙群保留消息']);
});

test('only successful ordinary group replies add fish text or a fixed image summary, never active broadcasts',async()=>{
  const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
  const f=await ready({handler:async text=>text==='说句话'?{text:'鱼来啦 @everyone https://example.test'}:text==='给张图'?{text:'',image}:null});
  assert.equal((await f.core.handleMessage(group('梁祖 说句话','chat'))).code,'SENT');
  const first=await probe(f,'check-text');
  assert.equal(first.groupContext[1].speaker,'fish');assert.equal(first.groupContext[1].role,'assistant');
  assert.match(first.groupContext[1].text,/鱼来啦/);assert.doesNotMatch(first.groupContext[1].text,/@|https:/);
  assert.equal((await f.core.handleMessage(group('梁祖 给张图','image'))).code,'SENT');
  await f.core.notifyAllAllowed({text:'主动管理员广播不得入背景',idempotencyKey:'admin-broadcast'});
  const second=await probe(f,'check-image');
  assert.ok(second.groupContext.some(row=>row.speaker==='fish'&&row.role==='assistant'&&row.text==='[已发送查询图片]'));
  assert.ok(second.groupContext.every(row=>!row.text.includes('管理员广播')));
  assert.doesNotMatch(JSON.stringify(f.state()),/鱼来啦|已发送查询图片|管理员广播|image\/png/);
});

test('failed delivery clears group background and cannot leave a successful fish reply',async()=>{
  const f=await ready({handler:async text=>text==='触发失败'?{text:'不会发成功'}:null,send:async()=>{throw new Error('network');}});
  await f.core.handleMessage(group('此前聊天','before'));
  assert.equal((await f.core.handleMessage(group('梁祖 触发失败','failed'))).code,'DELIVERY_UNCERTAIN');
  await f.core.setPaused(false);
  assert.deepEqual((await probe(f)).groupContext,[]);
});

test('group background updates while a model is pending, but each trigger sees its receipt-time snapshot only',async()=>{
  const entered=deferred(),release=deferred();
  const f=await ready({handler:async text=>{if(text==='第一个请求'){entered.resolve();await release.promise;return {text:'稍后发出的回答'};}return null;}});
  await f.core.handleMessage(group('最初背景','initial'));
  const first=f.core.handleMessage(group('梁祖 第一个请求','first'));await entered.promise;
  assert.equal((await f.core.handleMessage(group('等待期间背景','during'))).code,'IGNORED');
  const second=f.core.handleMessage(group('梁祖 第二个请求','second'));
  await f.core.handleMessage(group('第二个请求之后的未来消息','future'));
  release.resolve();await Promise.all([first,second]);
  assert.deepEqual(f.calls[0].context.groupContext.map(row=>row.text),['最初背景']);
  assert.deepEqual(f.calls[1].context.groupContext.map(row=>row.text),['最初背景','第一个请求','等待期间背景']);
  const third=await probe(f,'third');
  assert.ok(third.groupContext.some(row=>row.text==='第二个请求之后的未来消息'));
  assert.ok(third.groupContext.some(row=>row.text==='稍后发出的回答'));
});

test('pending and in-flight queries share a four-request cap while ordinary group chatter and notifications remain available',async()=>{
  const entered=deferred(),release=deferred();
  const f=await ready({handler:async text=>{if(text==='阻塞'){entered.resolve();await release.promise;}return null;}});
  const first=f.core.handleMessage(group('梁祖 阻塞','first'));await entered.promise;
  const accepted=[f.core.handleMessage(group('梁圣 请求二','q2')),f.core.handleMessage(privateMessage('请求三','q3')),f.core.handleMessage(group('梁嗨 请求四','q4',B))];
  for(let i=0;i<20;i++)assert.equal((await f.core.handleMessage(group('小难梁 超量请求','extra-'+i))).code,'BUSY');
  assert.equal((await f.core.handleMessage(group('背景仍可记录','background'))).code,'IGNORED');
  assert.equal((await f.core.handleMessage(group('梁圣 未知群','unknown','not-allowed'))).code,'GROUP_DENIED');
  assert.equal((await f.core.handleMessage(privateMessage('陌生私聊','stranger','not-owner'))).code,'SENDER_DENIED');
  const status=f.core.handleMessage(privateMessage('/status','status'));
  const notification=f.core.notify({text:'独立主动通知',idempotencyKey:'notice'});
  release.resolve();await Promise.all([first,...accepted,status,notification]);
  assert.equal(f.calls.length,4);assert.equal(f.sent.length,2);
  assert.equal((await f.core.handleMessage(group('梁祖 配额释放','after'))).code,'IGNORED');assert.equal(f.calls.length,5);
});

test('pause bypasses a full query queue, blocks subsequent handlers immediately and clears context',async()=>{
  const entered=deferred(),release=deferred();
  const f=await ready({handler:async()=>{entered.resolve();await release.promise;return {text:'不能再发送'};}});
  await f.core.handleMessage(group('暂停前背景','background'));
  const first=f.core.handleMessage(group('梁祖 第一问','first'));await entered.promise;
  const queued=[f.core.handleMessage(group('梁祖 第二问','second')),f.core.handleMessage(privateMessage('第三问','third')),f.core.handleMessage(group('梁祖 第四问','fourth'))];
  const pause=f.core.handleMessage(privateMessage('/pause','pause'));
  assert.equal((await f.core.handleMessage(group('暂停后不得记录','after-pause'))).code,'PAUSED');
  release.resolve();const results=await Promise.all([first,...queued,pause]);
  assert.ok(results.every(item=>item.code==='PAUSED'));assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
  await f.core.setPaused(false);await probe(f,'resumed');
  assert.deepEqual(f.calls.at(-1).context.groupContext,[]);
});

test('public group help and ping plus private help consume the same bounded incoming capacity',async()=>{
  const entered=deferred(),release=deferred();
  const f=await ready({handler:async text=>{if(text==='阻塞'){entered.resolve();await release.promise;}return null;}});
  const first=f.core.handleMessage(group('梁祖 阻塞','first'));await entered.promise;
  const accepted=[f.core.handleMessage(group('梁祖 /help','help')),f.core.handleMessage(group('梁圣 /ping','ping')),
    f.core.handleMessage(privateMessage('/help','private-help'))];
  for(const [i,text] of ['梁祖 /help','梁圣 /ping','梁嗨 帮助','小难梁 菜单'].entries()){
    assert.equal((await f.core.handleMessage(group(text,'overflow-'+i))).code,'BUSY');
  }
  assert.equal((await f.core.handleMessage(privateMessage('/ping','private-overflow'))).code,'BUSY');
  const status=f.core.handleMessage(privateMessage('/status','owner-status'));
  release.resolve();const results=await Promise.all([first,...accepted,status]);
  assert.ok(results.every(item=>item.code!=='BUSY'));assert.equal(f.sent.length,3);
});

test('group pairing candidates cannot flood the queue while a model is pending',async()=>{
  const entered=deferred(),release=deferred();
  const f=await ready({handler:async()=>{entered.resolve();await release.promise;return null;}});
  const binding=await f.core.startGroupPairing({name:'候选群'});
  const first=f.core.handleMessage(group('梁祖 阻塞','first'));await entered.promise;
  const accepted=Array.from({length:3},(_,i)=>f.core.handleMessage(group('/group-bind '+binding.groupPairingCode,'candidate-'+i,'new-group-'+i)));
  for(let i=0;i<20;i++)assert.equal((await f.core.handleMessage(group('/group-bind '+binding.groupPairingCode,'overflow-'+i,'overflow-group-'+i))).code,'BUSY');
  release.resolve();const results=await Promise.all([first,...accepted]);
  assert.equal(results.filter(item=>item.code==='GROUP_PAIRING_PENDING').length,1);
  assert.equal(results.filter(item=>item.code==='GROUP_DENIED').length,2);
  assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
});

test('unpaired private pairing attempts are capacity limited while confirmation persistence is pending',async()=>{
  const entered=deferred(),release=deferred();let block=false;
  const f=await ready({paired:false,beforeSave:async value=>{if(block&&value.ownerId){entered.resolve();await release.promise;}}});
  const pairing=await f.core.startPairing();
  await f.core.handleMessage(privateMessage('/pair '+pairing.pairingCode,'pair-owner'));
  block=true;const confirm=f.core.confirmPairing();await entered.promise;
  const accepted=Array.from({length:4},(_,i)=>f.core.handleMessage(privateMessage('/pair '+pairing.pairingCode,'candidate-'+i,'other-'+i)));
  for(let i=0;i<20;i++)assert.equal((await f.core.handleMessage(privateMessage('/pair '+pairing.pairingCode,'overflow-'+i,'overflow-owner-'+i))).code,'BUSY');
  release.resolve();assert.equal((await confirm).code,'PAIRED');
  assert.ok((await Promise.all(accepted)).every(item=>item.code==='SENDER_DENIED'));
  assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
});

test('caller mutation cannot change the captured sender, target or trigger snapshot after admission',async()=>{
  const entered=deferred(),release=deferred();
  const f=await ready({handler:async text=>{if(text==='阻塞'){entered.resolve();await release.promise;}return null;}});
  const first=f.core.handleMessage(group('梁祖 阻塞','first'));await entered.promise;
  const request=group('梁祖 原始请求','queued'),queued=f.core.handleMessage(request);
  request.senderId='attacker';request.groupId=B;request.text='梁祖 被替换请求';request.replyTarget.targetId=B;
  release.resolve();await Promise.all([first,queued]);
  assert.equal(f.calls[1].text,'原始请求');assert.equal(f.calls[1].context.scopeKey,hash('chat-scope-group:'+A));
  assert.equal(f.calls[1].context.userKey,hash('chat-user:'+MEMBER));
});
