import {GroupMorningService,groupMorningWindow} from './group-morning.mjs';
import {morningScheduleKey} from './morning-settings.mjs';

// The existing systemd timers own the default 07:30 reports. This clock handles
// only explicitly customized weather subscriptions, using the same delivery ledger.
export class GroupWeatherScheduler {
  constructor(options,trace=(_context,work)=>work()) {
    this.options=options;
    this.now=options.now??(()=>new Date());
    this.trace=trace;
    this.jobs=new Map();
  }
  tick(){
    const now=this.now(),minute=Math.floor(Number(now)/60000);
    if(minute===this.lastMinute)return Promise.resolve([]);
    this.lastMinute=minute;
    for(const [key,job] of this.jobs)if(job.cutoff<=Number(now))this.jobs.delete(key);
    const work=[],seen=new Set();
    for(const {morningSchedule:schedule} of this.options.core.captureMorningTargets('morningWeather')){
      const key=morningScheduleKey(schedule);
      if(!key||seen.has(key))continue;
      seen.add(key);
      const clock=groupMorningWindow(now,schedule.time);
      const sending=minute===Math.floor(clock.due/60000);
      if(!sending&&minute!==Math.floor(clock.prepare/60000))continue;
      let batch=this.jobs.get(key);
      if(!batch){
        batch={service:new GroupMorningService({...this.options,schedule}),cutoff:clock.cutoff};
        this.jobs.set(key,batch);
      }
      const operation=sending?'morning.dispatch':'morning.prepare';
      work.push(this.trace({operation,date:clock.date},()=>sending?batch.service.run():batch.service.prepare()));
    }
    return Promise.allSettled(work);
  }
  start(){
    const wake=()=>{
      this.timer=setTimeout(wake,60000-(Number(this.now())%60000)).unref();
      void this.tick().catch(()=>console.error('GROUP_WEATHER_SCHEDULER_ERROR'));
    };
    wake();
  }
  close(){clearTimeout(this.timer);}
}
