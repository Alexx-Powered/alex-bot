import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MORNING_PART_FEATURES} from './group-features.mjs';

export function groupMorningClock(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  }).formatToParts(now).map(part=>[part.type,part.value]));
  const minutes=Number(parts.hour)*60+Number(parts.minute);
  return {date:parts.year+'-'+parts.month+'-'+parts.day,inWindow:minutes>=450&&minutes<465,
    canPrepare:minutes>=448&&minutes<465};
}

export function createGroupMorningStatus() {
  let cached={active:false,prepareActive:false,prepareTime:'07:28',time:'07:30',timezone:'Asia/Shanghai'},expires=0;
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
  constructor({core,adapter,morning,campus,now=()=>new Date(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
    Object.assign(this,{core,adapter,morning,campus,now,sleep});
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

  // Only the current day's two images are retained. No QQ delivery occurs here.
  // A restart drops the cache; the 07:30 entry can generate missing work once.
  #start(clock) {
    if(this.#plan?.date===clock.date)return this.#plan;
    const targets=this.core.captureMorningTargets();
    const plan={date:clock.date,targets,jobs:{}};
    this.#plan=plan;
    for(const part of ['weather','campus']) {
      if(!this.core.pendingMorningParts(clock.date,targets)[part])continue;
      const job={state:'preparing',code:null};plan.jobs[part]=job;
      job.promise=Promise.resolve().then(async()=>{
        await this.core.waitForPendingOperations();
        const authorized=()=>this.#plan===plan&&!this.ready()&&
          groupMorningClock(this.now()).date===plan.date&&groupMorningClock(this.now()).canPrepare&&
          this.core.hasMorningPreparationTarget(plan.date,targets,part);
        if(!authorized()){job.state='cancelled';job.code='MORNING_CANCELLED';return;}
        try {
          const report=part==='weather'?await this.morning.create({scheduledMorning:true}):
            await this.campus.run({date:plan.date},'report',{scheduledMorning:true,authorize:authorized});
          await this.core.waitForPendingOperations();
          if(!authorized()){job.state='cancelled';job.code='MORNING_CANCELLED';return;}
          if(!report.image||report.ok===false||(part==='weather'&&report.date!==plan.date)||
            (part==='campus'&&report.data&&(report.data.ok!==true||report.data.date!==plan.date))) {
            job.state='failed';job.code=report.code==='MORNING_DATA_INCOMPLETE'?report.code:
              part==='weather'?'MORNING_REPORT_INVALID':'CAMPUS_IMAGE_MISSING';return;
          }
          job.image=report.image;job.state='ready';
        } catch(error) {job.state='failed';job.code=part==='weather'&&error?.code==='MORNING_DATA_INCOMPLETE'?
          error.code:part==='weather'?'MORNING_REPORT_FAILED':'CAMPUS_REPORT_FAILED';}
      });
    }
    return plan;
  }

  async prepare() {
    await this.core.waitForPendingOperations();
    const clock=groupMorningClock(this.now());
    const stop=code=>({ok:false,code,attempted:0,sent:0});
    if(!clock.canPrepare)return stop('MORNING_NOT_DUE');
    const unavailable=this.ready();if(unavailable)return stop(unavailable);
    if(!this.core.captureMorningTargets().length)return stop('NO_MORNING_GROUPS');
    const plan=this.#start(clock);
    await Promise.all(Object.values(plan.jobs).map(job=>job.promise));
    const failedParts=Object.entries(plan.jobs).filter(([,job])=>job.state==='failed').map(([part,job])=>({part,code:job.code}));
    return {ok:!failedParts.length,code:failedParts[0]?.code??'MORNING_PREPARED',attempted:0,sent:0,
      prepared:Object.values(plan.jobs).filter(job=>job.state==='ready').length,...(failedParts.length?{failedParts}:{})};
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
    const plan=this.#start(clock),failedParts=[];
    const remaining=new Set(Object.keys(plan.jobs));
    let attempted=0,sent=0;
    // A ready weather image can leave at 07:30 while campus is still collecting,
    // and vice versa. Generation and sending are single-flight per day/entry.
    while(remaining.size) {
      const part=await Promise.race([...remaining].map(part=>plan.jobs[part].promise.then(()=>part)));
      remaining.delete(part);const job=plan.jobs[part];
      if(job.state==='failed'){failedParts.push({part,code:job.code});continue;}
      if(job.state!=='ready')continue;
      for (const target of plan.targets) {
      await this.core.waitForPendingOperations();
      while (this.core.pendingMorningParts(clock.date,[target])[part]) {
        const current=groupMorningClock(this.now()),unavailable=this.ready();
        if (!current.inWindow||current.date!==clock.date) return {ok:false,code:'MORNING_WINDOW_ENDED',attempted,sent};
        if (unavailable) return {ok:false,code:unavailable,attempted,sent};
        const result=await this.core.notifyImageAllAllowed({
          image:job.image,idempotencyKey:'group-morning-'+clock.date+'-'+part,
          groupsOnly:true,requiredFeature:MORNING_PART_FEATURES[part],groupTargets:[target],
          deliveryDeadline:Date.parse(clock.date+'T07:45:00+08:00'),
        });
        attempted+=result.attempted||0;sent+=result.sent||0;
        if (!result.attempted&&['RATE_LIMIT_MINUTE','RATE_LIMIT_TARGET'].includes(result.code)) {
          // No message was submitted. Wait for the existing quota window.
          await this.sleep(1000);
          continue;
        }
        if (!result.ok&&result.code!=='DUPLICATE') return {ok:false,code:result.code,attempted,sent};
        break;
      }
      }
    }
    const end=groupMorningClock(this.now());
    if(!end.inWindow||end.date!==clock.date)return {ok:false,code:'MORNING_WINDOW_ENDED',attempted,sent};
    if(!sent&&!attempted&&!failedParts.length)return {ok:false,code:'MORNING_CANCELLED',attempted,sent};
    return failedParts.length?{ok:false,code:failedParts[0].code,attempted,sent,failedParts}:{ok:true,code:'SENT',attempted,sent};
  }
}
