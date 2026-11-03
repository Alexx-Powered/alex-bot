export const GROUP_FEATURES = Object.freeze([
  {key:'chat',label:'模型聊天'},
  {key:'conversion',label:'固定换算'},
  {key:'budget',label:'生活费预算'},
  {key:'weather',label:'天气预报'},
  {key:'air',label:'空气质量'},
  {key:'radar',label:'雷达与目录'},
  {key:'campus',label:'校园与教室'},
  {key:'status',label:'AI服务状态'},
  {key:'balance',label:'DeepSeek余额'},
  {key:'images',label:'图片理解'},
  {key:'voice',label:'语音理解'},
  {key:'memory',label:'成员记忆'},
  {key:'morningReport',label:'早间日报'},
]);
const keys = GROUP_FEATURES.map(item=>item.key);
const gray = new Set(['chat','conversion','images','voice','memory']);
export const defaultGroupFeatures = access => Object.fromEntries(keys.map(key=>[key,key!=='morningReport'&&(access==='white'||gray.has(key))]));
export const basicGroupFeatures = () => Object.fromEntries(keys.map(key=>[key,['chat','conversion','budget'].includes(key)]));
export function validGroupFeatures(value) {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const legacy=keys.filter(key=>key!=='morningReport').concat('notifications');
  return [keys,legacy].some(shape=>Object.keys(value).length===shape.length&&shape.every(key=>typeof value[key]==='boolean'));
}
// Earlier broadcast consent never grants a recurring daily subscription.
export const normalizeGroupFeatures = value => Object.fromEntries(keys.map(key=>[key,key==='morningReport'?value[key]===true:value[key]]));
export function featureEnabled(context, feature) {
  if (context?.scope!=='group') return true;
  if (typeof context.allowsFeature==='function') return context.allowsFeature(feature)===true;
  return (context.features ?? defaultGroupFeatures(context.access))[feature]===true;
}
const tools = {
  weather_image:'weather',air_quality_image:'air',radar_image:'radar',radar_catalog:'radar',
  local_weather_briefing:'weather',convert_units:'conversion',convert_previous_result:'conversion',
  living_cost_budget:'budget',openai_service_status:'status',deepseek_service_status:'status',liang_status:'status',
  deepseek_account_balance:'balance',buaa_classroom_query:'campus',buaa_classroom_recommend:'campus',
};
export const toolFeature = name => tools[name];
