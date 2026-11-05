import {recordRequestFailure} from './telemetry.mjs';
// Only normalisation/routing lives in Node; LangChain/Python owns the arithmetic.
const aliases={
  '古月币':'HU$','hu$':'HU$','人民币':'CNY','元':'CNY','cny':'CNY','rmb':'CNY','¥':'CNY','￥':'CNY',
  '马里':'马里','公里':'km','千米':'km','km':'km','米':'m','m':'m',
  '马时':'马时','小时':'h','h':'h','分钟':'min','分':'min','min':'min',
};
const opposite={'HU$':'CNY','CNY':'HU$','马里':'km','km':'马里','m':'马里','马时':'h','h':'马时','min':'马时'};
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const unit=Object.keys(aliases).sort((a,b)=>b.length-a.length).map(escape).join('|');
const amount='(?:[0-9]{1,12}(?:\\.[0-9]{1,8})?|\\.[0-9]{1,8})';
const join='(?:等于|兑换成|换算成|是多少|换成|折合|转成|兑换|换算|多少|为|是|有|换|到|[=＝]|->|→)\\s*(?:多少|几|成|为)?';
const forms=[
  new RegExp(`^(?:(?:换算|兑换|折合|转换)\\s*)?(${amount})\\s*(${unit})\\s*${join}\\s*(${unit})[？?。]?$`,'iu'),
  new RegExp(`^换算\\s+(${amount})\\s*(${unit})\\s+(${unit})[？?。]?$`,'iu'),
  new RegExp(`^(?:换算\\s*)?(${amount})\\s*(${unit})[？?。]?$`,'iu'),
];
const prefixMoney=new RegExp(`^(HU\\$|CNY|RMB|[¥￥])\\s*(${amount})(?:\\s*${join}\\s*(${unit}))?[？?。]?$`,'iu');
const canonical=value=>aliases[value.toLowerCase()];
export const CONVERSION_HELP='请按同类单位换算，例如：换算 0.6 HU$ 人民币；1马里换公里；1马时换小时。';

// Carry only core-owned scope data; fixed tools never need the shared transcript.
// Omission preserves the legacy model-free execution packet.
export function fixedToolContext(context){
  if(!context||typeof context.sessionKey!=='string'||!/^[a-f0-9]{64}$/.test(context.sessionKey))return {};
  const scope=context.scope;
  if(scope!=='c2c'&&!(scope==='group'&&['white','gray'].includes(context.access)))return {};
  return {sessionKey:context.sessionKey,context:{scope,...(scope==='group'?{access:context.features?'white':context.access,...(context.features?{features:context.features,policyRevision:context.policyRevision||0}:{})}:{})},now:new Date().toISOString()};
}

export function parseConversionCommand(text){
  if(typeof text!=='string'||text.length>120)return null;
  const input=text.trim();let found;
  for(const form of forms){const match=form.exec(input);if(match){found=[match[1],match[2],match[3]];break;}}
  if(!found){const match=prefixMoney.exec(input);if(match)found=[match[2],match[1],match[3]];}
  if(!found)return null;
  const from=canonical(found[1]),to=found[2]?canonical(found[2]):opposite[from];
  return {amount:found[0].startsWith('.')?'0'+found[0]:found[0],from_unit:from,to_unit:to};
}

const resultPattern=/^[0-9]{1,12}(?:\.[0-9]{1,8})? (?:HU\$|元|马里|km|m|马时|小时|分钟) [=≈] [0-9]{1,16}(?:\.[0-9]{1,6})? (?:HU\$|元|马里|km|m|马时|小时|分钟)$/u;
export function conversionReply(result){
  if(result?.kind==='clarify'&&result.reason==='conversion_input')return {text:CONVERSION_HELP};
  if(result?.kind!=='conversion'||typeof result.text!=='string'||result.text.length>80||!resultPattern.test(result.text))return null;
  return {text:result.text};
}

export class ConversionToolbox{
  constructor(worker){this.worker=worker;}
  async handle(text,context){
    const args=parseConversionCommand(text);if(!args)return null;
    try{
      return await this.worker.run({type:'execute',name:'convert_units',args,...fixedToolContext(context)},async()=>{throw Error('CONVERSION_RPC_DENIED');},conversionReply);
    }catch(error){recordRequestFailure(error,'worker_total');return {text:'换算工具暂时不可用，请稍后再试。'};}
  }
}
