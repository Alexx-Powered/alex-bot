import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BridgeCore} from '../src/core.mjs';
import {DEFAULT_WAKE_WORDS,parseGroupWake} from '../src/wake-words.mjs';
import {createBridgeServer} from '../src/server.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {ConversionToolbox} from '../src/conversion-tools.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';

const key=id=>createHash('sha256').update('group:'+id).digest('hex');
const group=(groupId,id,text,mentioned=false)=>({kind:'group',groupId,id,text,mentioned,senderId:'member',replyTarget:{scope:'group',targetId:groupId,msgId:id}});
function initial() {
  return {version:1,ownerId:'owner',paused:false,pauseReason:null,attempts:[],deliveries:[],incoming:[],lastDeliveryCode:null,
    allowedGroups:[{id:'A',name:'群 A'},{id:'B',name:'群 B'}],grayGroups:[]};
}
async function fixture({state=initial(),handler}={}) {
  let saved=structuredClone(state);const sent=[],queries=[];
  const makeCore=()=>new BridgeCore({loadState:async()=>saved,saveState:async value=>{saved=structuredClone(value);},limits:{minuteAttempts:30},
    send:async value=>{sent.push(value);return {ok:true};},commandHandler:async(text,context)=>{queries.push(text);return handler?handler(text,context):{text:'已处理'};}});
  const core=makeCore();await core.init();
  const change=(operation,data={})=>core.changeWakeWord({operation,revision:core.status().wakeWordRevision,...data});
  const toggle=(groupId,ids)=>core.setGroupWakeWords({groupKey:key(groupId),disabledWakeWords:ids,revision:core.status().wakeWordRevision});
  return {core,sent,queries,change,toggle,makeCore,saved:()=>saved};
}

test('legacy state migrates to the same five words and custom words survive restart',async()=>{
  const f=await fixture();assert.deepEqual(f.core.status().wakeWords,DEFAULT_WAKE_WORDS);
  assert.equal((await f.change('add',{text:'小鲸鱼'})).code,'WAKE_WORDS_SAVED');
  const restored=f.makeCore();await restored.init();
  assert.deepEqual(restored.status().wakeWords,f.core.status().wakeWords);
  assert.equal((await restored.handleMessage(group('A','1','小鲸鱼 你好'))).code,'SENT');
  assert.deepEqual(f.queries,['你好']);
});

test('global add, rename and delete reach both groups; rename keeps each group toggle',async()=>{
  const f=await fixture();await f.change('add',{text:'鲸鲸'});
  const word=f.core.status().wakeWords.at(-1);await f.toggle('A',[word.id]);
  assert.equal((await f.core.handleMessage(group('A','1','鲸鲸 你好'))).code,'IGNORED');
  await f.core.handleMessage(group('B','2','鲸鲸 你好'));
  await f.change('rename',{id:word.id,text:'白饭'});
  assert.equal(f.core.status().wakeWords.at(-1).id,word.id);
  assert.equal((await f.core.handleMessage(group('A','3','白饭 你好'))).code,'IGNORED');
  await f.core.handleMessage(group('B','4','白饭 你好'));
  assert.equal((await f.core.handleMessage(group('B','5','鲸鲸 你好'))).code,'IGNORED');
  await f.change('delete',{id:word.id});
  assert.equal((await f.core.handleMessage(group('B','6','白饭 你好'))).code,'IGNORED');
  assert.deepEqual(f.saved().allowedGroups[0].disabledWakeWords,[]);
  assert.deepEqual(f.queries,['你好','你好']);
});

test('all words can be disabled in one group while mentions and private chat continue working',async()=>{
  const f=await fixture();await f.toggle('A',f.core.status().wakeWords.map(w=>w.id));
  assert.equal((await f.core.handleMessage(group('A','1','大肥鱼 你好'))).code,'IGNORED');
  await f.core.handleMessage(group('A','2','直接提问',true));
  await f.core.handleMessage(group('B','3','大肥鱼 你好'));
  await f.core.handleMessage({kind:'c2c',id:'4',senderId:'owner',text:'私聊不用唤醒词',replyTarget:{scope:'c2c',targetId:'owner',msgId:'4'}});
  assert.deepEqual(f.queries,['直接提问','你好','私聊不用唤醒词']);
  const restored=f.makeCore();await restored.init();
  assert.equal((await restored.handleMessage(group('A','5','梁圣 你好'))).code,'IGNORED');
});

test('literal words never become regexp patterns and strip only one leading word',()=>{
  const words=[{id:'0123456789abcdef',text:'a+b'}];
  assert.deepEqual(parseGroupWake('A+B\t问题',false,words),{command:'问题',addressed:true});
  for(const value of ['aaab 问题','a+b问题','前面 a+b 问题','a+b '])assert.equal(parseGroupWake(value,false,words).addressed,false);
  assert.equal(parseGroupWake('a+b a+b 问题',false,words).command,'a+b 问题');
});

