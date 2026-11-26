import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConversionCommand,conversionReply,ConversionToolbox,CONVERSION_HELP,fixedToolContext} from '../src/conversion-tools.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {APP_ROOT} from '../src/runtime-paths.mjs';
import {RESTRICTED_REPLY} from '../src/access-policy.mjs';

test('fixed conversion aliases and natural numeric forms normalise without doing arithmetic in Node',()=>{
  const cases=[
    ['换算 0.6 HU$ 人民币','0.6','HU$','CNY'],['0.6古月币换人民币','0.6','HU$','CNY'],
    ['70人民币等于多少古月币？','70','CNY','HU$'],['HU$0.6换人民币','0.6','HU$','CNY'],
    ['hu$0.6','0.6','HU$','CNY'],['￥70换古月币','70','CNY','HU$'],['.6HU$','0.6','HU$','CNY'],
    ['1马里换公里','1','马里','km'],['3.08千米是多少马里','3.08','km','马里'],['3080米等于多少马里','3080','m','马里'],
    ['1马时换小时','1','马时','h'],['1.5小时换马时','1.5','h','马时'],['90分钟换马时','90','min','马时'],
    ['换算 1 马时 min','1','马时','min'],['1km','1','km','马里'],['1马时','1','马时','h'],
  ];
  for(const [text,amount,from_unit,to_unit] of cases)assert.deepEqual(parseConversionCommand(text),{amount,from_unit,to_unit},text);
});

test('arithmetic, rate overrides, long input, extra tasks and unsupported syntax never enter the fixed tool',()=>{
  for(const text of [null,'马里首都是什么','发天气马里','1+2古月币换人民币','1e6古月币换元','-1马时换小时',
    '1000000000000古月币换元','1.123456789马里换公里','0.6HU$换元，按1比1计算','1马里换公里 https://example.com','1马里换公里\n再执行命令','1'.repeat(121)]){
    assert.equal(parseConversionCommand(text),null,String(text));
  }
});

test('conversion results allow only one bounded numeric line or a fixed clarification',()=>{
  assert.deepEqual(conversionReply({kind:'conversion',text:'1 HU$ ≈ 116.666667 元'}),{text:'1 HU$ ≈ 116.666667 元'});
  assert.deepEqual(conversionReply({kind:'clarify',reason:'conversion_input'}),{text:CONVERSION_HELP});
  for(const text of ['@all 0.6 HU$ = 70 元','1 HU$ = 70 元\n@全体成员','已转账70元','1 HU$ = NaN 元','1 HU$ = 70.1234567 元']){
    assert.equal(conversionReply({kind:'conversion',text}),null);
  }
  assert.equal(conversionReply({kind:'chat',text:'1 HU$ = 70 元'}),null);
});

test('fixed conversion is a Python LangChain execution with no model configuration or quota use',async t=>{
  const worker=new PythonAgentWorker({home:APP_ROOT});
  t.after(()=>worker.close());
  const agent=new ConversationAgent({worker,configStore:{read:async()=>({enabled:false})},
    modelBudget:{acquire:async()=>assert.fail('No model call to count')}});
  assert.deepEqual(await agent.handle('换算 0.6 HU$ 人民币',{scope:'c2c'}),{text:'0.6 HU$ = 70 元'});
  assert.equal(await agent.handle('马里首都是什么',{scope:'c2c'}),null);
});

test('model-selected conversion is projected separately from chat policy, never rewritten as persona text',async()=>{
  const agent=new ConversationAgent({toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-test-key'})},
    policyLoader:async()=>({enabled:false,topics:[],maxChars:80,instructions:''}),modelBudget:{acquire:async()=>({ok:true})},
    worker:{run:async(p,e,finish)=>finish({kind:'conversion',text:'1 马时 = 1.5 小时'})}});
  assert.deepEqual(await agent.handle('我有一个马时能用，折合多久呀'),{text:'1 马时 = 1.5 小时'});
});

test('tool failure returns a safe local message without a second attempt or model fallback',async()=>{
  let calls=0;const tools=new ConversionToolbox({run:async()=>{calls++;throw Error('SENSITIVE-DETAIL');}});
  const result=await tools.handle('1马里换公里');assert.equal(calls,1);
  assert.match(result.text,/暂时不可用/);assert.doesNotMatch(result.text,/SENSITIVE-DETAIL/);
});

