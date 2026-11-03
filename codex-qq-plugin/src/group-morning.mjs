import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

export function groupMorningClock(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{
    timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  }).formatToParts(now).map(part=>[part.type,part.value]));
  const minutes=Number(parts.hour)*60+Number(parts.minute);
  return {date:parts.year+'-'+parts.month+'-'+parts.day,inWindow:minutes>=450&&minutes<465};
}

export function createGroupMorningStatus() {
  let cached={active:false,time:'07:30',timezone:'Asia/Shanghai'},expires=0;
  return async()=>{
    if (Date.now()<expires) return cached;
    expires=Date.now()+30_000;
    try {
      const result=await promisify(execFile)('/bin/systemctl',['show','alexbot-group-morning.timer','--property=ActiveState','--value'],{timeout:1500,windowsHide:true});
      cached={...cached,active:result.stdout.trim()==='active'};
    } catch {cached={...cached,active:false};}
    return cached;
  };
}

/** Fixed daily orchestration. Recipients and delivery keys remain core-owned. */
export class GroupMorningService {
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

  async run() {
    const clock=groupMorningClock(this.now());
    const stop=code=>({ok:false,code,attempted:0,sent:0});
    if (!clock.inWindow) return stop('MORNING_NOT_DUE');
    const unavailable=this.ready();
    if (unavailable) return stop(unavailable);
    const targets=this.core.captureMorningTargets();
    if (!targets.length) return stop('NO_MORNING_GROUPS');
    const pending=this.core.pendingMorningParts(clock.date,targets);
    if (!pending.weather&&!pending.campus) return stop('DUPLICATE');
    const images={};
    try {
      if (pending.weather) {
        const report=await this.morning.create();
        if (report.date!==clock.date||!report.image) return stop('MORNING_REPORT_INVALID');
        images.weather=report.image;
      }
      const unavailable=this.ready();
      if (unavailable) return stop(unavailable);
      if (pending.campus&&this.core.pendingMorningParts(clock.date,targets).campus) {
        const report=await this.campus.run({date:clock.date},'report');
        if (!report.image) return stop('CAMPUS_IMAGE_MISSING');
        images.campus=report.image;
      }
    } catch {return stop('MORNING_REPORT_FAILED');}
    let attempted=0,sent=0;
    for (const target of targets) for (const part of ['weather','campus']) {
      if (!images[part]) continue;
      while (this.core.pendingMorningParts(clock.date,[target])[part]) {
        const current=groupMorningClock(this.now()),unavailable=this.ready();
        if (!current.inWindow||current.date!==clock.date) return {ok:false,code:'MORNING_WINDOW_ENDED',attempted,sent};
        if (unavailable) return {ok:false,code:unavailable,attempted,sent};
        const result=await this.core.notifyImageAllAllowed({
          image:images[part],idempotencyKey:'group-morning-'+clock.date+'-'+part,
          groupsOnly:true,requiredFeature:'morningReport',groupTargets:[target],
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
    return {ok:true,code:'SENT',attempted,sent};
  }
}
