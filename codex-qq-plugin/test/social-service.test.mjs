import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {APP_ROOT} from '../src/runtime-paths.mjs';
import {SocialService} from '../src/social-service.mjs';
import {SocialConfigStore} from '../src/social-config.mjs';
import {incomingMedia} from '../src/incoming-media.mjs';
import {BridgeCore} from '../src/core.mjs';
import {QQAdapter} from '../src/qq-adapter.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
const key=v=>createHash('sha256').update(String(v)).digest('hex');
const context=()=>({scope:'group',access:'white',sessionKey:key('a:u'),scopeKey:key('a'),isAllowed:()=>true});
const cfg={enabled:true,autoWhiteImages:true,autoMemes:true,asrEnabled:false,apiKey:''};

test('attachment projection accepts QQ media only, including server transcripts; text URLs and quoted content are not media',()=>{
  const a=incomingMedia([{content_type:'image/gif',url:'//gchat.qpic.cn/a'},{content_type:'audio/wav',url:'https://evil.test/a',voice_wav_url:'https://multimedia.nt.qq.com/a',asr_refer_text:'你好'}]);
  assert.equal(a.length,2);assert.equal(a[0].animated,true);assert.equal(a[1].transcript,'你好');
  assert.equal(incomingMedia([{content_type:'image/jpeg',url:'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=fixture'}]).length,1);
  assert.equal(incomingMedia([{content_type:'voice',url:'https://qqbot.ugcimg.cn/fixture.wav'}])[0].kind,'audio');
  assert.deepEqual(incomingMedia([{content_type:'image/png',url:'https://gchat.qpic.cn.evil.test/a'}]),[]);
});

test('encrypted media config never exposes the key and blank omission preserves it',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'social-config-'));
  const protect=async v=>Buffer.from(JSON.stringify(v)).toString('base64'),unprotect=async v=>JSON.parse(Buffer.from(v,'base64'));
  try{
    await fs.mkdir(path.join(home,'.private'),{mode:0o700});
    const store=new SocialConfigStore(home,{protect,unprotect});
    assert.equal((await store.status()).asrEnabled,false);
    await store.save({asrEnabled:true,apiKey:'fixture-asr-key'});
    assert.equal((await store.read()).apiKey,'fixture-asr-key');
    await store.save({autoMemes:false});assert.equal((await store.read()).apiKey,'fixture-asr-key');
    assert.doesNotMatch(JSON.stringify(await store.status()),/fixture-asr-key|cipher/);
    await assert.rejects(()=>store.save({baseURL:'https://evil.test'}));
  }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('core observes unaddressed allowed-group members without replies or joining the command queue',async()=>{
  const observed=[],commands=[],sent=[];
  const core=new BridgeCore({loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,allowedGroups:[{id:'g',name:'g'}]}),saveState:async()=>{},send:async r=>{sent.push(r);return {ok:true};},commandHandler:async(t,c)=>{commands.push({t,c});return null;},observeMessage:(data,c)=>observed.push({data,c})});
  await core.init();
  const msg=(text,id,groupId='g')=>({kind:'group',groupId,id,senderId:'member',text,replyTarget:{scope:'group',targetId:groupId,msgId:id}});
  assert.equal((await core.handleMessage(msg('我很开心','1'))).code,'IGNORED');
  assert.equal(observed.length,1);assert.equal(commands.length,0);assert.equal(sent.length,0);
  await core.handleMessage(msg('/识图','2'));assert.equal(commands.at(-1).t,'/识图');
  await core.handleMessage(msg('/记忆 关闭','3'));assert.equal(commands.at(-1).t,'/记忆 关闭');
  await core.handleMessage(msg('我很难过','4','denied'));assert.equal(observed.length,3);
  await core.setPaused(true);await core.handleMessage(msg('我好累','5'));assert.equal(observed.length,3);
  assert.equal(observed[0].c.isAllowed(),false);
});

