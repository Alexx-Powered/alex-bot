import {createHash} from 'node:crypto';
import path from 'node:path';
import {APP_ROOT} from './runtime-paths.mjs';
import {PythonAgentWorker} from './python-agent.mjs';
import {copyIncomingMedia} from './incoming-media.mjs';
import {featureEnabled} from './group-features.mjs';
import {checkChatInput,sanitizeContextText} from './chat-safety.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const key=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const control=/^\/记忆\s*(查看|关闭|开启|清空)$/u;
const identify=/^\/识图(?:\s|$)/u;
function imageQuestion(text) {
  const question = text.replace(identify, '').trim();
  if (question === '[图片]' || question.startsWith('/') || !checkChatInput(question, {media:true}).ok) return '';
  return sanitizeContextText(question, {maxChars:320});
}
function memoryControl(text){
  const raw=text.trim();
  const natural=/^(?:清空|删除)(?:我(?:的)?|这里的)?(?:全部|所有)?(?:记忆|记录)[。！!]?$/u.test(raw)?'清空':/^(?:别再记我|不要再记录我|不要记录我的消息|关闭我的记忆)[。！!]?$/u.test(raw)?'关闭':/^(?:你(?:还)?记得我什么|看看我的记忆)[?？]?$/u.test(raw)?'查看':null;
  return control.exec(raw)?.[1]||natural;
}
const allowed=c=>typeof c.isAllowed==='function'?c.isAllowed():typeof c.authorize==='function'?c.authorize('chat'):true;

