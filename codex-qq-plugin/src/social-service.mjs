import {createHash} from 'node:crypto';
import path from 'node:path';
import {APP_ROOT} from './runtime-paths.mjs';
import {PythonAgentWorker} from './python-agent.mjs';
import {copyIncomingMedia} from './incoming-media.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const key=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const control=/^\/记忆\s*(查看|关闭|开启|清空)$/u;
const identify=/^\/识图(?:\s|$)/u;
const allowed=c=>typeof c.isAllowed==='function'?c.isAllowed():typeof c.authorize==='function'?c.authorize('chat'):true;

/** Transport orchestration only; memory, interpretation and decays live in Python tools. */
export class SocialService{
  #pending=0;#closed=false;#latest=new Map();#results=new Map();#jobs=new Map();#epochs=new Map();#batches=new Map();#insightsPending=0;
  constructor({home,configStore,agentConfigStore,memoryWorker,mediaWorker,insightWorker}={}){
    const workerPath=path.join(APP_ROOT,'python/social_worker.py');
    this.memory=memoryWorker||new PythonAgentWorker({home,workerPath,timeoutMs:10000});
    this.insight=insightWorker||(mediaWorker?null:new PythonAgentWorker({home,workerPath,timeoutMs:30000}));
    this.media=mediaWorker||new PythonAgentWorker({home,workerPath,timeoutMs:40000});
    Object.assign(this,{configStore,agentConfigStore});
  }
  close(){this.#closed=true;this.#latest.clear();this.#results.clear();this.#batches.clear();this.memory.close();this.media.close();this.insight?.close();}
  #valid(c){return !this.#closed&&key(c.sessionKey)&&key(c.scopeKey)&&allowed(c);}
  async #run(args){return this.memory.run({type:'social',args},async()=>{throw Error('SOCIAL_RPC_DENIED');},v=>v.report);}
  #args(action,c,extra={}){return {action,namespace:c.sessionKey,scope:c.scopeKey,...extra};}
  async observe(data,c){
    if(!this.#valid(c)||this.#pending>=32)return;
    // Capture the latest attachment in receipt order, before any asynchronous work.
    const attachments=copyIncomingMedia(data.media);
    const captured=attachments.map((a,i)=>({...a,namespace:c.sessionKey,event:hash(data.eventKey+':'+i),at:Date.now(),epoch:this.#epochs.get(c.sessionKey)||0}));
    const image=captured.filter(a=>a.kind==='image').at(-1);
    if(image){this.#latest.set(c.scopeKey,image);while(this.#latest.size>64)this.#latest.delete(this.#latest.keys().next().value);}
    this.#pending++;
    try{
      const config=await this.configStore.read();if(!config.enabled||!this.#valid(c))return;
      const saved=await this.#run(this.#args('observe',c,{event:data.eventKey,text:data.text.slice(0,2000)}));
      if(!saved?.ok||saved.disabled||!this.#valid(c))return;
      if(saved.observed)this.#collectInsights(data,c);
      // Background work never generates a QQ send, even for memes.
      for(const a of captured){
        if(a.kind==='image'&&!config.autoMemes&&!((c.scope==='c2c'||c.access==='white')&&config.autoWhiteImages))continue;
        if(this.#jobs.size>=12)break;
        this.#understand(a,c,config,false).catch(()=>{});
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
  async #understand(a,c,config,force){
    if((a.epoch||0)!==(this.#epochs.get(a.namespace)||0))return {ok:false,code:'MEDIA_CANCELLED'};
    if(!this.#valid(c)||Date.now()-a.at>30*60_000)return {ok:false,code:'MEDIA_EXPIRED'};
    if(this.#results.has(a.event))return this.#results.get(a.event);
    if(this.#jobs.has(a.event))return this.#jobs.get(a.event);
    if(this.#jobs.size>=12)return {ok:false,code:'MEDIA_BUSY'};
    const work=(async()=>{
      const ownerState=await this.#run(this.#args('recall',{...c,sessionKey:a.namespace}));
      if(ownerState.disabled)return {ok:false,code:'MEDIA_CANCELLED'};
      const agent=await this.agentConfigStore.read();
      if(a.kind==='image'&&(!agent.enabled||!agent.apiKey))return {ok:false,code:'VISION_NOT_CONFIGURED'};
      const report=await this.media.run({type:'media',attachment:a,vision:{apiKey:agent.apiKey},
        asr:{enabled:config.asrEnabled,apiKey:config.apiKey}},async()=>{throw Error('MEDIA_RPC_DENIED');},v=>v.report);
      const latestOwner=await this.#run(this.#args('recall',{...c,sessionKey:a.namespace}));
      const activeConfig=await this.configStore.read();
      if(!this.#valid(c)||latestOwner.disabled||!activeConfig.enabled||(a.epoch||0)!==(this.#epochs.get(a.namespace)||0))return {ok:false,code:'MEDIA_CANCELLED'};
      const result={...report,event:a.event,namespace:a.namespace,at:a.at,kind:a.kind};
      this.#results.set(a.event,result);while(this.#results.size>128)this.#results.delete(this.#results.keys().next().value);
      const white=c.scope==='c2c'||c.access==='white';
      const permitted=a.kind==='audio'||force||white&&config.autoWhiteImages||config.autoMemes&&report.is_meme===true;
      if(report.ok&&permitted){
        const text=a.kind==='audio'?report.transcript:[report.description,report.visible_text].filter(Boolean).join(' / ');
        if(text){
          const owner={...c,sessionKey:a.namespace};
          await this.#run(this.#args('media',owner,{event:a.event,text:text.slice(0,600),kind:report.is_meme?'meme':a.kind}));
          if(a.kind==='audio')await this.#run(this.#args('observe',owner,{event:hash(a.event+':transcript'),text:text.slice(0,2000)}));
        }
      }
      return result;
    })();
    this.#jobs.set(a.event,work);try{return await work;}finally{this.#jobs.delete(a.event);}
  }
  async prepare(text,c){
    if(!this.#valid(c))return {};
    const config=await this.configStore.read();
    const raw=text.trim();
    const natural=/^(?:清空|删除)(?:我(?:的)?|这里的)?(?:全部|所有)?(?:记忆|记录)[。！!]?$/u.test(raw)?'清空':/^(?:别再记我|不要再记录我|不要记录我的消息|关闭我的记忆)[。！!]?$/u.test(raw)?'关闭':/^(?:你(?:还)?记得我什么|看看我的记忆)[?？]?$/u.test(raw)?'查看':null;
    const m=control.exec(raw)||(natural?[raw,natural]:null);
    if(m){
      const action=({'关闭':'off','开启':'on','清空':'clear','查看':'recall'})[m[1]];
      const r=await this.#run(this.#args(action,c));
      if(!r.ok)return {reply:'记忆暂时没能更新，稍后再试~'};
      if(action!=='recall'){
        this.#batches.delete(c.sessionKey);
        this.#epochs.set(c.sessionKey,(this.#epochs.get(c.sessionKey)||0)+1);
        this.#latest.delete(c.scopeKey);for(const [k,v] of this.#results)if(v.namespace===c.sessionKey)this.#results.delete(k);
        return {reply:action==='off'?'好，在这个对话里不再记录你，之前的记录也清掉了':action==='on'?'好，之后会记住你在这里说过的偏好~':'这里关于你的记忆已经清空了',reset:true};
      }
      const preferences=r.preferences||[];
      const mood=r.mood?.[0];return {reply:r.disabled?'这里关于你的记录已关闭':
        [preferences.length?preferences.map(p=>p.text).join('\n'):'暂时还没有记下你的稳定偏好~',...(r.habits||[]).map(h=>'聊天时'+h.label),mood?'最近你说过：'+mood.said:'',r.style?.effective_samples?'也在慢慢熟悉你的聊天习惯':''].filter(Boolean).join('\n'),social:r};
    }
    if(!config.enabled)return identify.test(text)?{reply:'识图功能当前关闭了'}:{};
    const social=await this.#run(this.#args('recall',c));
    if(social.disabled)return identify.test(text)?{reply:'你已关闭这里的记录，发送“/记忆 开启”后可以识图'}:{social};
    const current=copyIncomingMedia(c.media);
    const reference=identify.test(text)||((c.scope==='c2c'||c.access==='white')&&/这张图|刚才.{0,8}图|图里|看.{0,8}(?:图片|照片)/u.test(text));
    let selected=reference?this.#latest.get(c.scopeKey):null;
    if(!selected&&current.length){
      selected=current.at(-1);
      // Match the observer's current attachment where possible.
      const latest=this.#latest.get(c.scopeKey);
      selected=latest&&latest.url===selected.url?latest:{...selected,namespace:c.sessionKey,event:key(c.mediaEventKey)?hash(c.mediaEventKey+':'+(current.length-1)):hash(c.sessionKey+selected.url+(selected.transcript||'')),at:Date.now(),epoch:this.#epochs.get(c.sessionKey)||0};
    }
    if(!selected)return identify.test(text)?{reply:'还没收到图片，先发一张，再发 /识图 就行~'}:{social};
    const force=identify.test(text);
    const result=await this.#understand(selected,c,config,force);
    if(!result.ok)return {social,...(force||current.length?{reply:result.code==='ASR_NOT_CONFIGURED'?'这条语音没有平台转写，语音识别还没配置好':result.code==='MEDIA_EXPIRED'?'刚才那张图已过期，再发一次吧~':'这次没看清或听清，再发一次试试~'}:{})};
    if(c.scope==='group'&&c.access==='gray'&&!force&&selected.kind==='image'&&!result.is_meme)return {social};
    if(force){
      const summary=[result.description,result.visible_text].filter(Boolean).join(' / ');
      await this.#run(this.#args('media',{...c,sessionKey:result.namespace},{event:result.event,kind:result.is_meme?'meme':'image',text:summary.slice(0,600)}));
    }
    return {social,media:{kind:result.kind,description:result.description||'',visible_text:result.visible_text||'',transcript:result.transcript||'',is_meme:result.is_meme===true,at:result.at},
      ...(force?{text:text.replace(identify,'').trim()||'看看刚才这张图，跟我聊聊'}:selected.kind==='audio'&&text==='[语音]'?{text:result.transcript.slice(0,320)}:{})};
  }
}
