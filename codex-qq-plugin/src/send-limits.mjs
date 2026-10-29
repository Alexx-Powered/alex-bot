import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CORE_LIMITS} from './core.mjs';
const keys=['dailyAttempts','minuteAttempts','reservedNotifications'];
export function parseSendLimits(value){
  const valid=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));
  if(!valid||!Number.isInteger(value.dailyAttempts)||value.dailyAttempts<10||value.dailyAttempts>1000||!Number.isInteger(value.minuteAttempts)||value.minuteAttempts<1||value.minuteAttempts>30||!Number.isInteger(value.reservedNotifications)||value.reservedNotifications<0||value.reservedNotifications>Math.min(value.dailyAttempts-1,100))throw new Error('SEND_LIMITS_CONFIG_INVALID');
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,value[k]])));
}
export async function loadSendLimits(home){
  let text;
  try{text=await readFile(join(home,'config','send-limits.json'),'utf8');}catch(error){if(error.code==='ENOENT')return parseSendLimits(Object.fromEntries(keys.map(k=>[k,CORE_LIMITS[k]])));throw new Error('SEND_LIMITS_CONFIG_INVALID');}
  try{if(Buffer.byteLength(text)>2048)throw Error();return parseSendLimits(JSON.parse(text.replace(/^\uFEFF/,'')));}catch{throw new Error('SEND_LIMITS_CONFIG_INVALID');}
}