test('social worker invokes real Python LangChain memory across the protocol and survives a process restart',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'social-real-'));
  const workerPath=path.join(APP_ROOT,'python/social_worker.py');
  let worker=new PythonAgentWorker({home,workerPath});
  const run=args=>worker.run({type:'social',args},async()=>{throw Error('NO_RPC');},v=>v.report);
  const base={namespace:key('a:u'),scope:key('a')};
  try{
    assert.equal((await run({...base,action:'observe',event:key('1'),text:'我喜欢安静的小教室'})).ok,true);
    worker.close();worker=new PythonAgentWorker({home,workerPath});
    assert.equal((await run({...base,action:'recall'})).preferences[0].text,'我喜欢安静的小教室');
    await run({...base,action:'off'});
    assert.equal((await run({...base,action:'observe',event:key('2'),text:'我很开心'})).disabled,true);
    assert.equal((await run({...base,action:'recall'})).disabled,true);
  }finally{worker.close();await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:80});}
});

test('/识图 selects only the most recent attachment and never treats its URL as a command argument',async()=>{
  const seen=[];
  const memoryWorker={close(){},async run(p,_rpc,finish){return finish({report:p.args.action==='recall'?{ok:true,mood:[],style:{},media:[],preferences:[]}:{ok:true,observed:true}});}};
  const mediaWorker={close(){},async run(p,_rpc,finish){seen.push(p);return finish({report:{ok:true,description:'一条鱼',visible_text:'',is_meme:true}});}};
  const service=new SocialService({configStore:{read:async()=>cfg},agentConfigStore:{read:async()=>({enabled:true,apiKey:'fixture-key'})},memoryWorker,mediaWorker});
  try{
    const c=context();await service.observe({eventKey:key('1'),text:'[图片]',media:[{kind:'image',url:'https://gchat.qpic.cn/first'}]},c);
    await service.observe({eventKey:key('2'),text:'[图片]',media:[{kind:'image',url:'https://gchat.qpic.cn/last'}]},c);
    const answer=await service.prepare('/识图',c);
    assert.equal(answer.media.description,'一条鱼');assert.equal(seen.at(-1).attachment.url,'https://gchat.qpic.cn/last');
    assert.ok(!answer.text.includes('https:'));assert.equal((await service.prepare('/识图',{...c,scopeKey:key('other')})).reply.includes('还没收到'),true);
  }finally{service.close();}
});

test('image questions use the current attachment and share only the same question in flight',async()=>{
  const seen=[];
  const memoryWorker={close(){},async run(_p,_rpc,finish){return finish({report:{ok:true,observed:true}});}};
  const mediaWorker={close(){},async run(p,_rpc,finish){
    seen.push(p);
    return finish({report:{ok:true,description:p.question||'通用描述'}});
  }};
  const service=new SocialService({configStore:{read:async()=>cfg},agentConfigStore:{read:async()=>({enabled:true,apiKey:'fixture'})},memoryWorker,mediaWorker});
  const c=context();
  const media=[{kind:'image',url:'https://gchat.qpic.cn/current'}];
  const question='这张图右下角的编号是什么？';
  try{
    await service.observe({eventKey:key('other'),text:'随手发图',media:[{kind:'image',url:'https://gchat.qpic.cn/old'}]},c);
    await service.prepare(question,{...c,media,mediaEventKey:key('current')});
    assert.equal(seen.at(-1).attachment.url,media[0].url);
    assert.equal(seen.at(-1).question,question);
    await service.observe({eventKey:key('current'),text:question,media,addressed:true},c);
    const same=await service.prepare(question,{...c,media,mediaEventKey:key('current')});
    assert.equal(same.media.description,question);
    assert.equal(seen.filter(p=>p.question===question).length,1);
    const followup=await service.prepare('/识图 左上角是什么？',c);
    assert.equal(followup.media.description,'左上角是什么？');
    assert.notEqual(seen.at(-1).attachment.event,seen.find(p=>p.question===question).attachment.event);
  }finally{service.close();}
});

