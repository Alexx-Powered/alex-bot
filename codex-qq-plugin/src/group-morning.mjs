import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {MORNING_PART_FEATURES,MORNING_MAX_RETRIES} from './group-features.mjs';
import {withHeavyWorkGuard} from './heavy-work.mjs';
import {measureSpan} from './telemetry.mjs';
import {failureDetail} from './trace-diagnostics.mjs';

const prepareTime='07:25',sendTime='07:30',cutoffTime='07:40';
const reportNames={weather:'早间天气',campus:'三号楼自习简报'};
const windowEnded={ok:false,code:'MORNING_WINDOW_ENDED'};
const retryDelayMs=15_000;
const campusRetryable=new Set(['CAMPUS_BUSY','CAMPUS_NETWORK_ERROR','CAMPUS_NAVIGATION_TIMEOUT',
  'CAMPUS_LOGIN_TIMEOUT','CAMPUS_LOGIN_ACTION_TIMEOUT','CAMPUS_SEARCH_TIMEOUT','CAMPUS_WORKER_TIMEOUT',
  'CAMPUS_LOGIN_ACCOUNT_TIMEOUT','CAMPUS_LOGIN_PASSWORD_TIMEOUT','CAMPUS_LOGIN_SUBMIT_TIMEOUT',
  'CAMPUS_BROWSER_UNAVAILABLE','CAMPUS_QUERY_FAILED','CAMPUS_RENDER_FAILED']);
const quotaWait=new Set(['RATE_LIMIT_MINUTE','RATE_LIMIT_TARGET']);

export function groupMorningClock(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  }).formatToParts(now).map(part=>[part.type,part.value]));
  const time=parts.hour+':'+parts.minute;
  return {date:parts.year+'-'+parts.month+'-'+parts.day,inWindow:time>=sendTime&&time<cutoffTime,
    canPrepare:time>=prepareTime&&time<cutoffTime};
}

export function createGroupMorningStatus() {
  let cached={active:false,prepareActive:false,prepareTime,time:sendTime,cutoffTime,timezone:'Asia/Shanghai'},expires=0;
  return async()=>{
    if (Date.now()<expires) return cached;
    expires=Date.now()+30_000;
    try {
      const result=await promisify(execFile)('/bin/systemctl',['show','alexbot-group-morning.timer','--property=ActiveState','--value'],{timeout:1500,windowsHide:true});
      cached={...cached,active:result.stdout.trim()==='active'};
      const prepared=await promisify(execFile)('/bin/systemctl',['show','alexbot-group-morning-prepare.timer','--property=ActiveState','--value'],{timeout:1500,windowsHide:true});
      cached={...cached,prepareActive:prepared.stdout.trim()==='active'};
    } catch {cached={...cached,active:false};}
    return cached;
  };
}

/** Fixed daily orchestration. Recipients and delivery keys remain core-owned. */
export class GroupMorningService {
  #plan=null;#sending=null;
  constructor({core,adapter,morning,campus,now=()=>new Date(),sleep=delay,
    deadlineSignal=ms=>AbortSignal.timeout(ms),runRetry=(_context,work)=>work()}) {
    Object.assign(this,{core,adapter,morning,campus,now,sleep,deadlineSignal,runRetry});
  }

  ready() {
    const status=this.core.status();
    if (!status.paired) return 'NOT_PAIRED';
    if (status.paused) return 'PAUSED';
    if (this.adapter.status().state!=='connected') return 'NOT_CONNECTED';
    if (status.remainingDailyAttempts===0) return 'RATE_LIMIT_DAY';
    return null;
  }

  status() {
    const plan=this.#plan,clock=groupMorningClock(this.now());
    return !plan||plan.date!==clock.date?{date:null,parts:{}}:{date:plan.date,parts:Object.fromEntries(
      Object.entries(plan.jobs).map(([part,job])=>[part,{state:job.state,code:job.code}]))};
  }

