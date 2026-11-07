import {createHash} from 'node:crypto';

// Fixed public acceptance samples; this route cannot send QQ, choose URLs,
// access a private namespace or start a second Python/Milvus owner.
export const researchSamples=Object.freeze({
  moganshan:'莫干山国家登山健身步道',dongqianhu:'东钱湖环湖步道',
  xianhu:'仙湖植物园环湖步道',fudao:'福州福道',haba:'哈巴西坡',
});
const SESSION=createHash('sha256').update('alexbot:admin:research-check:v1').digest('hex');
const STATES=new Set(['queued','running','completed','empty','failed','timeout','cancelled','busy',
  'denied','invalid','unavailable','cached','evidence','full','rate_limited']);
export class ResearchHealthCheck {
  #busy=false;
  constructor({worker,enabled=false,configStore=null}){Object.assign(this,{worker,enabled,configStore});}
  async run(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['sample','mode'].includes(k))||
       !Object.hasOwn(researchSamples,input.sample)||!['tool','natural'].includes(input.mode??'tool'))return {statusCode:400,body:{ok:false,code:'INVALID_INPUT'}};
    if(!this.enabled)return {statusCode:503,body:{ok:false,code:'RESEARCH_DISABLED'}};
    if(this.#busy)return {statusCode:409,body:{ok:false,code:'RESEARCH_CHECK_BUSY'}};
    this.#busy=true;
    const started=performance.now(),topic=researchSamples[input.sample];
    try{
      let payload={type:'rag',name:'request_outdoor_research',args:{topic},
        text:`${topic}的徒步路线资料`,sessionKey:SESSION,context:{scope:'c2c'}};
      if(input.mode==='natural'){
        const config=await this.configStore?.read();
        if(!config?.enabled||!config.apiKey)throw Error('UNAVAILABLE');
        payload={type:'request',text:`${topic}适合徒步吗？有哪些路线资料？`,sessionKey:SESSION,context:{scope:'c2c'},
          config,policy:{enabled:false,topics:[],instructions:'',maxChars:600},now:new Date().toISOString()};
      }
      const result=await this.worker.run(payload,
        async()=>{throw Error('RESEARCH_CHECK_RPC_DENIED');},value=>value);
      if(result?.kind!=='rag'||result.requiredFeature!=='weather'||!STATES.has(result.status)||
         typeof result.text!=='string'||!result.text.trim()||result.text.length>1600||
         /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.text))throw Error('INVALID_RESULT');
      return {statusCode:200,body:{ok:true,sample:input.sample,topic,status:result.status,text:result.text,
        elapsedMs:Math.round(performance.now()-started),mode:input.mode??'tool',qqSent:false}};
    }catch{return {statusCode:503,body:{ok:false,code:'RESEARCH_CHECK_FAILED',elapsedMs:Math.round(performance.now()-started)}};}
    finally{this.#busy=false;}
  }
}
