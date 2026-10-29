// Synthetic requests only; outputs are whitelisted timings/tokens, never chat.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {AgentConfigStore} from '../src/agent-config.mjs';
import {ModelRequestBudget} from '../src/chat-safety.mjs';
import {loadChatPolicy} from '../src/chat-policy.mjs';
import {Telemetry} from '../src/telemetry.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),home='/var/lib/alexbot';
const label=process.argv.includes('--prewarm')?'prewarmed':'baseline',nonce=Date.now().toString();
const directory=path.join(home,'.private','latency-evaluation',label+'-'+nonce);await fs.mkdir(directory,{recursive:true,mode:0o700});
const hash=s=>createHash('sha256').update(s).digest('hex'),sessionKey=hash(nonce);
const config=await new AgentConfigStore(home).read(),policy=await loadChatPolicy(path.join(root,'config/chat-policy.md'));
const budget=new ModelRequestBudget(home),worker=new PythonAgentWorker({home:directory});
const telemetry=new Telemetry({home:directory,configStore:{read:async()=>({enabled:false})}});
const results={at:new Date().toISOString(),label,qqMessages:0,requests:[]};
try{
 if(label==='prewarmed'){const start=performance.now();worker.prewarm();await worker.warmup();results.warmupMs=Math.round(performance.now()-start);}
 const texts=['今天写代码把我累坏了','我想偷吃你一口白饭~','今天终于修完一个bug啦'];
 for(let i=0;i<texts.length;i++){
   if(i===2)await new Promise(r=>setTimeout(r,8000));
   const allowed=await budget.acquire({userKey:hash('eval-user:'+nonce),scopeKey:hash('eval-scope:'+nonce)});
   if(!allowed.ok)throw Error('EVALUATION_BUDGET_LIMIT');
   const start=performance.now();
   const kind=await telemetry.run({scope:'c2c'},()=>worker.run({type:'request',text:texts[i],sessionKey,context:{scope:'c2c'},config,policy,now:new Date().toISOString()},async()=>{throw Error('EVALUATION_RPC_DISABLED');},value=>value.kind));
   const recent=(await telemetry.status()).recent[0];
   results.requests.push({sample:i,cold:i===0,afterIdle:i===2,kind,totalMs:Math.round(performance.now()-start),stages:recent?.stages?.map(({name,ms,inputTokens,outputTokens,cachedInputTokens,status})=>({name,ms,inputTokens,outputTokens,cachedInputTokens,status}))||[]});
   await fs.writeFile(path.join(home,'.private/latency-evaluation/latest-'+label+'.json'),JSON.stringify(results,null,2),{mode:0o600});
 }
 results.completedAt=new Date().toISOString();
 await fs.writeFile(path.join(home,'.private/latency-evaluation/latest-'+label+'.json'),JSON.stringify(results,null,2),{mode:0o600});console.log(JSON.stringify(results));
}finally{worker.close();}
