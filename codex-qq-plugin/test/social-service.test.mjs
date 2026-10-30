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
