import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeCore} from '../src/core.mjs';
import {CampusService,campusFailure} from '../src/campus-service.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';

const image={buffer:Buffer.alloc(16),mimeType:'image/png'};
const owner=(id,text)=>({kind:'c2c',senderId:'owner',id,text,replyTarget:{scope:'c2c',targetId:'owner',msgId:id}});
const snapshot=(date='2026-10-29')=>({...campusFailure('OK',date),ok:true,fetched_at:'2026-10-29T09:00:00+08:00',
  buildings:['三号楼'],rooms:[{building:'三号楼',room:'105',free_periods:Array.from({length:14},(_,i)=>i+1),busy_periods:[]}]});
const report=()=>({schema_version:'buaa-recommendations.v1',ok:true,code:'OK',date:'2026-10-29',now:'2026-10-29T16:00:00+08:00',fetched_at:'2026-10-29T09:00:00+08:00',session:'晚上',
  message:'105（小，1级）19:00—22:15，稍后可用',candidates:[{room:'105',small:true,tier:1,start_period:11,end_period:14,usable_from:'19:00',usable_until:'22:15',available_now:false,complete_remaining:true,period5_busy:false,full_afternoon:true}]});

async function coreFixture({send,limits={},handler}={}){
  let fetched=0;const sent=[];
  const campus=new CampusService({home:'D:/unused',configStore:{},worker:{close(){}}});
  campus.run=async()=>{fetched++;assert.equal(sent[0]?.text,'正在抓取数据');return {data:snapshot(),image};};
  const core=new BridgeCore({loadState:async()=>null,saveState:async()=>{},limits:{dailyAttempts:300,minuteAttempts:30,reservedNotifications:10,...limits},
    send:async request=>{sent.push(request);await send?.(request,core);return {ok:true};},
    commandHandler:handler||((text,context)=>campus.handle(text,context))});
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

test('query snapshots persist in bounded private memory, restore after restart and recommendations never read credentials',async t=>{
  const home=await mkdtemp(join(tmpdir(),'qq-campus-memory-'));t.after(()=>rm(home,{recursive:true,force:true}));
  let credentialReads=0;const calls=[];
  const config={status:async()=>({enabled:true,configured:true}),read:async()=>{credentialReads++;return {enabled:true,username:'offline-student',password:'offline-password'};}};
  const worker={close(){},run:async(payload,_execute,finish)=>{
    calls.push(payload);
    return finish(payload.mode==='recommend'?{recommendation:report()}:{data:snapshot(payload.args.date),artifact_id:null,...(payload.mode==='report'?{render_error:true}:{})});
  }};
  const service=new CampusService({home,configStore:config,worker,now:()=>Date.parse('2026-10-29T08:00:00Z')});
  for(let i=-1;i<=7;i++)await service.run({date:new Date(Date.parse('2026-10-29T00:00:00Z')+i*86400000).toISOString().slice(0,10)});
  const saved=JSON.parse(await readFile(join(home,'.private','campus-output','memory.json'),'utf8'));
  assert.equal(saved.snapshots.length,8);assert.equal(saved.snapshots[0].date,'2026-10-29');
  assert.doesNotMatch(JSON.stringify(saved),/offline-student|offline-password/);
  assert.equal((await service.run({date:'2026-10-29'},'report')).data.code,'CAMPUS_RENDER_FAILED');
  const restored=new CampusService({home,configStore:config,worker,now:()=>Date.parse('2026-10-29T08:00:00Z')});
  const before=credentialReads;
  const result=await restored.recommend({session:'evening',limit:8},{scope:'c2c'});
  assert.equal(credentialReads,before);assert.equal(result.campusRecommendation.candidates[0].room,'105');
  const request=calls.at(-1);assert.equal(request.mode,'recommend');assert.equal(request.snapshot.date,'2026-10-29');assert.equal(request.now,'2026-10-29T08:00:00.000Z');
  assert.equal(Object.hasOwn(request,'credentials'),false);
  const count=calls.length;await restored.recommend({},{scope:'group',access:'gray'});assert.equal(calls.length,count);
  await restored.recommend({now:'2000-01-01'},{scope:'c2c'});assert.equal(calls.length,count);
});

test('natural follow-up uses cached tool then a separate model-only explanation and rechecks group permission',async()=>{
  const packets=[];let allowed=true,budgets=0;
  const agent=new ConversationAgent({campusTools:{handle:async()=>null,recommend:async()=>({text:report().message,campusRecommendation:report(),requiredAccess:'white'})},
    toolbox:{handle:async()=>null,execute:async()=>assert.fail('no weather')},
    configStore:{read:async()=>({enabled:true,apiKey:'offline-model-key'})},modelBudget:{acquire:async()=>{budgets++;return {ok:true};}},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),
    worker:{run:async(payload,execute,finish)=>{
      packets.push(payload);
      if(payload.type==='request')return execute('buaa_classroom_recommend',{session:'evening',limit:8});
      assert.equal(payload.type,'campus_advice');assert.equal(payload.report.now,'2026-10-29T16:00:00+08:00');
      await assert.rejects(execute('any',{}),/ADVICE_TOOL_DENIED/);
      return finish({kind:'reasoned',source:'campus-recommendation',text:'北京时间16:00，09:00采集的缓存。\n105，19:00—22:15，稍后可用。'});
    }}});
  const context={scope:'group',access:'white',groupContext:[],authorize:()=>allowed};
  const reply=await agent.handle('推荐一下晚上的教室，多推荐几个',context);
  assert.equal(reply.requiredAccess,'white');assert.match(reply.text,/105/);assert.equal(packets.length,2);assert.equal(budgets,1);
  assert.doesNotMatch(JSON.stringify(packets),/offline-student|offline-password/);
  allowed=false;assert.equal(await agent.handle('现在想换教室推荐去哪',context),null);assert.equal(packets.length,2);
});
