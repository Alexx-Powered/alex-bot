import {loadChatPolicy} from './chat-policy.mjs';
import {createHash} from 'node:crypto';
import {checkChatInput,boundChatReply,sanitizeContextText,naturalChatReply} from './chat-safety.mjs';
import {isBalanceQuery,balanceReply} from './balance-tools.mjs';
import {conversionReply,fixedToolContext} from './conversion-tools.mjs';
import {isGray,fullAccess,basicAccess,RESTRICTED_REPLY} from './access-policy.mjs';
const opaque=value=>createHash('sha256').update(value).digest('hex');
export class ConversationAgent{
  #limitNotices=new Map();
  constructor({toolbox,conversionTools,campusTools,worker,configStore,policyFile,policyLoader=loadChatPolicy,modelBudget,socialService}){
    if(!modelBudget||typeof modelBudget.acquire!=='function')throw new TypeError('MODEL_BUDGET_REQUIRED');
    Object.assign(this,{toolbox,conversionTools,campusTools,worker,configStore,policyFile,policyLoader,modelBudget,socialService});
  }
  async handle(text,context={}){
    let socialData={};
    try{socialData=await this.socialService?.prepare(text,context)||{};}catch{
      if(/^\/(?:识图|记忆)(?:\s|$)/u.test(text)||context.media?.length)return {text:context.media?.some(a=>a.kind==='audio')?'这条语音暂时没听清，再发一次试试~':text.startsWith('/记忆')?'记忆暂时更新不了，稍后再试~':'这张图暂时没看清，再发一次试试~',requiredAccess:'chat'};
      socialData={social:{ok:false,disabled:true,unavailable:true}};
    }
    if(socialData.reply)return {text:socialData.reply,requiredAccess:'chat',...(socialData.reset?{memoryReset:true}:{})};
    if(socialData.text)text=socialData.text;
    const sessionKey=context.sessionKey||'private';
    const gray=isGray(context);
    const decorate=(value,requiredAccess='white',sensitive=false)=>value&&context.scope==='group'?{...value,requiredAccess,...(sensitive?{sensitive:true}:{})}:value;
    const denied=()=>decorate({text:RESTRICTED_REPLY},'chat');
    const campus=await this.campusTools?.handle(text,context);if(campus)return campus.cancelled?null:gray?denied():decorate(campus);
    if(isBalanceQuery(text)){
      if(!fullAccess(context))return gray?denied():{text:'账户余额仅支持本人私聊或白名单群主动查询。'};
      let config;try{config=await this.configStore.read();}catch{return {text:'模型配置暂不可用，请在本机检查。'};}
      if(!config.apiKey)return {text:'尚未配置 DeepSeek API Key，请在本机配置页保存。'};
      try{return await this.worker.run({type:'execute',name:'deepseek_account_balance',args:{},config,context:{scope:context.scope,...(context.scope==='group'?{access:'white'}:{})},...fixedToolContext(context)},async()=>{throw Error('BALANCE_RPC_DENIED');},value=>fullAccess(context)?decorate(balanceReply(value),'white',true):denied());}
      catch{return {text:'余额查询暂不可用，请稍后再试。'};}
    }
    const conversion=await this.conversionTools?.handle(text,context);if(conversion)return decorate(conversion,'chat');
    if(!gray){const fixed=await this.toolbox.handle(text);if(fixed)return decorate(fixed);}
    if(!basicAccess(context))return null;
    let config,policy;
    try{config=await this.configStore.read();}catch{return {text:'模型配置暂不可用，请在本机设置中检查。'};}
    if(!config.enabled||!config.apiKey)return null;
    try{policy=await this.policyLoader(this.policyFile);}catch{return {text:'聊天规则文件格式有误，请在本机检查 config/chat-policy.md。'};}
    policy={...policy,maxChars:Math.min(600,policy.maxChars)};
    const input=checkChatInput(text,{media:Boolean(socialData.media)});
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
      return decorate({text:budget.code==='MODEL_RATE_LIMIT_DAY'?(gray?'今天的智能聊天额度用完了，固定换算仍可用。':'今天的智能问答额度用完了，明天再聊。天气和固定换算仍可用。'):'问得有点密，等一分钟再继续就好。'},'chat');
    }
    let groupContext;
    if(context.scope==='group'){
      const rows=Array.isArray(context.groupContext)?context.groupContext:[];
      groupContext=rows.slice(-10).flatMap(row=>{
        if(!row||!((row.role==='assistant'&&row.speaker==='fish')||(row.role==='member'&&/^member-[a-f0-9]{1,64}$/.test(row.speaker||''))))return [];
        const text=sanitizeContextText(row.text,{maxChars:240});return text?[{speaker:row.speaker,role:row.role,text}]:[];
      });
    }
    const packetContext=groupContext?{scope:'group',...(context.access?{access:context.access}:{}),groupContext,currentSpeaker:/^member-[a-f0-9]{1,64}$/.test(context.currentSpeaker||'')?context.currentSpeaker:'member-'+userKey.slice(0,12)}:{scope:'c2c'};
    if(socialData.social)packetContext.social=socialData.social;
    if(socialData.media)packetContext.media=socialData.media;
    try{
      let result=await this.worker.run({type:'request',text:requestText,sessionKey,context:packetContext,config,policy,now:new Date().toISOString()},async(name,args)=>{
        if(name==='local_weather_briefing')throw new Error('TOOL_DENIED');
        if(name==='buaa_classroom_query'){
          if(!this.campusTools||!fullAccess(context))return denied();
          return this.campusTools.execute(args,context,requestText);
        }
        if(name==='buaa_classroom_recommend'){
          if(!this.campusTools||!fullAccess(context))return denied();
          return this.campusTools.recommend(args,context,requestText);
        }
        if(gray||!basicAccess(context))return denied();
        return decorate(await this.toolbox.execute(name,args));
      },result=>{
        if(result.kind==='balance')return fullAccess(context)?decorate(balanceReply(result),'white',true):gray?denied():null;
        if(result.kind==='reasoned'){
          const sensitive=result.sensitive===true;
          if(sensitive&&!fullAccess(context))return denied();
          if(gray&&result.source!=='conversion')return denied();
          const text=naturalChatReply(result.text,540);const source=result.source==='openai-status'?'\nhttps://status.openai.com/':'';
          return text?decorate({text:text+source,...(sensitive?{requiredAccess:'white',sensitive:true}:{})},sensitive||result.source!=='conversion'?'white':'chat',sensitive):null;
        }
        const converted=conversionReply(result);if(converted)return decorate(converted,'chat');
        if(result.kind==='chat'&&policy.enabled&&policy.topics.includes(result.topic)){
          const text=naturalChatReply(result.text,policy.maxChars);return text?decorate({text,...(result.memory_reset===true?{memoryReset:true}:{})},'chat'):null;
        }
        if(result.kind==='ignore'){
          console.warn('[qq-agent] MODEL_IGNORED');
          return decorate({ignored:true,text:policy.enabled?'这件事我帮不上忙，但鱼还在，可以陪你聊聊。':''},'chat');
        }
        if(result.kind==='clarify'&&result.reason==='unsupported_action'&&policy.enabled)return decorate({text:'这件事我不能代你操作，也不能替你联系别人。'},'chat');
        if(result.kind==='clarify')return result.reason==='restricted_access'?denied():result.reason==='missing_place'?decorate({text:'请告诉我城市或区县；雷达也可以使用区域名，例如华北。'},'chat'):result.reason==='unsupported_time'?decorate({text:'天气三联图目前只支持今天；空气质量曲线展示未来48小时。'},'chat'):null;
        return null;
      });
      if(result?.ignored){
        const recovered=await this.campusTools?.recoverIgnored?.(requestText,context);
        if(recovered)result=recovered;
        else if(!result.text)return null;
      }
      if(!result?.campusRecommendation)return result?.cancelled?null:result;
      if(!fullAccess(context))return null;
      if(!result.campusRecommendation.ok)return result;
      let advice=result;
      try{
        advice=await this.worker.run({type:'campus_advice',text:requestText,sessionKey,
          context:{scope:context.scope,...(context.scope==='group'?{access:context.access}:{})},
          config,report:result.campusRecommendation},async()=>{throw Error('ADVICE_TOOL_DENIED');},value=>{
          if(!fullAccess(context)||value.source!=='campus-recommendation'||typeof value.text!=='string')return null;
          const text=value.text.split('\n').slice(0,15).map(line=>naturalChatReply(line,600)).join('\n').slice(0,1400);
          return decorate({text,explanation:typeof value.explanation==='string'?naturalChatReply(value.explanation,180):''});
        });
      }catch{ /* Render verified facts even if model explanation is unavailable. */ }
      if(!fullAccess(context)||!advice)return null;
      return this.campusTools.renderRecommendation?this.campusTools.renderRecommendation(result.campusRecommendation,advice.explanation||'',context):advice;
    }catch(error){
      const messages={MODEL_AUTH_ERROR:'模型接口鉴权失败，请检查本机保存的 Key 和权限。',MODEL_BALANCE_INSUFFICIENT:'模型接口提示余额不足，可以私聊问“查余额”确认。',MODEL_PROVIDER_RATE_LIMITED:'模型接口暂时限流了，稍等再问我。',MODEL_PROVIDER_UNAVAILABLE:'模型服务暂时异常，稍后再试一下。',MODEL_TIMEOUT:'模型回复超时了，稍后再问一次吧。',MODEL_CONNECTION_ERROR:'这次没连上模型接口，稍后再试一下。',MODEL_TOOL_ROUTING_FAILED:'这次没能正确识别工具参数，请换个说法再试。'};
      const reason=Object.hasOwn(messages,error?.reason)?error.reason:'WORKER_FAILED';
      console.warn('[qq-agent] '+reason);
      return {text:messages[reason]||'这次智能助手没能完成回复，稍后再试一下。'};
    }
  }
}
