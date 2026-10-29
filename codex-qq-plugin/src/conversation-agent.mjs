import {loadChatPolicy} from './chat-policy.mjs';
import {createHash} from 'node:crypto';
import {checkChatInput,boundChatReply,sanitizeContextText,naturalChatReply} from './chat-safety.mjs';
import {isBalanceQuery,balanceReply} from './balance-tools.mjs';
import {conversionReply} from './conversion-tools.mjs';
const opaque=value=>createHash('sha256').update(value).digest('hex');
export class ConversationAgent{
  #limitNotices=new Map();
  constructor({toolbox,conversionTools,campusTools,worker,configStore,policyFile,policyLoader=loadChatPolicy,modelBudget}){
    if(!modelBudget||typeof modelBudget.acquire!=='function')throw new TypeError('MODEL_BUDGET_REQUIRED');
    Object.assign(this,{toolbox,conversionTools,campusTools,worker,configStore,policyFile,policyLoader,modelBudget});
  }
  async handle(text,context={}){
    const sessionKey=context.sessionKey||'private';
    const campus=await this.campusTools?.handle(text,context);if(campus)return campus;
    if(isBalanceQuery(text)){
      if(context.scope!=='c2c')return {text:'账户余额仅支持本人私聊查询。'};
      let config;try{config=await this.configStore.read();}catch{return {text:'模型配置暂不可用，请在本机检查。'};}
      if(!config.apiKey)return {text:'尚未配置 DeepSeek API Key，请在本机配置页保存。'};
      try{return await this.worker.run({type:'execute',name:'deepseek_account_balance',args:{},config,context:{scope:'c2c'}},async()=>{throw Error('BALANCE_RPC_DENIED');},balanceReply);}
      catch{return {text:'余额查询暂不可用，请稍后再试。'};}
    }
    const fixed=await this.toolbox.handle(text);if(fixed)return fixed;
    const conversion=await this.conversionTools?.handle(text);if(conversion)return conversion;
    let config,policy;
    try{config=await this.configStore.read();}catch{return {text:'模型配置暂不可用，请在本机设置中检查。'};}
    if(!config.enabled||!config.apiKey)return null;
    try{policy=await this.policyLoader(this.policyFile);}catch{return {text:'聊天规则文件格式有误，请在本机检查 config/chat-policy.md。'};}
    policy={...policy,maxChars:Math.min(600,policy.maxChars)};
    const input=checkChatInput(text);
    if(!input.ok)return policy.enabled&&input.reply?{text:boundChatReply(input.reply,policy.maxChars)}:null;
    const requestText=sanitizeContextText(text,{maxChars:320});if(!requestText)return null;
    const key=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    const userKey=key(context.userKey)?context.userKey:opaque('user:'+sessionKey);
    const scopeKey=key(context.scopeKey)?context.scopeKey:opaque('scope:'+sessionKey);
    let budget;try{budget=await this.modelBudget.acquire({userKey,scopeKey});}catch{return null;}
    if(!budget?.ok){
      if(!budget?.code?.startsWith('MODEL_RATE_LIMIT_'))return null;
      const now=Date.now(),last=this.#limitNotices.get(scopeKey);
      if(last!==undefined&&now-last<60000)return null;
      this.#limitNotices.set(scopeKey,now);
      while(this.#limitNotices.size>32)this.#limitNotices.delete(this.#limitNotices.keys().next().value);
      return {text:budget.code==='MODEL_RATE_LIMIT_DAY'?'今天的智能问答额度用完了，明天再聊。天气和固定换算仍可用。':'问得有点密，等一分钟再继续就好。'};
    }
    let groupContext;
    if(context.scope==='group'){
      const rows=Array.isArray(context.groupContext)?context.groupContext:[];
      groupContext=rows.slice(-10).flatMap(row=>{
        if(!row||!((row.role==='assistant'&&row.speaker==='fish')||(row.role==='member'&&/^member-[a-f0-9]{1,64}$/.test(row.speaker||''))))return [];
        const text=sanitizeContextText(row.text,{maxChars:240});return text?[{speaker:row.speaker,role:row.role,text}]:[];
      });
    }
    const packetContext=groupContext?{scope:'group',groupContext,currentSpeaker:/^member-[a-f0-9]{1,64}$/.test(context.currentSpeaker||'')?context.currentSpeaker:'member-'+userKey.slice(0,12)}:{scope:'c2c'};
    try{
      return await this.worker.run({type:'request',text:requestText,sessionKey,context:packetContext,config,policy,now:new Date().toISOString()},async(name,args)=>{
        if(name==='local_weather_briefing')throw new Error('TOOL_DENIED');
        if(name==='buaa_classroom_query'){
          if(!this.campusTools||context.scope!=='c2c')throw new Error('TOOL_DENIED');
          return this.campusTools.execute(args,context);
        }
        return this.toolbox.execute(name,args);
      },result=>{
        if(result.kind==='balance')return context.scope==='c2c'?balanceReply(result):null;
        if(result.kind==='reasoned'){const text=naturalChatReply(result.text,540);const source=result.source==='openai-status'?'\nhttps://status.openai.com/':'';return text?{text:text+source}:null;}
        const converted=conversionReply(result);if(converted)return converted;
        if(result.kind==='chat'&&policy.enabled&&policy.topics.includes(result.topic)){
          const text=naturalChatReply(result.text,policy.maxChars);return text?{text}:null;
        }
        if(result.kind==='clarify')return result.reason==='missing_place'?{text:'请告诉我城市或区县；雷达也可以使用区域名，例如华北。'}:result.reason==='unsupported_time'?{text:'天气三联图目前只支持今天；空气质量曲线展示未来48小时。'}:null;
        return null;
      });
    }catch(error){
      const messages={MODEL_AUTH_ERROR:'模型接口鉴权失败，请检查本机保存的 Key 和权限。',MODEL_BALANCE_INSUFFICIENT:'模型接口提示余额不足，可以私聊问“查余额”确认。',MODEL_PROVIDER_RATE_LIMITED:'模型接口暂时限流了，稍等再问我。',MODEL_PROVIDER_UNAVAILABLE:'模型服务暂时异常，稍后再试一下。',MODEL_TIMEOUT:'模型回复超时了，稍后再问一次吧。',MODEL_CONNECTION_ERROR:'这次没连上模型接口，稍后再试一下。',MODEL_TOOL_ROUTING_FAILED:'这次没能正确识别工具参数，请换个说法再试。'};
      const reason=Object.hasOwn(messages,error?.reason)?error.reason:'WORKER_FAILED';
      console.warn('[qq-agent] '+reason);
      return {text:messages[reason]||'这次智能助手没能完成回复，稍后再试一下。'};
    }
  }
}
