import {createHash, randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {imageBase64, QQAdapterError} from './qq-adapter.mjs';
import {incomingMedia} from './incoming-media.mjs';

export const ONEBOT_ENDPOINT = 'ws://127.0.0.1:19328/';
const accountNumber = /^[1-9]\d{4,11}$/;
const replyWindow = 5 * 60_000;
const knownModes = new Set(['receive-only', 'limited', 'normal']);

export function validateOneBotProfile(profile) {
  if (!profile || typeof profile.selfId !== 'string' || !accountNumber.test(profile.selfId) ||
      typeof profile.token !== 'string' || !/^[a-f0-9]{64}$/.test(profile.token) ||
      !knownModes.has(profile.mode) || Object.keys(profile).some(k => !['selfId','token','mode'].includes(k))) {
    throw Error('ONEBOT_PROFILE_INVALID');
  }
  return Object.freeze({...profile});
}

function wireId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  return /^-?[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

function scopeId(selfId, kind, value) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && accountNumber.test(String(value))
    ? ['qq', selfId, kind, value].join('_') : null;
}

function normalize(event, selfId, now) {
  if (event.post_type !== 'message' || String(event.self_id) !== selfId ||
      String(event.user_id) === selfId || !Array.isArray(event.message) || event.message.length > 64 ||
      !Number.isSafeInteger(event.time) || event.time * 1000 > now + 30_000 || now - event.time * 1000 >= replyWindow) return null;
  const group = event.message_type === 'group' && event.sub_type === 'normal';
  if (!group && !(event.message_type === 'private' && event.sub_type === 'friend')) return null;
  const scope = group ? 'group' : 'c2c';
  const senderId = scopeId(selfId, 'u', event.user_id);
  const targetId = group ? scopeId(selfId, 'g', event.group_id) : senderId;
  const id = wireId(event.message_id);
  if (!senderId || !targetId || !id) return null;
  let text = '', mentioned = false;
  const attachments = [];
  for (const segment of event.message) {
    const data = segment?.data;
    if (!data || typeof data !== 'object') return null;
    if (segment.type === 'text' && typeof data.text === 'string') text += data.text;
    else if (segment.type === 'at') {
      if (group && String(data.qq) === selfId) mentioned = true;
      else text += ' @成员 ';
    } else if (segment.type === 'image' || segment.type === 'record') {
      attachments.push({content_type: segment.type === 'image' ? 'image' : 'audio', url: data.url});
      if (!data.url) text += segment.type === 'image' ? '[图片无法读取]' : '[语音无可用转写或音频]';
    }
    if (text.length > 1500) return null;
  }
  const media = incomingMedia(attachments);
  text = text.trim() || (media.length ? (media[0].kind === 'audio' ? '[语音]' : '[图片]') : '');
  if (!text) return null;
  return {kind:scope, senderId, id, text, ...(group ? {groupId:targetId} : {}),
    ...(mentioned ? {mentioned:true} : {}), ...(media.length ? {media} : {}), replyTarget:{scope,targetId,msgId:id}};
}

const eventKey = ({scope,targetId,msgId}) => [scope,targetId,msgId].join('/');
const cancelled = () => new QQAdapterError('QQ_SEND_CANCELLED', {messageAttempted:false});
const unknown = () => new QQAdapterError('ONEBOT_DELIVERY_UNKNOWN', {messageAttempted:true});

export class OneBotAdapter {
  #socket = null;
  #pending = new Map();
  #observed = new Map();
  #status = {state:'disconnected',code:null};
  #profile;
  #heartbeat;
  #accepted = 0;
  constructor({onMessage = () => {}, onStatus = () => {}, canSend = () => false,
    admit = () => true, now = Date.now, timeoutMs = 10000, endpoint = ONEBOT_ENDPOINT} = {}) {
    if (!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(endpoint)) throw Error('ONEBOT_LOOPBACK_REQUIRED');
    Object.assign(this,{onMessage,onStatus,canSend,admit,now,timeoutMs,endpoint});
  }
  status() { return {...this.#status,protocol:'onebot11',mode:this.#profile?.mode ?? 'receive-only'}; }
  diagnostics() { return {accepted:this.#accepted}; }
  #publish(state,code = null) {
    this.#status = {state,code};
    try { Promise.resolve(this.onStatus(this.status())).catch(() => {}); } catch {}
  }
  #drop(state,code) {
    const socket = this.#socket;
    this.#socket = null;
    clearTimeout(this.#heartbeat);
    this.#observed.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(pending.delivery ? unknown() : Error('ONEBOT_DISCONNECTED'));
    }
    this.#pending.clear();
    socket?.terminate();
    this.#publish(state,code);
  }
  #watchHeartbeat() {
    clearTimeout(this.#heartbeat);
    this.#heartbeat = setTimeout(() => this.#drop('blocked','ONEBOT_HEARTBEAT_LOST'), 75_000);
    this.#heartbeat.unref();
  }
  #call(action,params,delivery = false) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.#pending.size >= 4) throw cancelled();
    const echo = randomUUID();
    return new Promise((resolve,reject) => {
      const fail = () => {
        if (!this.#pending.delete(echo)) return;
        clearTimeout(timer);
        reject(delivery ? unknown() : Error('ONEBOT_RPC_FAILED'));
      };
      const timer = setTimeout(fail,this.timeoutMs);
      this.#pending.set(echo,{resolve,reject,timer,delivery});
      try { socket.send(JSON.stringify({action,params,echo}), error => { if (error) fail(); }); }
      catch { fail(); }
    });
  }
  #receive(raw,isBinary) {
    if (isBinary) return;
    let packet;
    try { packet = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!packet || typeof packet !== 'object') return;
    if (typeof packet.echo === 'string' && !packet.post_type) {
      const pending = this.#pending.get(packet.echo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(packet.echo);
      if (packet.status === 'ok' && packet.retcode === 0) pending.resolve(packet.data);
      else pending.reject(pending.delivery ? unknown() : Error('ONEBOT_RPC_FAILED'));
      return;
    }
    if (this.#status.state !== 'connected') return;
    if (String(packet.self_id) !== this.#profile.selfId) {
      if (packet.post_type && packet.self_id != null) this.#drop('blocked','ONEBOT_ACCOUNT_MISMATCH');
      return;
    }
    if (packet.post_type === 'meta_event' && packet.meta_event_type === 'heartbeat') {
      if (packet.status?.online !== true || packet.status?.good !== true) this.#drop('blocked','ONEBOT_OFFLINE');
      else this.#watchHeartbeat();
      return;
    }
    if (packet.post_type === 'notice' && packet.notice_type === 'bot_offline') {
      this.#drop('blocked','ONEBOT_OFFLINE');
      return;
    }
    const now = this.now();
    const event = normalize(packet,this.#profile.selfId,now);
    if (!event || !this.admit(event)) return;
    for (const [key,observed] of this.#observed) if (observed.until <= now) this.#observed.delete(key);
    const key = eventKey(event.replyTarget);
    if (this.#observed.has(key)) return;
    if (this.#observed.size >= 512) this.#observed.delete(this.#observed.keys().next().value);
    this.#observed.set(key,{until:Math.min(now,packet.time*1000)+replyWindow,sender:event.senderId});
    this.#accepted++;
    try { Promise.resolve(this.onMessage(event)).catch(() => {}); } catch {}
  }
  async connect(settings) {
    const profile = validateOneBotProfile(settings);
    this.#drop('disconnected',null);
    this.#profile = profile;
    this.#publish('connecting');
    const socket = new WebSocket(this.endpoint, {headers:{Authorization:'Bearer '+profile.token},maxPayload:256*1024,
      perMessageDeflate:false,followRedirects:false,handshakeTimeout:this.timeoutMs});
    this.#socket = socket;
    socket.on('message',(data,binary) => { if (this.#socket === socket) this.#receive(data,binary); });
    const lost = () => { if (this.#socket === socket) this.#drop('blocked','ONEBOT_DISCONNECTED'); };
    socket.on('error',lost);
    socket.on('close',lost);
    try {
      await new Promise((resolve,reject) => {
        socket.once('open',resolve);
        socket.once('error',reject);
        socket.once('close',() => reject(Error('ONEBOT_DISCONNECTED')));
      });
      if (this.#socket !== socket) throw Error('ONEBOT_DISCONNECTED');
      const login = await this.#call('get_login_info',{});
      if (String(login?.user_id) !== profile.selfId) throw Error('ONEBOT_ACCOUNT_MISMATCH');
      const status = await this.#call('get_status',{});
      if (status?.online !== true || status?.good !== true) throw Error('ONEBOT_OFFLINE');
      if (this.#socket !== socket) throw Error('ONEBOT_DISCONNECTED');
      this.#watchHeartbeat();
      this.#publish('connected');
      return this.status();
    } catch (error) {
      const code = ['ONEBOT_ACCOUNT_MISMATCH','ONEBOT_OFFLINE'].includes(error?.message) ? error.message : 'ONEBOT_HANDSHAKE_FAILED';
      if (this.#socket === socket) this.#drop('blocked',code);
      throw Error(code);
    }
  }
  async disconnect() { this.#drop('disconnected',null); return this.status(); }
  async send({ownerId,groupId,text,image,replyTarget,proactiveGroup = false,requiredAccess = 'chat',richMedia = false} = {}) {
    if (this.#status.state !== 'connected' || this.#profile.mode === 'receive-only') throw cancelled();
    const prefix = 'qq_'+this.#profile.selfId+'_';
    const group = groupId !== undefined;
    const target = group ? groupId : ownerId;
    const numeric = (id,kind) => typeof id === 'string' && id.startsWith(prefix+kind+'_') &&
      accountNumber.test(id.slice(prefix.length+2)) ? id.slice(prefix.length+2) : null;
    const number = numeric(target,group ? 'g' : 'u');
    if (!number || !numeric(ownerId,'u') || (group && !replyTarget && !proactiveGroup) || (proactiveGroup && !group)) throw cancelled();
    if (replyTarget && (replyTarget.scope !== (group ? 'group' : 'c2c') || replyTarget.targetId !== target ||
        !(this.#observed.get(eventKey(replyTarget))?.until > this.now()))) throw cancelled();
    if (typeof text !== 'string' || text.length > 1500 || (!text.trim() && !image) ||
        (richMedia && (!image || !text.trim()))) throw cancelled();
    const message = [];
    if (!image || richMedia) message.push({type:'text',data:{text}});
    if (image) message.push({type:'image',data:{file:'base64://'+imageBase64(image)}});
    if (this.canSend({groupId,proactiveGroup,requiredAccess}) !== true) throw cancelled();
    const params = group ? {group_id:Number(number),message} : {user_id:Number(number),message};
    const socket = this.#socket;
    try {
      const data = await this.#call(group ? 'send_group_msg' : 'send_private_msg',params,true);
      const receipt = wireId(data?.message_id);
      if (!receipt) throw unknown();
      return {ok:true,receiptHash:createHash('sha256').update([prefix,target,receipt].join('/')).digest('hex')};
    } catch (error) {
      if (error.messageAttempted !== false && this.#socket === socket) this.#drop('blocked','ONEBOT_DELIVERY_UNKNOWN');
      throw error;
    }
  }
}
