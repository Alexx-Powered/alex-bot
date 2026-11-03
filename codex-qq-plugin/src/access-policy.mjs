// Tier metadata comes only from BridgeCore's persisted group membership.
// It is never inferred from user text or a model-supplied argument.
import {featureEnabled} from './group-features.mjs';
export const isGray=context=>context?.scope==='group'&&context.access==='gray'&&!context.features;
export function fullAccess(context,feature){
  const granted=context?.scope==='c2c'||(context?.scope==='group'&&(feature?featureEnabled(context,feature):context.access==='white'));
  return granted&&(typeof context.authorize!=='function'||context.authorize('white',feature)===true);
}
export function basicAccess(context){
  return typeof context?.authorize!=='function'||context.authorize('chat')===true;
}
export const RESTRICTED_REPLY='当前群为灰名单，仅开放基础聊天和换算，未开放这项查询。';
export const restrictedReply=context=>context?.features?'本群未开放这项功能，请联系主人在控制台调整。':RESTRICTED_REPLY;