test('official adapter admits pure-image and pure-voice messages without manufacturing text or sends',async()=>{
  const handlers=new Map(),received=[];let finish;
  const bot={on:(name,fn)=>handlers.set(name,fn),start:()=>new Promise(r=>{finish=r;}),stop:()=>finish?.()};
  const now=Date.now(),adapter=new QQAdapter({createBot:()=>bot,now:()=>now,onMessage:m=>received.push(m)});
  await adapter.connect({appId:'123',appSecret:'fixture'});await handlers.get('ready')({});
  for(const [id,attachment] of [['1',{content_type:'image/png',url:'https://gchat.qpic.cn/a'}],['2',{content_type:'audio/wav',voice_wav_url:'https://multimedia.nt.qq.com/a',asr_refer_text:'我今天很开心'}]]){
    await handlers.get('message')({}, {kind:'group',rawEventType:'GROUP_AT_MESSAGE_CREATE',groupOpenid:'g',senderId:'u',messageId:id,timestamp:new Date(now).toISOString(),content:'',attachments:[attachment],replyTarget:{scope:'group',targetId:'g',msgId:id}});
  }
  assert.equal(received.length,2);assert.equal(received[0].media[0].kind,'image');assert.equal(received[1].media[0].transcript,'我今天很开心');
  assert.equal(received[0].mentioned,true);await adapter.disconnect();
});

test('native private voice respects memory opt-out and uses the existing media worker without an ASR key',async()=>{
  let disabled=true, reads=0;
  const memoryWorker={close(){},async run(p,_rpc,finish){return finish({report:{ok:true,disabled}});}};
  const mediaWorker={close(){},async run(p,_rpc,finish){
    assert.equal(p.attachment.url,'');assert.equal(p.attachment.transcript,'查询天气');
    return finish({report:{ok:true,transcript:p.attachment.transcript}});
  }};
  const service=new SocialService({configStore:{read:async()=>cfg},agentConfigStore:{read:async()=>({enabled:true})},memoryWorker,mediaWorker});
  try{
    const c={...context(),scope:'c2c',mediaEventKey:key('voice'),readVoiceTranscript:async()=>{reads++;return '查询天气';}};
    assert.equal((await service.prepare('[语音]',c)).social.disabled,true);assert.equal(reads,0);
    disabled=false;
    assert.equal((await service.prepare('[语音]',c)).text,'查询天气');assert.equal(reads,1);
  }finally{service.close();}
});

test('clearing memory cancels an already-running media job before it can repopulate old facts',async()=>{
  let resolve,startedResolve;const started=new Promise(r=>startedResolve=r),blocked=new Promise(r=>resolve=r);const writes=[];
  const memoryWorker={close(){},async run(p,_rpc,finish){if(p.args.action==='media')writes.push(p.args);return finish({report:{ok:true,observed:true,mood:[],style:{},media:[],preferences:[]}});}};
  const mediaWorker={close(){},async run(_p,_rpc,finish){startedResolve();return finish({report:await blocked});}};
  const service=new SocialService({configStore:{read:async()=>cfg},agentConfigStore:{read:async()=>({enabled:true,apiKey:'fixture'})},memoryWorker,mediaWorker});
  const c=context();
  try{
    await service.observe({text:'[图片]',eventKey:key(1),media:[{kind:'image',url:'https://gchat.qpic.cn/a'}]},c);await started;
    await service.prepare('/记忆 清空',c);resolve({ok:true,description:'旧图',is_meme:true});
    await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));
    assert.equal(writes.length,0);assert.match((await service.prepare('/识图',c)).reply,/还没收到/);
  }finally{service.close();}
});

test('private passive memory is independent of exhausted reply quota and still stops when paused',async()=>{
  const observed=[],now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10);
  const core=new BridgeCore({loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[{at:now,day}],deliveries:[],incoming:[],lastDeliveryCode:null}),saveState:async()=>{},send:async()=>assert.fail('No quota for reply'),observeMessage:data=>observed.push(data),commandHandler:async()=>({text:'must not send'}),limits:{dailyAttempts:200,minuteAttempts:1,reservedNotifications:10},now:()=>now});
  await core.init();
  await core.handleMessage({kind:'c2c',id:'1',senderId:'owner',text:'我今天好累'});
  assert.equal(observed.length,1);
  await core.setPaused(true);
  await core.handleMessage({kind:'c2c',id:'2',senderId:'owner',text:'我很开心'});
  assert.equal(observed.length,1);
});

