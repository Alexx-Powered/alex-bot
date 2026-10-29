import test from 'node:test';
import assert from 'node:assert/strict';
import {parseConversionCommand,conversionReply,ConversionToolbox,CONVERSION_HELP} from '../src/conversion-tools.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';

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

test('fixed conversion is a Python LangChain execution with no model configuration or quota use',async()=>{
  const packets=[];
  const tools=new ConversionToolbox({run:async(packet,execute,finish)=>{packets.push(packet);return finish({kind:'conversion',text:'0.6 HU$ = 70 元'});}});
  const agent=new ConversationAgent({toolbox:{handle:async()=>null},conversionTools:tools,
    worker:{run:async()=>assert.fail('Model must not run')},configStore:{read:async()=>assert.fail('No key needed')},
    modelBudget:{acquire:async()=>assert.fail('No model call to count')}});
  assert.deepEqual(await agent.handle('换算 0.6 HU$ 人民币'),{text:'0.6 HU$ = 70 元'});
  assert.deepEqual(packets,[{type:'execute',name:'convert_units',args:{amount:'0.6',from_unit:'HU$',to_unit:'CNY'}}]);
  assert.equal(await tools.handle('马里首都是什么'),null);
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