  // A restart drops prepared images; outstanding parts can use their remaining
  // persisted attempts. The prepare and send entry points share the daily plan.
  #start(clock) {
    if(this.#plan?.date===clock.date)return this.#plan;
    const targets=this.core.captureMorningTargets();
    const cutoff=Date.parse(clock.date+'T'+cutoffTime+':00+08:00');
    const signal=this.deadlineSignal(Math.max(0,cutoff-Number(this.now())));
    const closed=signal.aborted?Promise.resolve(windowEnded):new Promise(resolve=>{
      signal.addEventListener('abort',()=>resolve(windowEnded),{once:true});
    });
    const plan={date:clock.date,targets,jobs:{},cutoff,signal,closed,permissionDenied:new Set()};
    this.#plan=plan;
    const pending=this.core.pendingMorningParts(clock.date,targets);
    for(const part of Object.keys(reportNames)) {
      if(!pending[part])continue;
      const job={state:'preparing',code:null,attempt:0};
      plan.jobs[part]=job;
      job.promise=this.#preparePart(plan,part,job).then(outcome=>{Object.assign(job,outcome);});
    }
    return plan;
  }

  #preparationStop(plan,part) {
    if(this.#plan!==plan||!this.core.hasMorningPreparationTarget(plan.date,plan.targets,part))return 'MORNING_CANCELLED';
    if(plan.signal.aborted||Number(this.now())>=plan.cutoff)return 'MORNING_WINDOW_ENDED';
    const clock=groupMorningClock(this.now());
    if(clock.date!==plan.date||!clock.canPrepare)return 'MORNING_CANCELLED';
    return this.ready();
  }

  async #generate(plan,part,attempt) {
    const check=()=>{
      const stop=this.#preparationStop(plan,part);
      if(stop)throw Error(stop);
    };
    check();
    const report=part==='weather'?
      await withHeavyWorkGuard(()=>this.#preparationStop(plan,part),()=>
        this.morning.create({scheduledMorning:true,retrySources:false,backupWeather:attempt!==3,
          ...(attempt===2?{visualCrossingWeather:true}:{})})):
      await this.campus.run({date:plan.date},'report',{scheduledMorning:true,authorize:()=>!this.#preparationStop(plan,part)});
    await this.core.waitForPendingOperations();
    check();
    if(part==='campus'&&report?.data?.ok===false){
      const code=failureDetail('morning_campus_prepare',report.data).code;
      throw Error(code?.startsWith('CAMPUS_')?code:'CAMPUS_IMAGE_MISSING');
    }
    if(!report?.image||report.ok===false||(part==='weather'&&report.date!==plan.date)||
      (part==='campus'&&report.data&&(report.data.ok!==true||report.data.date!==plan.date))){
      if(part==='weather'&&report?.code==='MORNING_DATA_INCOMPLETE'){
        throw Object.assign(Error(report.code),{retryable:report.retryable===true,morningQuality:report.morningQuality});
      }
      throw Error(part==='weather'?'MORNING_REPORT_INVALID':'CAMPUS_IMAGE_MISSING');
    }
    return report.image;
  }

  async #attempt(plan,part,attempt) {
    const stage='morning_'+part+'_prepare';
    try{
      const image=await measureSpan(stage,()=>Promise.race([this.#generate(plan,part,attempt),
        plan.closed.then(()=>{throw Error('MORNING_WINDOW_ENDED');})]));
      return {ok:true,code:'MORNING_PREPARED',prepared:1,state:'ready',image};
    }catch(error){
      const detail=failureDetail(stage,error);
      const code=detail.code??(part==='weather'?'MORNING_REPORT_FAILED':'CAMPUS_REPORT_FAILED');
      const retryable=part==='weather'?(code==='MORNING_DATA_INCOMPLETE'&&error?.retryable===true)||code==='HEAVY_WORK_BUSY':
        campusRetryable.has(code);
      return {ok:false,code,retryable,state:code==='MORNING_CANCELLED'?'cancelled':'failed',
        detail:detail.code?detail.message:failureDetail(stage,{code}).message};
    }
  }

