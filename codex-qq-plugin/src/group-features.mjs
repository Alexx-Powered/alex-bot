import {WEATHER_TOOLS} from './weather-catalog.mjs';

export const MORNING_PART_FEATURES = Object.freeze({weather:'morningWeather',campus:'morningCampus'});
export const MORNING_MAX_RETRIES = 3;
export const MORNING_FEATURE_KEYS = Object.freeze(Object.values(MORNING_PART_FEATURES));
export const isMorningFeature = key => MORNING_FEATURE_KEYS.includes(key);
export const HELP_NOTE_LIMITS = Object.freeze({maxLength:240,maxLines:6});
export const DEFAULT_CHAT_OFF_HELP_NOTE = '为避免打扰,本群仅启用自然语言理解,chat未启用';

export function normalizeGroupHelpNote(value) {
  if (typeof value!=='string') return null;
  const note=value.replace(/\r\n?/g,'\n').trim();
  return note.length<=HELP_NOTE_LIMITS.maxLength && note.split('\n').length<=HELP_NOTE_LIMITS.maxLines &&
    !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Cs}]/u.test(note)?note:null;
}

export const GROUP_FEATURES = Object.freeze([
  {key:'chat',label:'模型聊天'},
  {key:'conversion',label:'固定换算'},
  {key:'budget',hidden:true},
  {key:'weather',label:'天气预报'},
  {key:'air',label:'空气质量'},
  {key:'radar',label:'雷达与目录'},
  {key:'campus',label:'校园与教室'},
  {key:'status',label:'AI服务状态'},
  {key:'balance',label:'DeepSeek余额'},
  {key:'images',label:'图片理解'},
  {key:'voice',label:'语音理解'},
  {key:'memory',label:'成员记忆'},
  {key:'morningWeather',label:'早间天气'},
  {key:'morningCampus',label:'三号楼自习简报'},
]);
const keys = GROUP_FEATURES.map(item=>item.key);
const gray = new Set(['chat','conversion','images','voice','memory']);
export const defaultGroupFeatures = access => Object.fromEntries(keys.map(key=>[key,!isMorningFeature(key)&&(access==='white'||gray.has(key))]));
export const basicGroupFeatures = () => Object.fromEntries(keys.map(key=>[key,['chat','conversion','budget'].includes(key)]));
export function validGroupFeatures(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const ordinary=keys.filter(key=>!isMorningFeature(key));
  return [keys,ordinary.concat('morningReport'),ordinary.concat('notifications')]
    .some(shape=>Object.keys(value).length===shape.length&&shape.every(key=>typeof value[key]==='boolean'));
}
// Earlier broadcast consent never grants a recurring daily subscription.
// The former combined daily switch represented consent to both existing parts.
export const normalizeGroupFeatures = value => Object.fromEntries(keys.map(key=>[key,
  isMorningFeature(key)?(Object.hasOwn(value,key)?value[key]===true:value.morningReport===true):value[key]]));
export function featureEnabled(context, feature) {
  if (context?.scope!=='group') return true;
  if (typeof context.allowsFeature==='function') return context.allowsFeature(feature)===true;
  return (context.features ?? defaultGroupFeatures(context.access))[feature]===true;
}
const tools = {
  ...Object.fromEntries(WEATHER_TOOLS.map(({tool,feature})=>[tool,feature])),
  satellite_video:'weather',local_weather_briefing:'weather',convert_units:'conversion',convert_previous_result:'conversion',
  living_cost_budget:'budget',openai_service_status:'status',deepseek_service_status:'status',ai_service_status:'status',liang_status:'status',
  deepseek_account_balance:'balance',buaa_classroom_query:'campus',buaa_classroom_recommend:'campus',
};
export const toolFeature = name => tools[name];