test('full offline pipeline keeps a silent image, answers /识图 through real LangChain, and isolates member erasure',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'social-e2e-'));
  const sent=[],handlers=new Map();let finish,core,visionCalls=0;
  const memory=new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python/social_worker.py')});
  const model=new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'test/fixtures/social-chat-worker.py')});
  const mediaWorker={close(){},async run(_p,_rpc,finish){visionCalls++;return finish({report:{ok:true,description:'猫抱着饭碗','visible_text':'饭是我的','is_meme':true}});}};
  const configStore={read:async()=>({enabled:true,apiKey:'fixture-key',model:'deepseek-flash',baseURL:'https://api.deepseek.com'})};
  const social=new SocialService({home,configStore:{read:async()=>cfg},agentConfigStore:configStore,memoryWorker:memory,mediaWorker});
  const agent=new ConversationAgent({worker:model,socialService:social,configStore,toolbox:{handle:async()=>null},policyLoader:async()=>({enabled:true,topics:['群聊闲聊'],maxChars:600,instructions:'自然聊天'}),modelBudget:{acquire:async()=>({ok:true})}});
  const bot={on:(name,fn)=>handlers.set(name,fn),start:()=>new Promise(r=>{finish=r;}),stop:()=>finish?.(),async sendText(target,text){sent.push({target,text});return {id:'fake-result'};}};
  const adapter=new QQAdapter({createBot:()=>bot,onMessage:m=>core.handleMessage(m)});
  core=new BridgeCore({loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,allowedGroups:[{id:'g',name:'g'}]}),saveState:async()=>{},send:r=>adapter.send(r),observeMessage:(d,c)=>social.observe(d,c),commandHandler:(t,c)=>agent.handle(t,c)});
  const emit=async(senderId,id,content,attachments=[])=>handlers.get('message')({}, {kind:'group',rawEventType:'GROUP_MESSAGE_CREATE',groupOpenid:'g',senderId,messageId:id,timestamp:new Date().toISOString(),content,attachments,replyTarget:{scope:'group',targetId:'g',msgId:id}});
  try{
    await core.init();await adapter.connect({appId:'123',appSecret:'fixture'});await handlers.get('ready')({});
    await emit('a','img','',[{content_type:'image/png',url:'https://multimedia.nt.qq.com.cn/download?fileid=fixture'}]);
    assert.equal(sent.length,0);
    await emit('b','see','/识图');assert.match(sent[0].text,/猫.*饭碗/u);assert.equal(sent[0].target.targetId,'g');
    await emit('b','clear','/记忆 清空');
    await emit('b','see-again','/识图');assert.match(sent.at(-1).text,/猫.*饭碗/u);assert.equal(visionCalls,1);
    const recall=async sender=>memory.run({type:'social',args:{action:'recall',namespace:key('chat:group:g:'+sender),scope:key('chat-scope-group:g')}},async()=>{throw Error('NO_RPC');},r=>r.report);
    assert.equal((await recall('a')).media[0].summary.includes('猫'),true);
    assert.equal((await recall('b')).media.length,0);
  }finally{social.close();model.close();await adapter.disconnect();await fs.rm(home,{recursive:true,force:true,maxRetries:6,retryDelay:80});}
});

test('empty audio transcription produces a clear reply rather than a silent empty chat request',async()=>{
  const memoryWorker={close(){},async run(_p,_rpc,finish){return finish({report:{ok:true,observed:true,mood:[],style:{},media:[],preferences:[]}});}};
  const mediaWorker={close(){},async run(_p,_rpc,finish){return finish({report:{ok:true,transcript:'   '}});}};
  const service=new SocialService({configStore:{read:async()=>cfg},agentConfigStore:{read:async()=>({enabled:true,apiKey:'fixture'})},memoryWorker,mediaWorker});
  try{const r=await service.prepare('[语音]',{...context(),media:[{kind:'audio',url:'https://qqbot.ugcimg.cn/a.wav'}]});assert.match(r.reply,/没听清内容/);}finally{service.close();}
});

