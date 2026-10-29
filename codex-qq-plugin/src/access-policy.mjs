// Tier metadata comes only from BridgeCore's persisted group membership.
// It is never inferred from user text or a model-supplied argument.
export const isGray=context=>context?.scope==='group'&&context.access==='gray';
export function fullAccess(context){
  const granted=context?.scope==='c2c'||(context?.scope==='group'&&context.access==='white');
  return granted&&(typeof context.authorize!=='function'||context.authorize('white')===true);
}
export function basicAccess(context){
  return typeof context?.authorize!=='function'||context.authorize('chat')===true;
}
export const RESTRICTED_REPLY='当前群为灰名单，仅开放基础聊天和换算，未开放这项查询。';
