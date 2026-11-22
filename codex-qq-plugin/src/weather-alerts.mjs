import {WeatherAlertWorker} from './weather-alert-worker.mjs';
export {WeatherAlertWorker};
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson} from './storage.mjs';
import {measureSpan} from './telemetry.mjs';
import {renderWeatherAlert} from './weather-alert-image.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const validKey=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const commands=/^\/?(?:(?:开启|关闭)\s*)?实时预警(?:\s|$)/u;
const retryable=new Set(['PAUSED','NOT_CONNECTED','RATE_LIMIT_MINUTE','RATE_LIMIT_TARGET','RATE_LIMIT_DAY','REQUEST_EXPIRED']);
const fail=code=>Object.assign(new Error(code),{code});

const initial=()=>({version:1,revision:0,targets:{},previous:[],history:[],pending:{}});
function validate(value){
  if(value?.version!==1||!Number.isSafeInteger(value.revision)||!value.targets||Array.isArray(value.targets)||
    Object.keys(value.targets).length>21||!Array.isArray(value.previous)||value.previous.length>3000||
    !Array.isArray(value.history)||value.history.length>4000||!value.pending||Object.keys(value.pending).length>3000)throw fail('ALERT_STORAGE_INVALID');
  for(const [key,t] of Object.entries(value.targets))if(!validKey(key)||typeof t.enabled!=='boolean'||!Number.isSafeInteger(t.revision)||
    !Array.isArray(t.regions)||t.regions.length>5||new Set(t.regions.map(r=>r.code)).size!==t.regions.length||
    t.regions.some(r=>!/^\d{6}$/.test(r.code)||typeof r.enabled!=='boolean'||typeof r.name!=='string'||r.name.length>100))throw fail('ALERT_STORAGE_INVALID');
  return value;
}

