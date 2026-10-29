import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {isBalanceQuery,balanceReply} from '../src/balance-tools.mjs';

test('only explicit rescue commands bypass the model, natural phrasing stays with the agent',()=>{
 for(const t of ['查DeepSeek余额','查询 DeepSeek 账户余额'])assert.equal(isBalanceQuery(t),true,t);
 for(const t of ['我还有多少余额','余额还有多少','0.6古月币够用吗','DeepSeek账户还有多少钱'])assert.equal(isBalanceQuery(t),false,t);
 assert.equal(balanceReply({kind:'balance',text:'sk-fake-secret'}),null);
});
test('explicit group query never reads credentials; natural private question invokes agent then balance tool',async()=>{
 let reads=0;const packets=[];
 const agent=new ConversationAgent({toolbox:{handle:async()=>null},configStore:{read:async()=>{reads++;return {enabled:true,apiKey:'fake-key-123'};}},worker:{run:async(p,e,finish)=>{packets.push(p);return finish({kind:'balance',text:'DeepSeek余额：110 CNY'});}},policyLoader:async()=>({enabled:true,topics:['日常'],maxChars:600,instructions:''}),modelBudget:{acquire:async()=>({ok:true})}});
 assert.match((await agent.handle('查DeepSeek余额',{scope:'group'})).text,/本人私聊/);assert.equal(reads,0);
 assert.match((await agent.handle('我还有多少余额',{scope:'c2c'})).text,/110 CNY/);assert.equal(packets[0].type,'request');
 assert.match((await agent.handle('查DeepSeek余额',{scope:'c2c'})).text,/110 CNY/);assert.equal(packets[1].type,'execute');
});
