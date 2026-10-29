// Operator-only evaluation with synthetic users; no QQ connection or sends.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {AgentConfigStore} from '../src/agent-config.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {ModelRequestBudget} from '../src/chat-safety.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),home='/var/lib/alexbot';
const evaluation=path.join(home,'.private/chat-evaluation');await fs.mkdir(evaluation,{recursive:true,mode:0o700});
const hash=s=>createHash('sha256').update(s).digest('hex');
const suffix=Date.now().toString(),sessionKey=hash('eval:'+suffix);
const context={scope:'c2c',sessionKey,userKey:hash('eval-user:'+suffix),scopeKey:hash('eval-scope:'+suffix)};
const results={at:new Date().toISOString(),qqMessages:0,replies:[]};
let worker,agent;
function start(){worker=new PythonAgentWorker({home:evaluation});agent=new ConversationAgent({worker,configStore:new AgentConfigStore(home),policyFile:path.join(root,'config/chat-policy.md'),modelBudget:new ModelRequestBudget(home),toolbox:{handle:async()=>null,execute:async()=>{throw Error('EVALUATION_NO_BUSINESS_RPC');}}});}
async function ask(text,ctx=context){const before=Date.now();const r=await agent.handle(text,ctx);results.replies.push({question:text,answer:r?.text||'',ms:Date.now()-before});await fs.writeFile(path.join(evaluation,'results.json'),JSON.stringify(results,null,2),{mode:0o600});}
try{
 start();
 await ask('今天被代码折磨麻了，写了一天只多出三个bug');
 await ask('隔壁机器人回得好慢，我都要投入大肥鱼的怀抱了');
 await ask('今天终于把那个烦人的bug修好了');
 if(!process.argv.includes('--tone-only')){
 await ask('我叫试运行小河，以后就叫我小河');
 worker.close();start();
 await ask('还记得该怎么称呼我吗？');
 await ask('你记得我什么？');
 await ask('清空我的记忆');
 worker.close();start();
 await ask('你记得我什么？');
 results.checks={rememberedAfterRestart:/小河/.test(results.replies[4].answer)&&!/没有记|不记得|记不清/.test(results.replies[4].answer),recallQuestionDoesNotOverwriteName:/小河/.test(results.replies[5].answer)&&!/称呼我吗/.test(results.replies[5].answer),forgotAfterRestart:/没有|没记|还没|不记/.test(results.replies.at(-1).answer)};
 }else results.checks={replied:results.replies.every(r=>r.answer&&!/智能助手没能|额度用完|超时|模型接口/.test(r.answer))};
 results.completedAt=new Date().toISOString();
 await fs.writeFile(path.join(evaluation,'results.json'),JSON.stringify(results,null,2),{mode:0o600});
 console.log(JSON.stringify(results));
 if(!Object.values(results.checks).every(Boolean))process.exitCode=1;
}finally{worker?.close();}