/** Persist subscriptions and delivery claims; the core alone resolves actual QQ recipients. */
export class WeatherAlertsService {
  #state=initial();#loaded=false;#load=null;#tail=Promise.resolve();#poll=null;#timer=null;#closed=false;#epochs=new Map();
  #health={lastCheckedAt:null,lastSuccessAt:null,lastCode:null,sourceCount:null,pending:0};
  constructor({home,core,adapter,worker=new WeatherAlertWorker(),render=renderWeatherAlert,now=()=>Date.now(),intervalMs=60000}){
    Object.assign(this,{home,core,adapter,worker,render,now,intervalMs});this.file=path.join(home,'.private','weather-alerts.json');
  }
  async init(){
    if(this.#loaded)return;
    if(!this.#load)this.#load=(async()=>{
      try{const raw=await fs.readFile(this.file,'utf8');if(raw.length>2_000_000)throw Error();this.#state=validate(JSON.parse(raw));}
      catch(error){if(error.code!=='ENOENT'){this.#health.lastCode='ALERT_STORAGE_INVALID';throw fail('ALERT_STORAGE_INVALID');}}
      // A crash after claiming may have sent the image; never replay that claim.
      this.#loaded=true;
    })();
    return this.#load;
  }
  #write(work){
    const task=this.#tail.then(async()=>{await this.init();const next=structuredClone(this.#state);const result=await work(next);
      await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});await atomicJson(this.file,next);this.#state=next;return result;});
    this.#tail=task.catch(()=>{});return task;
  }
  #target(key){return this.core.weatherAlertTargets().find(t=>t.key===key);}
  #enabled(key,code){const t=this.#state.targets[key];return t?.enabled&&t.regions.some(r=>r.code===code&&r.enabled)&&this.#target(key)?.allowed;}
  async status(){
    try{await this.init();}catch{return {ok:false,code:'ALERT_STORAGE_INVALID',targets:[]};}
    return {ok:true,intervalSeconds:this.intervalMs/1000,source:'中国气象局 / 地方官方公告',revision:this.#state.revision,
      health:{...this.#health},targets:this.core.weatherAlertTargets().map(t=>({...t,...this.#state.targets[t.key],
        enabled:this.#state.targets[t.key]?.enabled===true,regions:this.#state.targets[t.key]?.regions||[]}))};
  }
  async search(query){return this.worker.run({action:'search',query});}
  async configure({targetKey,operation,query,code,enabled,revision,authorize=()=>true}={}){
    if(!validKey(targetKey)||!['add','remove','toggle','master'].includes(operation)||
      (revision!==undefined&&!Number.isSafeInteger(revision)))throw fail('INVALID_INPUT');
    // Invalidate queued/in-flight delivery BEFORE awaiting persistence or Python.
    const epoch=(this.#epochs.get(targetKey)||0)+1;this.#epochs.set(targetKey,epoch);
    await this.init();
    const target=this.#target(targetKey);
    if(!target)return {ok:false,code:'ALERT_TARGET_DENIED'};
    let area;
    if(operation==='add'){
      if(!target.allowed)return {ok:false,code:'ALERT_TARGET_DENIED'};
      const resolved=await this.worker.run({action:'command',query:'/开启实时预警 '+String(query||code||'')});
      if(!resolved.ok)return resolved;
      area=resolved.area;
    }else if(operation==='master'){
      if(typeof enabled!=='boolean'||(enabled&&!target.allowed))return {ok:false,code:'ALERT_TARGET_DENIED'};
    }else if(!/^\d{6}$/.test(code||'')||(operation==='toggle'&&typeof enabled!=='boolean'))throw fail('INVALID_INPUT');
    return this.#write(state=>{
      if(authorize()!==true||((operation==='add'||enabled===true)&&!this.#target(targetKey)?.allowed))return {ok:false,code:'ALERT_TARGET_DENIED'};
      if(this.#epochs.get(targetKey)!==epoch)return {ok:false,code:'ALERT_CONFIG_CHANGED'};
      if(revision!==undefined&&revision!==state.revision)return {ok:false,code:'ALERT_CONFIG_CHANGED'};
      if(!state.targets[targetKey]&&Object.keys(state.targets).length>=21)return {ok:false,code:'ALERT_LIMIT'};
      const t=state.targets[targetKey]??={enabled:false,revision:0,regions:[]};
      if(operation==='add'){
        const existing=t.regions.find(r=>r.code===area.code);
        if(!existing&&t.regions.length>=5)return {ok:false,code:'ALERT_LIMIT'};
        if(existing)existing.enabled=true;else t.regions.push({...area,enabled:true});
        t.enabled=true;
      }else if(operation==='master')t.enabled=enabled;
      else{
        const region=t.regions.find(r=>r.code===code);if(!region)return {ok:false,code:'ALERT_AREA_NOT_SUBSCRIBED'};
        if(operation==='remove')t.regions=t.regions.filter(r=>r.code!==code);else region.enabled=enabled;
      }
      t.revision++;state.revision++;
      return {ok:true,code:'ALERT_SAVED',area,revision:state.revision};
    });
  }
  async handle(text,context){
    if(!commands.test(text.trim()))return null;
    const target=this.#target(context.scopeKey);
    if(!target||!target.allowed||context.authorize?.('white','weather')===false)return {text:'当前聊天尚未开放天气预警，请在控制台开启天气功能。',requiredAccess:'chat'};
    const plan=await this.worker.run({action:'command',query:text});
    if(!plan.ok)return {text:plan.suggestions?.length?'地点不唯一，请写完整地名：'+plan.suggestions.map(a=>a.name).join('、'):'请使用 /开启实时预警 北京海淀 或 /关闭实时预警 北京海淀。',requiredFeature:'weather'};
    if(plan.operation==='list'){
      await this.init();const t=this.#state.targets[target.key];
      return {text:t?.regions.length?`${t.enabled?'实时预警':'实时预警已暂停'}：`+t.regions.map(r=>r.name+(r.enabled?'（开启）':'（关闭）')).join('、'):'尚未订阅。发送 /开启实时预警 北京海淀。',requiredFeature:'weather'};
    }
    if(context.authorize?.('white','weather')===false)return null;
    const result=await this.configure({targetKey:target.key,operation:plan.operation==='enable'?'add':'toggle',code:plan.area.code,enabled:false,
      authorize:()=>context.authorize?.('white','weather')!==false});
    const label=plan.area.name;
    const response=result.ok?`${plan.operation==='enable'?'已开启':'已关闭'} ${label} 实时预警。`+(plan.operation==='enable'?'官方有新增或更新时推送图片，含上级地区预警。':''):
      result.code==='ALERT_AREA_NOT_SUBSCRIBED'?`${label} 尚未订阅。`:result.code==='ALERT_LIMIT'?'每个聊天最多订阅 5 个地区。':'设置未保存，请重试。';
    return {text:response,requiredFeature:'weather'};
  }
  start(){if(this.#timer||this.#closed)return;this.#timer=setInterval(()=>{void this.poll().catch(()=>{});},this.intervalMs);this.#timer.unref();void this.poll().catch(()=>{});}
  poll(){if(this.#closed)return Promise.resolve({ok:false,code:'ALERT_STOPPED'});if(this.#poll)return this.#poll;
    const task=this.#run();this.#poll=task;return task.finally(()=>{this.#poll=null;});}
  async #run(){
    try{
      await this.init();
      const targets=this.core.weatherAlertTargets().filter(t=>t.allowed&&this.#state.targets[t.key]?.enabled);
      const snapshots=targets.map(t=>({...t,revision:this.#state.targets[t.key].revision,epoch:this.#epochs.get(t.key)||0,
        codes:this.#state.targets[t.key].regions.filter(r=>r.enabled).map(r=>r.code)})).filter(t=>t.codes.length);
      const codes=[...new Set(snapshots.flatMap(t=>t.codes))];
      if(!codes.length)return {ok:true,code:'ALERT_IDLE',sent:0};
      if(this.core.status().paused||this.adapter.status().state!=='connected')return {ok:false,code:'PAUSED',sent:0};
      this.#health.lastCheckedAt=new Date(this.now()).toISOString();
      const feed=await this.worker.run({action:'poll',codes,previous:this.#state.previous});
      if(!feed.ok||feed.schema!=='weather.alerts.v1'||!Array.isArray(feed.alerts))throw fail(feed.code||'ALERT_SOURCE_SCHEMA');
      this.#health={...this.#health,lastSuccessAt:feed.checkedAt,lastCode:feed.sourceFailures?.length?'ALERT_SOURCE_PARTIAL':'OK',sourceCount:feed.sourceCount,sourceFailures:feed.sourceFailures||[],coverage:feed.coverage||[]};
      const current=target=>!this.#closed&&(this.#epochs.get(target.key)||0)===target.epoch&&
        this.#state.targets[target.key]?.revision===target.revision&&this.#state.targets[target.key]?.enabled&&this.#target(target.key)?.allowed;
      const jobs=[];
      for(const target of snapshots)for(const alert of feed.alerts){
        const matches=alert.matches.filter(m=>target.codes.includes(m.area.code));if(!matches.length)continue;
        const key=hash(target.key+':'+alert.fingerprint);
        jobs.push({target,alert:{...alert,matches},key});
      }
      await this.#write(state=>{
        const retained=state.previous.filter(a=>feed.sourceFailures?.includes(a.sourceKey||(a.series==='beijing:air-pollution'?'beijing_air':'cma')));
        state.previous=[...retained,...feed.alerts.map(a=>({series:a.series,sourceKey:a.sourceKey||'cma',fingerprint:a.fingerprint,severity:a.severity,color:a.color,publishedAt:a.publishedAt}))].slice(0,3000);
        const pending=feed.sourceFailures?.length?{...state.pending}:{};
        for(const j of jobs)if(!state.history.some(h=>h.key===j.key))pending[j.key]=state.pending[j.key]||{change:j.alert.change==='未变'?'新增':j.alert.change,previousColor:j.alert.previousColor};
        state.pending=pending;
      });
      let sent=0,attempted=0;
      const permissionDenied=new Set();
      for(const job of jobs){
        const {target,key}=job;if(!current(target)||permissionDenied.has(target.key)||this.#state.history.some(h=>h.key===key))continue;
        if(attempted>=10)break; // Bounded burst; core quotas and serial admission remain authoritative.
        const event={...job.alert,...this.#state.pending[key],checkedAt:feed.checkedAt};
        const image=await measureSpan('warning_render',()=>this.render(event));
        if(!current(target))continue;
        // Claim BEFORE upload. A process crash/unknown send is never automatically replayed.
        await this.#write(state=>{state.history.push({key,state:'claimed',at:this.now()});state.history=state.history.slice(-4000);});
        const result=await this.core.notifyWeatherAlert({targetKey:target.key,image,idempotencyKey:'weather-alert:'+key,
          authorize:()=>current(target)&&event.matches.some(m=>this.#enabled(target.key,m.area.code)),
          deliveryDeadline:this.now()+120000});
        await this.#write(state=>{
          const h=state.history.find(h=>h.key===key);
          if(retryable.has(result.code)||result.code==='ALERT_CANCELLED')state.history=state.history.filter(h=>h.key!==key);
          else if(h){h.state=result.code==='SENT'?'sent':result.deliveryState||'rejected';h.code=result.code;delete state.pending[key];}
        });
        if(result.code==='SENT')sent++;
        if(!retryable.has(result.code)&&result.code!=='ALERT_CANCELLED')attempted++;
        if(!result.ok&&result.code!=='DUPLICATE'){
          this.#health.lastCode=result.code;
          if(result.code==='QQ_TARGET_PERMISSION_DENIED')permissionDenied.add(target.key);
          else break;
        }
      }
      this.#health.pending=Object.keys(this.#state.pending).length;
      return {ok:true,code:'ALERT_CHECKED',sent,attempted,pending:this.#health.pending,checkedAt:feed.checkedAt};
    }catch(error){this.#health.lastCode=error.code||'ALERT_SOURCE_UNAVAILABLE';return {ok:false,code:this.#health.lastCode,sent:0};}
  }
  async preview(code){const data=await this.worker.run({action:'poll',codes:[code]});
    if(!data.ok)return data;
    if(!data.alerts.length&&data.sourceFailures?.length)return {ok:false,code:'ALERT_SOURCE_PARTIAL',sourceFailures:data.sourceFailures,checkedAt:data.checkedAt};
    if(!data.alerts.length)return {ok:true,code:'ALERT_NONE',checkedAt:data.checkedAt};
    const image=await this.render({...data.alerts[0],checkedAt:data.checkedAt});
    return {ok:true,code:'ALERT_PREVIEW',checkedAt:data.checkedAt,alert:data.alerts[0],image:{mimeType:image.mimeType,base64:image.buffer.toString('base64')},qqSent:false};}
  close(){this.#closed=true;clearInterval(this.#timer);this.worker.close?.();}
}
