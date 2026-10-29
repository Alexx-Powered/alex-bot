import fs from 'node:fs/promises';
import path from 'node:path';
import {PrivateStore,atomicJson} from '../src/storage.mjs';
import {AgentConfigStore} from '../src/agent-config.mjs';
import {CampusConfigStore} from '../src/campus-config.mjs';
import {PythonAgentWorker} from '../src/python-agent.mjs';
import {CampusService} from '../src/campus-service.mjs';
import {WeatherCommands} from '../src/weather-commands.mjs';
import {WeatherToolbox} from '../src/weather-tools.mjs';
import {ConversionToolbox} from '../src/conversion-tools.mjs';
import {ConversationAgent} from '../src/conversation-agent.mjs';
import {ModelRequestBudget} from '../src/chat-safety.mjs';
import {MorningReportService} from '../src/morning-report.mjs';

const home='/var/lib/alexbot',out=path.join(home,'.private','preflight');
await fs.mkdir(out,{recursive:true,mode:0o700});
const results={startedAt:new Date().toISOString(),checks:{},qqMessages:0};
const worker=new PythonAgentWorker({home}),campus=new CampusService({home,configStore:new CampusConfigStore(home)});
const commands=new WeatherCommands(),toolbox=new WeatherToolbox(commands,worker),configStore=new AgentConfigStore(home);
const agent=new ConversationAgent({worker,campusTools:campus,toolbox,conversionTools:new ConversionToolbox(worker),configStore,policyFile:path.join(home,'config','chat-policy.md'),modelBudget:new ModelRequestBudget(home)});
async function check(name,fn){
  try{results.checks[name]={ok:true,...await fn()};}catch(e){results.checks[name]={ok:false,code:/^[A-Z_]{1,70}$/.test(e.code||e.message)?e.code||e.message:'CHECK_FAILED'};}
  await atomicJson(path.join(out,'results.json'),results);console.log(JSON.stringify({check:name,...results.checks[name]}));
}
async function imageResult(name,result){
  if(!result?.image?.buffer)throw Error('IMAGE_MISSING');
  await fs.writeFile(path.join(out,name+'.png'),result.image.buffer,{mode:0o600});
  return {bytes:result.image.buffer.length};
}
try{
  await check('encrypted_storage',async()=>{
    const store=new PrivateStore(home);await store.init();const q=await store.readCredentials();
    if(!q?.appSecret||!(await configStore.status()).configured||!(await new CampusConfigStore(home).status()).configured)throw Error('CREDENTIALS_MISSING');
    for(const file of ['credentials.json','agent-config.json','campus-config.json'])if(JSON.parse(await fs.readFile(path.join(home,'.private',file),'utf8')).format!=='aes-256-gcm-v1')throw Error('FORMAT_ERROR');
    return {qq:true,model:true,campus:true};
  });
  await check('conversion',async()=>{const r=await new ConversionToolbox(worker).handle('0.6HU$换人民币');if(!r.text.includes('70'))throw Error('CONVERSION_FAILED');return {};});
  await check('campus_live_full',async()=>{const r=await campus.run({},'report');if(!r.data.ok)throw Error(r.data.code);return {...await imageResult('classrooms-full',r),rooms:r.data.rooms.length,date:r.data.date};});
  await check('campus_live_current',async()=>imageResult('classrooms-now',await agent.handle('我现在去哪个教室自习？',{scope:'c2c',sessionKey:'migration-preflight'})));
  await check('model_chat',async()=>{const r=await agent.handle('大肥鱼今天吃白饭了吗？',{scope:'c2c',sessionKey:'migration-chat'});if(!r?.text||/失败|超时|暂不可用|没能完成/.test(r.text))throw Error('MODEL_CHAT_FAILED');return {replied:true};});
  await check('balance',async()=>{const r=await agent.handle('查DeepSeek余额',{scope:'c2c',sessionKey:'migration-balance'});if(!r?.text||/失败|暂不可用|未配置/.test(r.text))throw Error('BALANCE_FAILED');return {replied:true,balance_hidden:true};});
  await check('weather',async()=>imageResult('weather',await toolbox.handle('发 天气 北京')));
  await check('air',async()=>imageResult('air',await toolbox.handle('发 雾霾 北京')));
  await check('radar',async()=>imageResult('radar',await toolbox.handle('发 雷达 北京')));
  await check('morning',async()=>imageResult('morning',await new MorningReportService({commands,worker}).create()));
  results.completedAt=new Date().toISOString();await atomicJson(path.join(out,'results.json'),results);
}finally{worker.close();campus.close();}
