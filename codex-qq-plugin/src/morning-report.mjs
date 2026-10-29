import {morningPlan} from './morning-calendar.mjs';
import {renderMorningChart} from './morning-chart.mjs';
export class MorningReportService{
  constructor({commands,worker,now=Date.now,chart=renderMorningChart}){Object.assign(this,{commands,worker,now,chart});}
  plan(){return morningPlan(this.now());}
  async create(){
    const now=this.now(),plan=morningPlan(now);
    const brief=await this.commands.briefing({cities:[plan.city],renderImage:false,includeData:true});
    if(brief.date!==plan.date||brief.cities[0]!==plan.city)throw new Error('MORNING_DATE_CITY_CHANGED');
    const input=brief.inputs;
    const data={now:new Date(now).toISOString(),...plan,weather:input.weather[0],air:input.air};
    let analysis;
    try{
      analysis=await this.worker.run({type:'morning',data},async()=>{throw new Error('MORNING_RPC_DENIED');},r=>{
        if(r.kind!=='analysis'||!r.report||r.report.date!==plan.date||r.report.city!==plan.city||!Array.isArray(r.report.windows)||r.report.windows.length>3)throw new Error('MORNING_ANALYSIS_INVALID');
        return r.report;
      });
    }catch{analysis={date:plan.date,city:plan.city,title:'运动建议暂不可用',summary:'分析服务未完成，暂不推荐户外运动时段。',windows:[],recommendation:null,notes:['天气图继续展示；运动分析缺失，不表示适宜。']};}
    return {ok:true,date:plan.date,cities:[plan.city],text:`${plan.cityName}早安日报：今日天气与运动建议。`,image:await this.chart({inputs:input,analysis,plan}),analysis,plan};
  }
}
