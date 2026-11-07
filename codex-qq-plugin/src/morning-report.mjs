import {morningPlan} from './morning-calendar.mjs';
import {renderMorningChart} from './morning-chart.mjs';
import {withHeavyWork} from './heavy-work.mjs';
import {ScheduledMorningWeather} from './morning-weather.mjs';
export class MorningReportService{
  constructor({commands,scheduledCommands,worker,now=Date.now,chart=renderMorningChart}){Object.assign(this,{commands,worker,now,chart});this.scheduledCommands=scheduledCommands??new ScheduledMorningWeather(commands);}
  plan(){return morningPlan(this.now());}
  async create({scheduledMorning=false}={}){
    const now=this.now(),plan=morningPlan(now);
    const brief=await (scheduledMorning===true?this.scheduledCommands:this.commands).briefing({cities:[plan.city],renderImage:false,includeData:true});
    if(brief.date!==plan.date||brief.cities[0]!==plan.city)throw new Error('MORNING_DATE_CITY_CHANGED');
    if(scheduledMorning===true&&brief.morningQuality?.complete!==true)throw Object.assign(new Error('MORNING_DATA_INCOMPLETE'),{code:'MORNING_DATA_INCOMPLETE',morningQuality:brief.morningQuality??{complete:false,missing:['weather','air'],retried:[]}});
    const input=brief.inputs;
    const data={now:new Date(now).toISOString(),...plan,weather:input.weather[0],air:input.air};
    let analysis;
    if(input.outdoorIndex&&!input.weather.some(item=>item?.simulated===true)){
      analysis={date:plan.date,city:plan.city,windows:[],outdoorIndex:input.outdoorIndex,
        title:'户外指数',summary:'上午、下午分别评分，采用较高分。',recommendation:null,notes:[]};
    }else try{
      analysis=await this.worker.run({type:'morning',data},async()=>{throw new Error('MORNING_RPC_DENIED');},r=>{
        if(r.kind!=='analysis'||!r.report||r.report.date!==plan.date||r.report.city!==plan.city||!Array.isArray(r.report.windows)||r.report.windows.length>3)throw new Error('MORNING_ANALYSIS_INVALID');
        return r.report;
      });
    }catch{analysis={date:plan.date,city:plan.city,title:'运动建议暂不可用',summary:'分析服务未完成，暂不推荐户外运动时段。',windows:[],recommendation:null,notes:['运动分析暂不可用']};}
    const image=await withHeavyWork(()=>this.chart({inputs:input,analysis,plan}));
    return {ok:true,date:plan.date,cities:[plan.city],text:`${plan.cityName}早安日报：今日天气与户外指数。`,image,analysis,plan,...(brief.morningQuality?{morningQuality:brief.morningQuality}:{})};
  }
}
