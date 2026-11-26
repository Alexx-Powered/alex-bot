import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeCore} from '../src/core.mjs';
import {CampusService} from '../src/campus-service.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';

const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
const owner=(id,text)=>({kind:'c2c',senderId:'owner',id,text,replyTarget:{scope:'c2c',targetId:'owner',msgId:id}});
async function coreFixture({send,limits={},handler}={}){
  let fetched=0;const sent=[];
  const agent=new ConversationAgent({
    campusTools:{workerGrant:async()=>({code:'OK'})},configStore:{read:async()=>null},
    modelBudget:{acquire:()=>assert.fail('fixed command must not use a model')},
    worker:{run:async(_packet,_execute,finish,authorize,events)=>{
      const tool='buaa_classroom_query';
      if(!await authorize('campus',tool))return finish({kind:'clarify',reason:'restricted_access'});
      if(!await events.progress('campus-fetch'))return finish({kind:'attachment',tool,reply:{cancelled:true}});
      fetched++;assert.equal(sent[0]?.text,'正在抓取数据');
      return finish({kind:'attachment',tool,reply:{text:'',image}});
    }}
  });
  const core=new BridgeCore({loadState:async()=>null,saveState:async()=>{},limits:{dailyAttempts:300,minuteAttempts:30,reservedNotifications:10,...limits},
    send:async request=>{sent.push(request);await send?.(request,core);return {ok:true};},
    commandHandler:handler||((text,context)=>agent.handle(text,context))});
  await core.init();const pair=await core.startPairing();await core.handleMessage(owner('pair','/pair '+pair.pairingCode));await core.confirmPairing();
  return {core,sent,fetched:()=>fetched};
}

test('fresh current-time query acknowledgement explicitly labels the upcoming recommendation image',async()=>{
  const f=await coreFixture({handler:async(_text,context)=>{
    assert.equal(await context.progress('campus-fetch-current'),true);
    assert.equal(await context.progress('campus-fetch'),false);
    return {image,text:''};
  }});
  assert.equal((await f.core.handleMessage(owner('instant','现在刷新一下可用教室'))).code,'SENT');
  assert.equal(f.sent[0].text,'正在抓取数据，随后生成当前推荐图');assert.equal(f.sent.length,2);
});

test('campus request sends a durable acknowledgement before crawling and then a single image; duplicate input does nothing',async()=>{
  const f=await coreFixture();
  assert.equal((await f.core.handleMessage(owner('query','查空教室'))).code,'SENT');
  assert.equal(f.sent.length,2);assert.equal(f.sent[0].text,'正在抓取数据');assert.equal(f.sent[1].text,'');
  assert.equal(f.sent[1].image,image);assert.equal(f.fetched(),1);assert.equal(f.core.status().dailyAttempts,2);
  assert.equal((await f.core.handleMessage(owner('query','查空教室'))).code,'DUPLICATE');assert.equal(f.sent.length,2);
});

test('acknowledgement failure, immediate pause, or insufficient two-send capacity never starts crawling',async()=>{
  const failed=await coreFixture({send:async()=>{throw Error('offline transport failure');}});
  await failed.core.handleMessage(owner('query','查空教室'));assert.equal(failed.fetched(),0);assert.equal(failed.sent.length,1);assert.equal(failed.core.status().paused,true);
  let pause;
  const paused=await coreFixture({send:async(_request,core)=>{pause=core.setPaused(true);}});
  await paused.core.handleMessage(owner('query','查空教室'));await pause;
  assert.equal(paused.fetched(),0);assert.equal(paused.sent.length,1);
  const limited=await coreFixture({limits:{minuteAttempts:1}});
  await limited.core.handleMessage(owner('query','查空教室'));assert.equal(limited.fetched(),0);assert.equal(limited.sent.length,0);
});

test('white group receives its own acknowledgement and image; gray receives neither data nor acknowledgement',async()=>{
  const f=await coreFixture();
  async function add(groupId,access){
    const pair=await f.core.startGroupPairing({name:groupId,access});
    const event={kind:'group',groupId,senderId:'member',id:'bind-'+groupId,text:'/group-bind '+pair.groupPairingCode,replyTarget:{scope:'group',targetId:groupId,msgId:'bind-'+groupId}};
    const captured=await f.core.handleMessage(event);await f.core.confirmGroupPairing({groupKey:captured.groupKey});
    return {...event,id:'query-'+groupId,text:'梁祖 查空教室',replyTarget:{scope:'group',targetId:groupId,msgId:'query-'+groupId}};
  }
  const white=await add('white-group','white');assert.equal((await f.core.handleMessage(white)).code,'SENT');
  assert.equal(f.sent.length,2);assert.ok(f.sent.every(r=>r.groupId==='white-group'&&r.requiredAccess==='white'));
  const gray=await add('gray-group','gray');await f.core.handleMessage(gray);
  assert.equal(f.fetched(),1);assert.equal(f.sent.filter(r=>r.text==='正在抓取数据').length,1);
  assert.ok(!f.sent.at(-1).image);
});

test('natural follow-up executes in one worker request with a credential-free recommendation grant and rechecks group permission',async()=>{
  const packets=[];let allowed=true,budgets=0;
  const campusTools=new CampusService({home:'unused',worker:{},configStore:{status:async()=>({configured:true,enabled:true}),read:()=>assert.fail('no credentials needed')}});
  const agent=new ConversationAgent({campusTools,
    configStore:{read:async()=>({enabled:true,apiKey:'offline-model-key'})},modelBudget:{acquire:async()=>{budgets++;return {ok:true};}},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),
    worker:{run:async(payload,_execute,finish,authorize)=>{
      packets.push(payload);
      assert.equal(payload.type,'request');
      assert.deepEqual(await authorize('campus','buaa_classroom_recommend'),{code:'OK'});
      return finish({kind:'attachment',tool:'buaa_classroom_recommend',reply:{text:'',image}});
    }}});
  const context={scope:'group',access:'white',groupContext:[],authorize:()=>allowed};
  const reply=await agent.handle('推荐一下晚上的教室，多推荐几个',context);
  assert.equal(reply.requiredAccess,'white');assert.equal(reply.image,image);assert.equal(packets.length,1);assert.equal(budgets,1);
  assert.doesNotMatch(JSON.stringify(packets),/offline-student|offline-password/);
  allowed=false;assert.equal(await agent.handle('现在想换教室推荐去哪',context),null);assert.equal(packets.length,1);
});
