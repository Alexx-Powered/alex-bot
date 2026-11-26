import {loadChatPolicy} from './chat-policy.mjs';
import {createHash} from 'node:crypto';
import {checkChatInput,boundChatReply,sanitizeContextText,naturalChatReply} from './chat-safety.mjs';
import {balanceReply} from './balance-tools.mjs';
import {conversionReply} from './conversion-tools.mjs';
import {featureEnabled,toolFeature} from './group-features.mjs';
import {isGray,fullAccess,basicAccess,restrictedReply} from './access-policy.mjs';
import {timeoutNotice} from './timeout-notice.mjs';
import {recordRequestFailure} from './telemetry.mjs';
const opaque=value=>createHash('sha256').update(value).digest('hex');
export class ConversationAgent{
  #limitNotices=new Map();
  constructor({campusTools,worker,configStore,policyFile,policyLoader=loadChatPolicy,modelBudget,socialService}){
    if(!modelBudget||typeof modelBudget.acquire!=='function')throw new TypeError('MODEL_BUDGET_REQUIRED');
    Object.assign(this,{campusTools,worker,configStore,policyFile,policyLoader,modelBudget,socialService});
  }
  async handle(text,context={}){
    let socialData={};
    try{socialData=await this.socialService?.prepare(text,context)||{};}catch(error){
      if(error.timedOut){recordRequestFailure(error);return {text:timeoutNotice(error,{stage:text.startsWith('/记忆')?'记忆处理':'图片或语音识别'}),requiredAccess:'chat'};}
      if(/^\/(?:识图|记忆)(?:\s|$)/u.test(text)||context.media?.length){
        recordRequestFailure(error);
        return {text:context.media?.some(a=>a.kind==='audio')?'这条语音暂时没听清，再发一次试试~':text.startsWith('/记忆')?'记忆暂时更新不了，稍后再试~':'这张图暂时没看清，再发一次试试~',requiredAccess:'chat'};
      }
      socialData={social:{ok:false,disabled:true,unavailable:true}};
    }
    if(socialData.reply)return {text:socialData.reply,requiredAccess:'chat',...(socialData.reset?{memoryReset:true}:{})};
    if (socialData.media?.kind==='image' && !featureEnabled(context,'chat')) {
      if (!featureEnabled(context,'images')) return null;
      const text=naturalChatReply([socialData.media.description,socialData.media.visible_text].filter(Boolean).join('\n'),600);
      return text?{text,requiredAccess:'chat',requiredFeature:'images'}:null;
    }
    if(socialData.text)text=socialData.text;
    const sessionKey=context.sessionKey||'private';
    const gray=isGray(context);
    const decorate=(value,requiredAccess='white',sensitive=false,requiredFeature)=>value&&context.scope==='group'?{...value,requiredAccess,...(requiredFeature&&context.features?{requiredFeature}:{}),...(sensitive?{sensitive:true}:{})}:value;
    const denied=()=>decorate({text:restrictedReply(context)},'chat');
    const ragReply=async result=>{
      const feature=result.requiredFeature;
      if(!['campus','weather','memory'].includes(feature)||!fullAccess(context,feature))return denied();
      const text=typeof result.text==='string'&&[...result.text].length<=1600
        ?result.text.replace(/<[@#][^>\r\n]*>/gu,'').replace(/@/gu,'＠').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu,'').trim():'';
      return text?decorate({text},'white',false,feature):null;
    };
    if(!basicAccess(context))return null;
    let config,policy;
    try{config=await this.configStore?.read();}catch{recordRequestFailure({code:'MODEL_CONFIG_UNAVAILABLE'});}
    const requestText=sanitizeContextText(text,{maxChars:320});if(!requestText)return null;
    const key=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    const userKey=key(context.userKey)?context.userKey:opaque('user:'+sessionKey);
    const scopeKey=key(context.scopeKey)?context.scopeKey:opaque('scope:'+sessionKey);
    const fixed=!config?.enabled||!config.apiKey||text.startsWith('/')||['帮助','菜单'].includes(text);
    if(!fixed){
      try{policy=await this.policyLoader(this.policyFile);}catch{recordRequestFailure({code:'CHAT_POLICY_INVALID'});return {text:'聊天规则文件格式有误，请在本机检查 config/chat-policy.md。'};}
      policy={...policy,enabled:policy.enabled&&featureEnabled(context,'chat'),maxChars:Math.min(600,policy.maxChars)};
      const input=checkChatInput(text,{media:Boolean(socialData.media)});
      if(!input.ok)return policy.enabled&&input.reply?{text:boundChatReply(input.reply,policy.maxChars)}:null;
      let budget;try{budget=await this.modelBudget.acquire({userKey,scopeKey},context.waitForQuota);}catch{return null;}
      if(!budget?.ok){
        if(!budget?.code?.startsWith('MODEL_RATE_LIMIT_'))return null;
        const now=Date.now(),last=this.#limitNotices.get(scopeKey);
        if(last!==undefined&&now-last<60000)return null;
        this.#limitNotices.set(scopeKey,now);
        while(this.#limitNotices.size>32)this.#limitNotices.delete(this.#limitNotices.keys().next().value);
        return decorate({text:budget.code==='MODEL_RATE_LIMIT_DAY'?(gray?'今天的智能聊天额度用完了，明天再聊。':'今天的智能问答额度用完了，明天再聊。'):'问得有点密，等一分钟再继续就好。'},'chat');
      }
    }
    let groupContext;
    if(context.scope==='group'&&!fixed){
      const rows=Array.isArray(context.groupContext)?context.groupContext:[];
      groupContext=rows.slice(-10).flatMap(row=>{
        if(!row||!((row.role==='assistant'&&row.speaker==='fish')||(row.role==='member'&&/^member-[a-f0-9]{1,64}$/.test(row.speaker||''))))return [];
        const text=sanitizeContextText(row.text,{maxChars:240});return text?[{speaker:row.speaker,role:row.role,text}]:[];
      });
    }
    const packetContext=context.scope==='group'?{scope:'group',...(context.access?{access:context.access}:{}),...(groupContext?{groupContext}:{}),currentSpeaker:/^member-[a-f0-9]{1,64}$/.test(context.currentSpeaker||'')?context.currentSpeaker:'member-'+userKey.slice(0,12)}:{scope:'c2c'};
    if (context.scope==='group' && context.features) {
      packetContext.features=context.features;
      packetContext.policyRevision=context.policyRevision||0;
      packetContext.access='white';
    }
    if(!fixed&&socialData.social)packetContext.social=socialData.social;
    if(fixed&&socialData.social?.disabled===true)packetContext.social={disabled:true};
    if(!fixed&&socialData.media)packetContext.media=socialData.media;
    try{
      const authorize=async(feature,tool)=>{
        if(!fullAccess(context,feature))return false;
        if(feature==='balance'&&fixed)return {apiKey:config?.apiKey??''};
        if(['buaa_classroom_query','buaa_classroom_recommend'].includes(tool))return this.campusTools?.workerGrant?.(tool,context)??{code:'CAMPUS_NOT_CONFIGURED'};
        return true;
      };
      const result=await this.worker.run({
        type:fixed?'fixed_request':'request',replyFormat:'attachment-v1',text:requestText,
        sessionKey,context:packetContext,...(fixed?{}:{config,policy}),now:new Date().toISOString()
      },()=>{throw Error('UNEXPECTED_TOOL_CALLBACK');},result=>{
        if(result.kind==='attachment'){
          const feature=toolFeature(result.tool);
          if(result.reply?.cancelled)return null;
          return feature&&fullAccess(context,feature)?decorate(result.reply,'white',false,feature):denied();
        }
        if(result.kind==='rag'){
          return ragReply(result);
        }
        if(result.kind==='balance')return fullAccess(context,'balance')?decorate(balanceReply(result),'white',true,'balance'):gray?denied():null;
        if(result.kind==='reasoned'){
          const sensitive=result.sensitive===true;
          if(sensitive&&!fullAccess(context,'balance'))return denied();
          const feature=result.source==='openai-status'?'status':result.source==='living-budget'?'budget':'conversion';
          if (!featureEnabled(context,feature)) return denied();
          if(gray&&result.source!=='conversion')return denied();
          const text=naturalChatReply(result.text,540);const source=result.source==='openai-status'?'\nhttps://status.openai.com/':'';
          return text?decorate({text:text+source,...(sensitive?{requiredAccess:'white',sensitive:true}:{})},sensitive||result.source!=='conversion'?'white':'chat',sensitive,feature):null;
        }
        const converted=conversionReply(result);if(converted)return featureEnabled(context,'conversion')?decorate(converted,'chat',false,'conversion'):denied();
        if(result.kind==='chat'&&policy?.enabled&&policy.topics.includes(result.topic)){
          const text=naturalChatReply(result.text,policy.maxChars);return text?decorate({text,...(result.memory_reset===true?{memoryReset:true}:{})},'chat',false,'chat'):null;
        }
        if(result.kind==='ignore'){
          if(fixed)return config?null:{text:'模型配置暂不可用，请在本机设置中检查。'};
          console.warn('[qq-agent] MODEL_IGNORED');
          return decorate({ignored:true,text:policy?.enabled?'这件事我帮不上忙，但鱼还在，可以陪你聊聊。':''},'chat');
        }
        if(result.kind==='clarify'&&result.reason==='unsupported_action'&&policy?.enabled)return decorate({text:'这件事我不能代你操作，也不能替你联系别人。'},'chat');
        if(result.kind==='clarify')return result.reason==='restricted_access'?denied():result.reason==='missing_place'?decorate({text:'请告诉我地点。动态天气视频和雷达也支持区域名，例如华北。'},'chat'):result.reason==='unsupported_time'?decorate({text:'预报图可选今天或未来日期，预报视频可选24或48小时。空气单图展示未来48小时，雷达展示当前观测，历史云图展示最近6小时。'},'chat'):null;
        return null;
      },authorize,{
        allowed:()=>fullAccess(context,'campus'),
        progress:async stage=>fullAccess(context,'campus')&&(!context.progress||await context.progress(stage))&&fullAccess(context,'campus'),
        saveSession:(grant,state)=>this.campusTools?.saveWorkerSession(grant,state,context)
      });
      if(result?.ignored&&!result.text)return null;
      return result;
    }catch(error){
      recordRequestFailure(error);
      const messages={MODEL_AUTH_ERROR:'模型接口鉴权失败，请检查本机保存的 Key 和权限。',MODEL_BALANCE_INSUFFICIENT:'模型接口提示余额不足，请检查所配置账户的余额或消费额度。',MODEL_PROVIDER_RATE_LIMITED:'模型接口暂时限流了，稍等再问我。',MODEL_PROVIDER_UNAVAILABLE:'模型服务暂时异常，稍后再试一下。',MODEL_TIMEOUT:'模型回复超时了，稍后再问一次吧。',MODEL_CONNECTION_ERROR:'这次没连上模型接口，稍后再试一下。',MODEL_TOOL_ROUTING_FAILED:'这次没能正确识别工具参数，请换个说法再试。',
        MODEL_TOOL_PROTOCOL_ERROR:'模型接口拒绝了这次工具调用，请稍后再试。',MODEL_REQUEST_REJECTED:'模型接口拒绝了这次请求，请稍后再试。'};
      const reason=Object.hasOwn(messages,error?.reason)?error.reason:'WORKER_FAILED';
      console.warn('[qq-agent] '+reason);
      return {text:timeoutNotice(error)||messages[reason]||'这次智能助手没能完成回复，稍后再试一下。'};
    }
  }
}
