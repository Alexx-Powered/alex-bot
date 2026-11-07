import {createHash} from 'node:crypto';
import {renderHikingCard} from './hiking-card-image.mjs';
const SESSION=createHash('sha256').update('alexbot:admin:hiking-check:v1').digest('hex');
const SAMPLES=Object.freeze({dangling:'党岭',wugong:'武功山',kula:'库拉岗日',haba:'哈巴西坡'});
export class HikingHealthCheck{
  #busy=false;
  constructor({worker,enabled,configStore}){Object.assign(this,{worker,enabled,configStore});}
  async run(input){
    if(!input||Object.keys(input).some(k=>!['sample','mode'].includes(k))||!Object.hasOwn(SAMPLES,input.sample)||!['tool','natural'].includes(input.mode??'tool'))return {statusCode:400,body:{ok:false,code:'INVALID_INPUT'}};
    if(!this.enabled)return {statusCode:503,body:{ok:false,code:'RAG_DISABLED'}};
    if(this.#busy)return {statusCode:409,body:{ok:false,code:'HIKING_CHECK_BUSY'}};
    this.#busy=true;const tick=performance.now();
    try{
      const topic=SAMPLES[input.sample],text=`${topic}徒步的天气和睡袋建议，有不露营的方案吗？`;
      let packet={type:'rag',name:'hiking_trip_card',args:{destination:topic},text,sessionKey:SESSION,context:{scope:'c2c'}};
      if(input.mode==='natural')packet={type:'request',text,sessionKey:SESSION,context:{scope:'c2c'},config:await this.configStore.read(),policy:{enabled:false,topics:[],instructions:'',maxChars:600},now:new Date().toISOString()};
      const result=await this.worker.run(packet,async()=>{throw Error('HIKING_CHECK_RPC_DENIED');},v=>v);
      if(!result.hikingCard)throw Error('HIKING_CHECK_NO_CARD');
      const image=await renderHikingCard(result.hikingCard);
      return {statusCode:200,body:{ok:true,card:result.hikingCard,image:image.toString('base64'),mimeType:'image/png',elapsedMs:Math.round(performance.now()-tick),qqSent:false}};
    }catch{return {statusCode:503,body:{ok:false,code:'HIKING_CHECK_FAILED',elapsedMs:Math.round(performance.now()-tick)}};}
    finally{this.#busy=false;}
  }
}
export async function indexWhenIdle(worker){
  if(worker.busy!==false)return {status:'busy'};
  try{
    const result=await worker.run({type:'rag_index'},async()=>{throw Error('RAG_INDEX_RPC_DENIED');},r=>r.data);
    return {status:result?.error_code?'unavailable':'ok',processed:result?.processed??0,failed:result?.failed??0};
  }catch{return {status:'unavailable',processed:0,failed:1};}
}