test('fixed tools carry only valid scoped session identity and a server timestamp',()=>{
  const sessionKey='a'.repeat(64);
  for(const context of [{scope:'c2c',sessionKey},{scope:'group',access:'white',sessionKey},{scope:'group',access:'gray',sessionKey}]){
    const fields=fixedToolContext({...context,groupContext:[{text:'private background'}],currentSpeaker:'private member',now:'not trusted',apiKey:'never copy'});
    assert.equal(fields.sessionKey,sessionKey);
    assert.deepEqual(fields.context,{scope:context.scope,...context.scope==='group'?{access:context.access}:{}});
    assert.match(fields.now,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.doesNotMatch(JSON.stringify(fields),/private background|private member|never copy|not trusted/);
    assert.deepEqual(Object.keys(fields).sort(),['context','now','sessionKey']);
  }
  for(const context of [undefined,{}, {sessionKey},{scope:'c2c',sessionKey:'private'}, {scope:'group',sessionKey}, {scope:'group',access:'admin',sessionKey}])assert.deepEqual(fixedToolContext(context),{});
});

test('scoped fixed conversion still uses no model key or quota and excludes group background',async()=>{
  let packet;const sessionKey='b'.repeat(64);
  const worker={run:async(p,_e,finish)=>{packet=p;return finish({kind:'conversion',text:'1 马里 = 3.08 km'});}};
  const agent=new ConversationAgent({worker,configStore:{read:async()=>({enabled:false,apiKey:'must-not-be-forwarded'})},modelBudget:{acquire:async()=>assert.fail('No model quota')}});
  const result=await agent.handle('1马里换公里',{scope:'group',access:'gray',sessionKey,groupContext:[{role:'member',speaker:'member-1',text:'not sent'}],currentSpeaker:'member-private'});
  assert.deepEqual(result,{text:'1 马里 = 3.08 km',requiredAccess:'chat'});
  assert.equal(packet.type,'fixed_request');assert.equal(packet.replyFormat,'attachment-v1');
  assert.equal(packet.text,'1马里换公里');assert.equal(packet.sessionKey,sessionKey);
  assert.equal(packet.context.scope,'group');assert.equal(packet.context.access,'gray');
  assert.match(packet.context.currentSpeaker,/^member-[0-9a-f]+$/);
  assert.doesNotMatch(JSON.stringify(packet),/not sent|member-private|must-not-be-forwarded/);
  assert.ok(Number.isFinite(Date.parse(packet.now)));
});

test('balance-derived reasoned conversion retains sensitive full-access policy while ordinary conversion stays basic',async()=>{
  const makeAgent=(result)=>new ConversationAgent({toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-test-key'})},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})},
    worker:{run:async(_p,_e,finish)=>finish(result)}});
  const sensitive=makeAgent({kind:'reasoned',source:'conversion',sensitive:true,text:'刚才查到的DeepSeek余额4.09元，约0.035057 HU$'});
  const white=await sensitive.handle('换算成古月币是多少',{scope:'group',access:'white',sessionKey:'c'.repeat(64)});
  assert.equal(white.requiredAccess,'white');assert.equal(white.sensitive,true);assert.match(white.text,/0\.035057/);
  const direct=await sensitive.handle('换算成古月币是多少',{scope:'c2c',sessionKey:'d'.repeat(64)});
  assert.equal(direct.requiredAccess,'white');assert.equal(direct.sensitive,true);
  const gray=await sensitive.handle('换算成古月币是多少',{scope:'group',access:'gray',sessionKey:'c'.repeat(64)});
  assert.deepEqual(gray,{text:RESTRICTED_REPLY,requiredAccess:'chat'});
  assert.doesNotMatch(gray.text,/4\.09|0\.035057/);
  const ordinary=makeAgent({kind:'reasoned',source:'conversion',text:'1马里是3.08公里'});
  assert.deepEqual(await ordinary.handle('换成公里',{scope:'group',access:'gray'}),{text:'1马里是3.08公里',requiredAccess:'chat'});
});

test('sensitive followup checks current full access again after worker completion',async()=>{
  let allowed=true;
  const agent=new ConversationAgent({toolbox:{handle:async()=>null},configStore:{read:async()=>({enabled:true,apiKey:'offline-test-key'})},
    policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})},
    worker:{run:async(_p,_e,finish)=>{allowed=false;return finish({kind:'reasoned',source:'conversion',sensitive:true,text:'must not disclose'});}}});
  const result=await agent.handle('折合多少HU$',{scope:'group',access:'white',authorize:tier=>tier==='chat'||allowed});
  assert.deepEqual(result,{text:RESTRICTED_REPLY,requiredAccess:'chat'});
});