test('word validation, duplicates, count limits and stale page revisions cannot overwrite a newer catalog',async()=>{
  const f=await fixture();
  for(const text of ['', '有 空格','x'.repeat(25),'隐藏\u200b字符'])assert.equal((await f.change('add',{text})).code,'INVALID_WAKE_WORD');
  assert.equal((await f.change('add',{text:'Hello'})).ok,true);
  assert.equal((await f.change('add',{text:'hello'})).code,'WAKE_WORD_EXISTS');
  assert.equal((await f.core.changeWakeWord({operation:'add',text:'新词',revision:0})).code,'WAKE_WORDS_CHANGED');
  assert.equal((await f.core.setGroupWakeWords({groupKey:key('A'),disabledWakeWords:[],revision:0})).code,'WAKE_WORDS_CHANGED');
  assert.equal((await f.toggle('A',['0123456789abcdef'])).code,'INVALID_INPUT');
  while(f.core.status().wakeWords.length<32)await f.change('add',{text:'词'+f.core.status().wakeWords.length});
  assert.equal((await f.change('add',{text:'超出上限'})).code,'WAKE_WORD_LIMIT');
});

test('deleting every global word stays empty across restart and preserves mention wake',async()=>{
  const f=await fixture();for(const word of f.core.status().wakeWords)await f.change('delete',{id:word.id});
  const restored=f.makeCore();await restored.init();assert.deepEqual(restored.status().wakeWords,[]);
  assert.equal((await restored.handleMessage(group('A','1','大肥鱼 你好'))).code,'IGNORED');
  assert.equal((await restored.handleMessage(group('A','2','你好',true))).code,'SENT');
});

test('a global rename invalidates an in-flight group result before its queue drains',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  const f=await fixture({handler:async(_text,context)=>{entered();await blocked;assert.equal(context.authorize('chat'),false);return {text:'旧结果'};}});
  const pending=f.core.handleMessage(group('A','1','大肥鱼 你好'));await started;
  const update=f.change('rename',{id:'default-4',text:'鲸鱼'});
  release();assert.equal((await pending).code,'GROUP_ACCESS_DENIED');await update;
  assert.equal(f.sent.length,0);
});

test('turning off a word invalidates in-flight results only in that group',async()=>{
  let entered,release;const started=new Promise(r=>{entered=r;}),blocked=new Promise(r=>{release=r;});
  const f=await fixture({handler:async()=>{entered();await blocked;return {text:'旧结果'};}});
  const pending=f.core.handleMessage(group('A','1','大肥鱼 你好'));await started;
  const update=f.toggle('A',['default-4']);release();
  assert.equal((await pending).code,'GROUP_ACCESS_DENIED');await update;
  assert.equal(f.sent.length,0);assert.deepEqual(f.core.status().allowedGroups[1].disabledWakeWords,[]);
});

test('admin-only catalog and group switches use one store and reject extra payload fields',async t=>{
  let saved=initial();const store={token:'a'.repeat(64),integrationToken:'b'.repeat(64),init:async()=>{},readCredentials:async()=>null,
    loadState:async()=>saved,saveState:async value=>{saved=structuredClone(value);}};
  const app=await createBridgeServer({port:0,store,adapterFactory:()=>({status:()=>({state:'connected'}),disconnect:async()=>{}})});
  t.after(()=>app.close());const port=await app.listen();
  const post=(route,data,token=store.token)=>fetch('http://127.0.0.1:'+port+'/api/'+route,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(data)});
  for(const route of ['wake-words/add','wake-words/rename','wake-words/delete','group/wake-words'])assert.equal((await post(route,{},store.integrationToken)).status,403);
  assert.equal((await post('wake-words/add',{text:'鲸鱼',revision:0,id:'default-4'})).status,400);
  const added=await(await post('wake-words/add',{text:'鲸鱼',revision:0})).json();assert.equal(added.code,'WAKE_WORDS_SAVED');
  const word=added.status.wakeWords.at(-1);
  assert.equal((await(await post('group/wake-words',{groupKey:key('A'),disabledWakeWords:[word.id],revision:1})).json()).code,'GROUP_WAKE_WORDS_SAVED');
  assert.equal((await(await post('wake-words/rename',{id:word.id,text:'白饭',revision:1})).json()).code,'WAKE_WORDS_SAVED');
  assert.equal(saved.wakeWords.at(-1).text,'白饭');assert.deepEqual(saved.allowedGroups[0].disabledWakeWords,[word.id]);
});

test('custom wake reaches real Python LangChain conversion and a closed word never invokes it',async t=>{
  const home=fileURLToPath(new URL('../',import.meta.url)),worker=new PythonAgentWorker({home});t.after(()=>worker.close());
  const agent=new ConversationAgent({conversionTools:new ConversionToolbox(worker),toolbox:{handle:async()=>null},
    configStore:{read:async()=>({enabled:false})},modelBudget:{acquire:async()=>assert.fail()}});
  const f=await fixture({handler:(text,context)=>agent.handle(text,context)});
  await f.change('add',{text:'鲸鱼'});const word=f.core.status().wakeWords.at(-1);
  await f.core.handleMessage(group('A','1','鲸鱼 1马里换公里'));
  assert.equal(f.sent[0].text,'1 马里 = 3.08 km');
  await f.toggle('A',[word.id]);
  assert.equal((await f.core.handleMessage(group('A','2','鲸鱼 1马里换公里'))).code,'IGNORED');assert.equal(f.queries.length,1);
});