  async #preparePart(plan,part,job) {
    for(;;){
      const stop=this.#preparationStop(plan,part);
      if(stop)return {state:stop==='MORNING_CANCELLED'?'cancelled':'failed',code:stop};
      const claim=await Promise.race([this.core.claimMorningAttempt(plan.date,part,()=>!this.#preparationStop(plan,part)),plan.closed]);
      job.attempt=claim.attempt??job.attempt;
      if(!claim.ok){
        const code=claim.code==='MORNING_CANCELLED'?(this.#preparationStop(plan,part)??claim.code):claim.code;
        if(claim.lastCode)job.lastFailure=failureDetail('morning_'+part+'_prepare',{code:claim.lastCode}).message;
        return {state:code==='MORNING_CANCELLED'?'cancelled':'failed',code};
      }
      const work=()=>this.#attempt(plan,part,claim.attempt);
      const outcome=claim.attempt===1?await work():await this.runRetry({
        operation:'morning.retry',date:plan.date,part,retry:claim.attempt-1,
      },work);
      if(outcome.state==='failed'){
        await Promise.race([this.core.recordMorningFailure(plan.date,part,claim.attempt,outcome.code),plan.closed]);
      }
      if(!outcome.retryable||claim.attempt===1+MORNING_MAX_RETRIES)return outcome;
      job.lastFailure=outcome.detail;
      const remaining=plan.cutoff-Number(this.now());
      if(remaining>0&&!plan.signal.aborted)await Promise.race([this.sleep(Math.min(retryDelayMs,remaining)),plan.closed]);
    }
  }

  async prepare() {
    await this.core.waitForPendingOperations();
    const clock=groupMorningClock(this.now());
    const stop=code=>({ok:false,code,attempted:0,sent:0});
    if(!clock.canPrepare)return stop('MORNING_NOT_DUE');
    const unavailable=this.ready();if(unavailable)return stop(unavailable);
    if(!this.core.captureMorningTargets().length)return stop('NO_MORNING_GROUPS');
    const jobs=Object.entries(this.#start(clock).jobs);
    await Promise.all(jobs.map(([,job])=>job.promise));
    const failedParts=jobs.filter(([,job])=>job.state==='failed').map(([part,job])=>({part,code:job.code}));
    const prepared=jobs.filter(([,job])=>job.state==='ready').length;
    return {ok:!failedParts.length,code:failedParts[0]?.code??(prepared?'MORNING_PREPARED':'MORNING_CANCELLED'),attempted:0,sent:0,
      prepared,...(failedParts.length?{failedParts}:{})};
  }

  run() {
    if(this.#sending)return this.#sending;
    const task=this.#run();this.#sending=task;
    return task.finally(()=>{if(this.#sending===task)this.#sending=null;});
  }

  async #run() {
    await this.core.waitForPendingOperations();
    const clock=groupMorningClock(this.now());
    const stop=code=>({ok:false,code,attempted:0,sent:0});
    if (!clock.inWindow) return stop('MORNING_NOT_DUE');
    const unavailable=this.ready();
    if (unavailable) return stop(unavailable);
    const targets=this.core.captureMorningTargets();
    if (!targets.length) return stop('NO_MORNING_GROUPS');
    const pending=this.core.pendingMorningParts(clock.date,targets);
    if (!pending.weather&&!pending.campus) return stop('DUPLICATE');
    const plan=this.#start(clock);
    const deliveryFailures=[];
    const remaining=new Set(Object.keys(plan.jobs));
    let attempted=0,sent=0;
    // A ready weather image can leave at 07:30 while campus is still collecting,
    // and vice versa. Generation and sending are single-flight per day/entry.
    while(remaining.size) {
      const part=await Promise.race([...remaining].map(part=>plan.jobs[part].promise.then(()=>part)));
      remaining.delete(part);const job=plan.jobs[part];
      if(job.state!=='ready')continue;
      const delivery=await measureSpan('morning_'+part+'_delivery',()=>this.#deliverPart(plan,part),result=>result.ok?null:result);
      attempted+=delivery.attempted;sent+=delivery.sent;
      if(!delivery.ok){
        deliveryFailures.push({part,code:delivery.code,attempt:job.attempt,
          detail:failureDetail('morning_'+part+'_delivery',delivery).message});
        if(delivery.code!=='QQ_TARGET_PERMISSION_DENIED')break;
      }
    }
    const failures=Object.entries(plan.jobs)
      .filter(([part,job])=>job.state==='failed'&&this.core.hasMorningPreparationTarget(plan.date,plan.targets,part))
      .map(([part,{code,attempt,detail,lastFailure}])=>({part,code,attempt,detail,lastFailure}));
    failures.unshift(...deliveryFailures);
    if(failures.length){
      const notice=await measureSpan('morning_failure_notice',()=>this.#notifyFailure(plan,failures),
        result=>result.ok||result.code==='DUPLICATE'?null:result);
      return {ok:false,code:failures[0].code,attempted,sent,failedParts:failures.map(({part,code})=>({part,code})),
        failureNotice:{ok:notice.ok,code:notice.code}};
    }
    if(!sent&&!attempted)return {ok:false,code:'MORNING_CANCELLED',attempted,sent};
    return {ok:true,code:'SENT',attempted,sent};
  }

  async #notifyFailure(plan,failures) {
    const summary=failures.map(({part,code,attempt,detail,lastFailure})=>{
      const reason=detail??failureDetail('morning_'+part+'_prepare',{code}).message;
      const previous=lastFailure&&['MORNING_WINDOW_ENDED','MORNING_RETRIES_EXHAUSTED'].includes(code)?'\n上次失败 '+lastFailure:'';
      return reportNames[part]+'（生成 '+attempt+' 次）\n'+reason+previous;
    });
    const text=['【早报失败】'+plan.date,...summary].join('\n');
    const until=Number(this.now())+60_000;
    for(;;){
      const unavailable=this.ready();
      if(unavailable)return {ok:false,code:unavailable};
      const notice=await this.core.notify({text,idempotencyKey:'group-morning-failure-'+plan.date});
      if(!quotaWait.has(notice.code)||Number(this.now())>=until)return notice;
      // A local quota check returned before submitting anything to QQ.
      await this.sleep(1000);
    }
  }

  async #deliverPart(plan,part) {
    let attempted=0,sent=0,denied=false;
    for(const target of plan.targets) {
      await this.core.waitForPendingOperations();
      while (this.core.pendingMorningParts(plan.date,[target])[part]) {
        if(plan.permissionDenied.has(target.groupKey)){denied=true;break;}
        const current=groupMorningClock(this.now()),unavailable=this.ready();
        if (!current.inWindow||current.date!==plan.date) return {ok:false,code:'MORNING_WINDOW_ENDED',attempted,sent};
        if (unavailable) return {ok:false,code:unavailable,attempted,sent};
        const result=await this.core.notifyImageAllAllowed({
          image:plan.jobs[part].image,idempotencyKey:'group-morning-'+plan.date+'-'+part,
          groupsOnly:true,requiredFeature:MORNING_PART_FEATURES[part],groupTargets:[target],
          deliveryDeadline:plan.cutoff,
        });
        attempted+=result.attempted||0;sent+=result.sent||0;
        if (!result.attempted&&quotaWait.has(result.code)) {
          // No message was submitted. Wait for the existing quota window.
          await this.sleep(1000);
          continue;
        }
        if(result.code==='QQ_TARGET_PERMISSION_DENIED'){
          plan.permissionDenied.add(target.groupKey);
          denied=true;
          break;
        }
        if (!result.ok&&result.code!=='DUPLICATE') return {ok:false,
          code:result.code==='REQUEST_EXPIRED'?'MORNING_WINDOW_ENDED':result.code,attempted,sent};
        break;
      }
    }
    return denied?{ok:false,code:'QQ_TARGET_PERMISSION_DENIED',attempted,sent}:{ok:true,attempted,sent};
  }
}