test('unavailable social storage cannot turn missing media into a hallucinated model observation or reenable memory writes',async()=>{
  const packets=[];
  const agent=new ConversationAgent({socialService:{prepare:async()=>{throw Error('private error must not escape');}},worker:{run:async(p,_rpc,finish)=>{packets.push(p);return finish({kind:'chat',topic:'群聊闲聊',text:'鱼在~'});}},configStore:{read:async()=>({enabled:true,apiKey:'fixture-key'})},toolbox:{handle:async()=>null},policyLoader:async()=>({enabled:true,topics:['群聊闲聊'],maxChars:600}),modelBudget:{acquire:async()=>({ok:true})}});
  assert.match((await agent.handle('/识图',context())).text,/没看清/);
  assert.match((await agent.handle('[语音]',{...context(),media:[{kind:'audio'}]})).text,/没听清/);
  assert.match((await agent.handle('/记忆 清空',context())).text,/更新不了/);
  assert.equal(packets.length,0);
  await agent.handle('我喜欢猫',context());
  assert.equal(packets[0].context.social.disabled,true);assert.equal(packets[0].context.social.unavailable,true);
});

test('memory close takes effect without remaining reply quota or secret-config decryption',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'social-control-'));
  const memory=new PythonAgentWorker({home,workerPath:path.join(APP_ROOT,'python/social_worker.py')});
  const social=new SocialService({home,configStore:{read:async()=>{throw Error('No secret decryption should be needed');}},agentConfigStore:{read:async()=>assert.fail('No model key needed')},memoryWorker:memory,mediaWorker:{close(){}}});
  const now=Date.now(),day=new Date(now+8*3600000).toISOString().slice(0,10);
  const core=new BridgeCore({loadState:async()=>({version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[{at:now,day}],deliveries:[],incoming:[],lastDeliveryCode:null}),saveState:async()=>{},send:async()=>assert.fail('No quota for reply'),commandHandler:async()=>assert.fail('Control should not require the reply queue'),observeMessage:(d,c)=>social.observe(d,c),limits:{dailyAttempts:200,minuteAttempts:1,reservedNotifications:10},now:()=>now});
  try{
    await core.init();await core.handleMessage({kind:'c2c',id:'close',senderId:'owner',text:'/记忆 关闭'});
    const result=await memory.run({type:'social',args:{action:'recall',namespace:key('chat:c2c:owner'),scope:key('chat-scope-c2c:owner')}},async()=>{throw Error('NO_RPC');},r=>r.report);
    assert.equal(result.disabled,true);
  }finally{social.close();await fs.rm(home,{recursive:true,force:true,maxRetries:6,retryDelay:80});}
});

test('observer and interactive handling of one memory command mutate storage only once',async()=>{
  let controls=0;
  const memoryWorker={close(){},async run(p,_rpc,finish){if(p.args.action==='off')controls++;return finish({report:{ok:true,disabled:true}});}};
  const social=new SocialService({configStore:{read:async()=>cfg},agentConfigStore:{read:async()=>assert.fail()},memoryWorker,mediaWorker:{close(){}}});
  const c={...context(),eventKey:key('one-control')};
  try{
    await social.observe({text:'/记忆 关闭',eventKey:c.eventKey,media:[]},c);
    const reply=await social.prepare('/记忆 关闭',c);
    assert.match(reply.reply,/不再记录/);assert.equal(controls,1);
  }finally{social.close();}
});

test('a failed natural-language memory control reports failure without delegating a false success to the model',async()=>{
  const social=new SocialService({configStore:{read:async()=>assert.fail('No config needed')},memoryWorker:{close(){},async run(){throw Error('private storage failure');}},mediaWorker:{close(){}}});
  try{assert.match((await social.prepare('不要再记录我',context())).reply,/没能更新/);}finally{social.close();}
});