/** Transport orchestration only; memory, interpretation and decays live in Python tools. */
export class SocialService{
  #pending=0;#closed=false;#latest=new Map();#results=new Map();#jobs=new Map();#epochs=new Map();#batches=new Map();#insightsPending=0;#controlOutcomes=new Map();
  constructor({home,configStore,agentConfigStore,memoryWorker,mediaWorker,insightWorker}={}){
    const workerPath=path.join(APP_ROOT,'python/social_worker.py');
    const options={home,workerPath,idleMs:90_000};
    this.memory=memoryWorker||new PythonAgentWorker({...options,timeoutMs:10000});
    this.insight=insightWorker||(mediaWorker?null:new PythonAgentWorker({...options,timeoutMs:30000}));
    this.media=mediaWorker||new PythonAgentWorker({...options,timeoutMs:40000});
    Object.assign(this,{configStore,agentConfigStore});
  }
  close(){this.#closed=true;this.#latest.clear();this.#results.clear();this.#batches.clear();this.#controlOutcomes.clear();this.memory.close();this.media.close();this.insight?.close();}
  #valid(c){return !this.#closed&&key(c.sessionKey)&&key(c.scopeKey)&&allowed(c);}
  async #run(args){return this.memory.run({type:'social',args},async()=>{throw Error('SOCIAL_RPC_DENIED');},v=>v.report);}
  #args(action,c,extra={}){return {action,namespace:c.sessionKey,scope:c.scopeKey,...extra};}
  async observe(data,c){
    if(!this.#valid(c)||this.#pending>=32)return;
    // Capture the latest attachment in receipt order, before any asynchronous work.
    const captured=copyIncomingMedia(data.media)
      .map((a,i)=>({...a,namespace:c.sessionKey,event:hash(data.eventKey+':'+i),at:Date.now(),epoch:this.#epochs.get(c.sessionKey)||0}))
      .filter(a=>featureEnabled(c,a.kind==='audio'?'voice':'images'));
    const image=captured.filter(a=>a.kind==='image').at(-1);
    if(image){this.#latest.set(c.scopeKey,image);while(this.#latest.size>64)this.#latest.delete(this.#latest.keys().next().value);}
    this.#pending++;
    try{
      if(memoryControl(data.text)){await this.prepare(data.text,{...c,eventKey:data.eventKey});return;}
      const config=await this.configStore.read();if(!config.enabled||!this.#valid(c))return;
      if (featureEnabled(c,'memory')) {
        const saved=await this.#run(this.#args('observe',c,{event:data.eventKey,text:data.text.slice(0,2000)}));
        if(!saved?.ok||saved.disabled||!this.#valid(c))return;
        if(saved.observed)this.#collectInsights(data,c);
      }
      // Background work never generates a QQ send, even for memes.
      const question = data.addressed && image ? imageQuestion(data.text) : '';
      for(const a of captured){
        if(a.kind==='image'&&!config.autoMemes&&!((c.scope==='c2c'||c.access==='white')&&config.autoWhiteImages))continue;
        if(this.#jobs.size>=12)break;
        this.#understand(a,c,config,false,a===image?question:'').catch(()=>{});
      }
    }catch{}finally{this.#pending--;}
  }
  #collectInsights(data,c){
    if(!this.insight||data.text.startsWith('/'))return;
    const batch=this.#batches.get(c.sessionKey)||{texts:[],last:0};
    batch.texts.push(data.text.slice(0,320));batch.texts=batch.texts.slice(-6);
    this.#batches.set(c.sessionKey,batch);while(this.#batches.size>64)this.#batches.delete(this.#batches.keys().next().value);
    if(batch.texts.length<6||Date.now()-batch.last<30*60_000||this.#insightsPending>=2)return;
    const texts=[...batch.texts],epoch=this.#epochs.get(c.sessionKey)||0;
    batch.last=Date.now();batch.texts=[];this.#insightsPending++;
    (async()=>{
      const config=await this.agentConfigStore.read();if(!config.enabled||!config.apiKey||!this.#valid(c))return;
      const insights=await this.insight.run({type:'insight',event:hash(data.eventKey+':insight'),texts,config:{apiKey:config.apiKey}},async()=>{throw Error('INSIGHT_RPC_DENIED');},r=>r.report);
      if(!insights.ok||!this.#valid(c)||epoch!==(this.#epochs.get(c.sessionKey)||0)||(await this.configStore.read()).enabled!==true)return;
      await this.memory.run({type:'social_insight_save',namespace:c.sessionKey,scope:c.scopeKey,event:hash(data.eventKey+':insight'),insights},async()=>{throw Error('INSIGHT_RPC_DENIED');},r=>r.report);
    })().catch(()=>{}).finally(()=>{this.#insightsPending--;});
  }
  async #understand(a,c,config,force,question=''){
    const feature = a.kind === 'audio' ? 'voice' : 'images';
    const requesterEpoch = this.#epochs.get(c.sessionKey) || 0;
    const permittedNow = () => this.#valid(c) && featureEnabled(c,feature) &&
      (a.epoch||0)===(this.#epochs.get(a.namespace)||0) && requesterEpoch===(this.#epochs.get(c.sessionKey)||0);
    if (!permittedNow()) return {ok:false,code:'MEDIA_CANCELLED'};
    if(Date.now()-a.at>30*60_000)return {ok:false,code:'MEDIA_EXPIRED'};
    // A generic description cannot answer a later question about the same image.
    // Question-specific results belong to the asking member, including cache hits.
    const jobKey = question ? hash(JSON.stringify([a.event,c.sessionKey,question])) : a.event;
    if(this.#results.has(jobKey))return this.#results.get(jobKey);
    if(this.#jobs.has(jobKey))return this.#jobs.get(jobKey);
    if(this.#jobs.size>=12)return {ok:false,code:'MEDIA_BUSY'};
    const work=(async()=>{
      const ownerState=await this.#run(this.#args('recall',{...c,sessionKey:a.namespace}));
      if(!ownerState?.ok)return {ok:false,code:'SOCIAL_UNAVAILABLE'};
      if(ownerState.disabled)return {ok:false,code:'MEDIA_CANCELLED'};
      const agent=await this.agentConfigStore.read();
      if(a.kind==='image'&&(!agent.enabled||!agent.apiKey))return {ok:false,code:'VISION_NOT_CONFIGURED'};
      if(!permittedNow())return {ok:false,code:'MEDIA_CANCELLED'};
      const report=await this.media.run({type:'media',attachment:{...a,event:jobKey},...(question?{question}:{}),vision:{apiKey:agent.apiKey},
        asr:{enabled:config.asrEnabled,apiKey:config.apiKey}},async()=>{throw Error('MEDIA_RPC_DENIED');},v=>v.report);
      const latestOwner=await this.#run(this.#args('recall',{...c,sessionKey:a.namespace}));
      const activeConfig=await this.configStore.read();
      if(!permittedNow()||!latestOwner?.ok||latestOwner.disabled||!activeConfig.enabled)return {ok:false,code:'MEDIA_CANCELLED'};
      if(report.ok&&a.kind==='audio'&&!String(report.transcript||'').trim())return {ok:false,code:'AUDIO_EMPTY'};
      const result={...report,event:a.event,namespace:a.namespace,at:a.at,kind:a.kind,...(question?{requester:c.sessionKey}:{})};
      this.#results.set(jobKey,result);while(this.#results.size>128)this.#results.delete(this.#results.keys().next().value);
      const white=c.scope==='c2c'||c.access==='white';
      const permitted=a.kind==='audio'||force||white&&config.autoWhiteImages||config.autoMemes&&report.is_meme===true;
      if(report.ok&&permitted&&!question&&featureEnabled(c,'memory')){
        const text=a.kind==='audio'?report.transcript:[report.description,report.visible_text].filter(Boolean).join(' / ');
        if(text){
          const owner={...c,sessionKey:a.namespace};
          await this.#run(this.#args('media',owner,{event:a.event,text:text.slice(0,600),kind:report.is_meme?'meme':a.kind}));
          if(a.kind==='audio')await this.#run(this.#args('observe',owner,{event:hash(a.event+':transcript'),text:text.slice(0,2000)}));
        }
      }
      return result;
    })();
    this.#jobs.set(jobKey,work);try{return await work;}finally{this.#jobs.delete(jobKey);}
  }
  #manage(name,c){
    const cacheKey=name!=='查看'&&key(c.eventKey)?c.sessionKey+':'+c.eventKey:null;
    if(cacheKey&&this.#controlOutcomes.has(cacheKey))return this.#controlOutcomes.get(cacheKey);
    const work=(async()=>{
      const action=({'关闭':'off','开启':'on','清空':'clear','查看':'recall'})[name];
      const r=await this.#run(this.#args(action,c));
      if(!r.ok)return {reply:'记忆暂时没能更新，稍后再试~'};
      if(action!=='recall'){
        this.#batches.delete(c.sessionKey);
        this.#epochs.set(c.sessionKey,(this.#epochs.get(c.sessionKey)||0)+1);
        if(this.#latest.get(c.scopeKey)?.namespace===c.sessionKey)this.#latest.delete(c.scopeKey);
        for(const [k,v] of this.#results)if(v.namespace===c.sessionKey||v.requester===c.sessionKey)this.#results.delete(k);
        return {reply:action==='off'?'好，在这个对话里不再记录你，之前的记录也清掉了':action==='on'?'好，之后会记住你在这里说过的偏好~':'这里关于你的记忆已经清空了',reset:true};
      }
      const preferences=r.preferences||[];
      const mood=r.mood?.[0];return {reply:r.disabled?'这里关于你的记录已关闭':
        [preferences.length?preferences.map(p=>p.text).join('\n'):'暂时还没有记下你的稳定偏好~',...(r.habits||[]).map(h=>'聊天时'+h.label),mood?'最近你说过：'+mood.said:'',r.style?.effective_samples?'也在慢慢熟悉你的聊天习惯':''].filter(Boolean).join('\n'),social:r};

    })().catch(error=>({reply:error.timedOut?'记忆处理超时（10秒时限），请稍后重试':'记忆暂时没能更新，稍后再试~'}));
    if(cacheKey){this.#controlOutcomes.set(cacheKey,work);while(this.#controlOutcomes.size>512)this.#controlOutcomes.delete(this.#controlOutcomes.keys().next().value);}
    return work;
  }
  async prepare(text,c){
    if(!this.#valid(c))return {};
    const name=memoryControl(text);
    if(name) {
      if (!featureEnabled(c,'memory') && !['关闭','清空'].includes(name)) return {reply:'本群的成员记忆已关闭，仍可发送 /记忆 清空 删除自己的旧记录。'};
      return this.#manage(name,c);
    }
    const hasVoice=Boolean(c.readVoiceTranscript)||c.media?.some(a=>a.kind==='audio');
    const hasImage=identify.test(text)||c.media?.some(a=>a.kind==='image');
    if (hasVoice&&!featureEnabled(c,'voice')) return {reply:'本群的语音理解已关闭。'};
    if (hasImage&&!featureEnabled(c,'images')) return {reply:'本群的图片理解已关闭。'};
    const config=await this.configStore.read();
    if(!config.enabled)return identify.test(text)?{reply:'识图功能当前关闭了'}:{};
    let social=await this.#run(this.#args('recall',c));
    if(!social?.ok)return {social:{ok:false,disabled:true,unavailable:true},...(identify.test(text)||c.media?.length?{reply:'这次识别暂时没能完成，稍后再试~'}:{})};
    if(social.disabled)return identify.test(text)?{reply:'你已关闭这里的记录，发送“/记忆 开启”后可以识图'}:{social};
    if (!featureEnabled(c,'memory')) social={ok:true,disabled:true};
    const current=copyIncomingMedia(c.media);
    if (typeof c.readVoiceTranscript === 'function') {
      const audio = current.find(item => item.kind === 'audio');
      const transcript = await c.readVoiceTranscript();
      if (!this.#valid(c)) return {};
      if (transcript) {
        if (audio) audio.transcript = transcript;
        else current.push({kind:'audio',url:'',transcript});
      } else if (!audio && !current.length) return {reply:'这条语音没能转成文字，请再说一次或发文字。'};
    }
    const force=identify.test(text);
    const reference=force||((c.scope==='c2c'||c.access==='white')&&/这张图|刚才.{0,8}图|图里|看.{0,8}(?:图片|照片)/u.test(text));
    const latest=this.#latest.get(c.scopeKey);
    let selected=reference?latest:null;
    let attachment=current.at(-1);
    if(reference)attachment=current.findLast(a=>a.kind==='image')??(selected||force?null:attachment);
    if(attachment){
      const event=key(c.mediaEventKey)?hash(c.mediaEventKey+':'+current.indexOf(attachment)):hash(c.sessionKey+attachment.url+(attachment.transcript||''));
      selected=latest?.event===event?latest:{...attachment,namespace:c.sessionKey,event,at:Date.now(),epoch:this.#epochs.get(c.sessionKey)||0};
    }
    if(!selected)return force?{reply:'还没收到图片，先发一张，再发 /识图 就行~'}:{social};
    const question=selected.kind==='image'?imageQuestion(text):'';
    const result=await this.#understand(selected,c,config,force,question);
    if(!result.ok)return {social,...(force||current.length?{reply:result.code==='SOCIAL_TIMEOUT'?(({download:'媒体下载超时（10秒时限）',vision:'图片识别模型响应超时（20秒时限）',asr:'语音识别模型响应超时（20秒时限）'}[result.timeout_stage]||'媒体处理超时')+'，请稍后重试'):result.code==='AUDIO_EMPTY'?'这条语音里没听清内容，再说一遍吧~':result.code==='ASR_NOT_CONFIGURED'?'这条语音没有平台转写，语音识别还没配置好':result.code==='MEDIA_EXPIRED'?'刚才那张图已过期，再发一次吧~':'这次没看清或听清，再发一次试试~'}:{})};
    if(c.scope==='group'&&c.access==='gray'&&!force&&selected.kind==='image'&&!result.is_meme)return {social};
    if(force&&!question&&featureEnabled(c,'memory')){
      const summary=[result.description,result.visible_text].filter(Boolean).join(' / ');
      await this.#run(this.#args('media',{...c,sessionKey:result.namespace},{event:result.event,kind:result.is_meme?'meme':'image',text:summary.slice(0,600)}));
    }
    return {social,media:{kind:result.kind,description:result.description||'',visible_text:result.visible_text||'',transcript:result.transcript||'',is_meme:result.is_meme===true,at:result.at},
      ...(force?{text:text.replace(identify,'').trim()||'看看刚才这张图，跟我聊聊'}:selected.kind==='audio'&&text==='[语音]'?{text:result.transcript.slice(0,320)}:{})};
  }
}
