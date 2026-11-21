import {createConnection} from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';
import {WebSocket} from 'ws';
import {imageBase64,QQAdapterError} from './qq-adapter.mjs';
import {validVideo} from './video-media.mjs';
import {copyIncomingMedia} from './incoming-media.mjs';

const decimal=s=>typeof s==='string'&&/^[1-9]\d{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n;
const error=(code,attempted=false)=>new QQAdapterError(code,{messageAttempted:attempted,phase:'send'});
const pairCommand=/^\/group-link ([a-f0-9]{32})$/;
const membershipTTL=90_000;
const pairingTTL=300_000;

export class GroupConnections {
  constructor({core,official,onMessage,socketPath,now=Date.now}) {
    Object.assign(this,{core,official,onMessage,socketPath,now});
    this.directory=new Map(); this.pending=new Map(); this.observed=new Map();
    this.profileChecks=new Map();
  }
  start() {
    if(this.official.groupProfile){
      this.profileTimer=setInterval(()=>{void this.refreshProfile().catch(()=>{});},3500).unref();
    }
    if(!this.socketPath)return;
    const connect=()=>{
      if(this.closed)return;
      const ws=new WebSocket('ws://localhost/groups',{perMessageDeflate:false,maxPayload:512*1024,
        createConnection:()=>createConnection(this.socketPath),handshakeTimeout:4000});
      this.socket=ws;
      ws.on('error',()=>{});
      ws.on('message',(bytes,binary)=>{
        try{if(binary)throw Error();this.receive(JSON.parse(bytes.toString()));}catch{ws.terminate();}
      });
      ws.on('close',()=>{
        this.reset();
        if(!this.closed)this.retry=setTimeout(connect,2000).unref();
      });
    };
    connect();
  }
  reset() {
    this.account=null;this.directory.clear();this.observed.clear();this.configSignature=null;
    for(const request of [...this.pending.values()])request.finish(error('QQ_SERVICE_UNAVAILABLE',true));
  }
  close() {this.closed=true;clearTimeout(this.retry);clearInterval(this.profileTimer);this.socket?.terminate();this.reset();}
  async refreshProfile() {
    if(this.closed||this.checkingProfile||this.official.status().state!=='connected')return;
    const routes=this.core.groupRoutes();
    for(const key of this.profileChecks.keys()){
      if(!routes.some(r=>r.key===key))this.profileChecks.delete(key);
    }
    const route=routes.find(r=>(this.profileChecks.get(r.key)?.next??0)<=this.now());
    if(!route)return;
    this.checkingProfile=true;
    try{
      const {name,state,httpStatus,bizCode}=await this.official.groupProfile(route.id);
      if(this.closed)return;
      this.profileChecks.set(route.key,{state,httpStatus,bizCode,next:this.now()+(state==='available'||state==='denied'?86400000:1800000)});
      if(name)await this.core.rememberGroupNames([{key:route.key,name}],'official');
    }finally{this.checkingProfile=false;}
  }
  live() {return Boolean(this.account&&this.socket?.readyState===WebSocket.OPEN&&this.now()-this.lastRoster<membershipTTL);}
  available(route,channel) {
    return channel==='official'?this.official.status().state==='connected':
      this.live()&&route.account===this.account&&this.directory.has(route.peer);
  }
  activePair() {
    if(this.pair&&this.now()>=this.pair.expires)this.pair=null;
    return this.pair;
  }
  sync() {
    if(!this.live())return;
    const peers=this.core.sendingEnabled()?this.core.groupRoutes().filter(r=>r.active==='milky'&&this.available(r,'milky')&&this.core.groupEnabled(r.id)).map(r=>r.peer):[];
    const pair=this.activePair();
    const frame=JSON.stringify({type:'subscriptions',account:this.account,peers,
      verification:pair&&pair.account===this.account?{peer:pair.peer,command:pair.command}:null});
    if(frame!==this.configSignature){this.socket.send(frame);this.configSignature=frame;}
  }
  summary() {
    const routes=this.core.groupRoutes(),online=this.live();
    const pair=this.activePair();
    return {online,officialOnline:this.official.status().state==='connected',
      groups:routes.map(r=>({groupKey:r.key,active:r.active,revision:r.revision,names:r.names,profileState:this.profileChecks.get(r.key)?.state,
        profileCode:this.profileChecks.get(r.key)?.bizCode,profileHttp:this.profileChecks.get(r.key)?.httpStatus,
        ...(r.peer?{number:r.peer,milkyOnline:this.available(r,'milky')}:{})})),
      directory:online?[...this.directory].filter(([id])=>!routes.some(r=>r.peer===id&&r.account===this.account))
        .map(([number,name])=>({number,name})):[],
      pairing:pair?{groupKey:pair.key,number:pair.peer||pair.observedPeer,name:this.directory.get(pair.peer||pair.observedPeer),
        ambiguous:Boolean(pair.ambiguous),command:pair.command,official:pair.officialAt!=null,milky:pair.milkyAt!=null,
        matched:this.proofMatches(pair),expires:pair.expires}:null};
  }
  startPair({groupKey,number}) {
    const route=this.core.groupRoutes().find(r=>r.key===groupKey);
    if(!route||(number!==''&&!decimal(number)))return {ok:false,code:'INVALID_INPUT'};
    if(route.peer||this.core.groupRoutes().some(r=>r.account===this.account&&r.peer===number))return {ok:false,code:'GROUP_ROUTE_ALREADY_LINKED'};
    if(!this.live()||!this.directory.size||(number&&!this.directory.has(number))||!this.available(route,'official'))return {ok:false,code:'GROUP_ROUTE_OFFLINE'};
    this.pair={key:groupKey,id:route.id,peer:number,account:this.account,command:'/group-link '+randomBytes(16).toString('hex'),
      expires:this.now()+pairingTTL};
    this.sync();return {ok:true,code:'GROUP_ROUTE_VERIFY'};
  }
  proofMatches(pair) {
    return !pair.ambiguous&&Number.isFinite(pair.officialAt)&&Number.isFinite(pair.milkyAt)&&Math.abs(pair.officialAt-pair.milkyAt)<=5000;
  }
  observeOfficial(message,expires) {
    if(message?.kind!=='group'||!pairCommand.test(message.text))return false;
    const p=this.activePair();
    if(p&&p.id===message.groupId&&message.mentioned&&message.text===p.command&&Number.isFinite(expires))
      p.officialAt??=expires-pairingTTL;
    return true;
  }
  async confirm({groupKey,command}) {
    const p=this.activePair();
    if(!p||p.key!==groupKey||p.command!==command||!this.proofMatches(p))return {ok:false,code:'GROUP_ROUTE_UNVERIFIED'};
    const peer=p.peer||p.observedPeer;
    if(!this.available({...p,peer},'milky')||!this.available(p,'official'))return {ok:false,code:'GROUP_ROUTE_OFFLINE'};
    this.pair=null;this.sync();return this.core.linkGroupRoute(groupKey,p.account,peer,this.directory.get(peer));
  }
  receive(frame) {
    if(frame.type==='offline'){this.reset();return;}
    if(frame.type==='roster'){
      if(!decimal(frame.account)||!Array.isArray(frame.groups)||frame.groups.length>5000)throw Error('INVALID_ROSTER');
      const directory=new Map();
      for(const g of frame.groups){
        if(!decimal(g.number)||typeof g.name!=='string'||g.name.length>160)throw Error('INVALID_GROUP');
        directory.set(g.number,g.name);
      }
      if(frame.account!==this.account)this.reset();
      this.account=frame.account;this.directory=directory;this.lastRoster=this.now();this.sync();
      const updates=this.core.groupRoutes().filter(r=>r.account===this.account&&directory.has(r.peer)&&r.names.milky!==directory.get(r.peer));
      if(updates.length)void this.core.rememberGroupNames(updates.map(r=>({...r,name:directory.get(r.peer)})),'milky').catch(()=>{});
      return;
    }
    if(frame.type==='receipt'){
      const request=this.pending.get(frame.request);
      if(!request)return;
      if(frame.outcome==='accepted'&&decimal(frame.seq))request.finish(null,{ok:true});
      else if(frame.outcome==='cancelled')request.finish(error('QQ_SEND_CANCELLED'));
      else if(frame.outcome==='rejected')request.finish(new QQAdapterError('QQ_SEND_REJECTED',{
        bizCode:Number.isSafeInteger(frame.retcode)?frame.retcode:undefined,phase:'send',messageAttempted:true}));
      else request.finish(error('QQ_SERVICE_UNAVAILABLE',true));
      return;
    }
    if(frame.type!=='message'||!this.live()||frame.account!==this.account||!this.directory.has(frame.peer)||
       !decimal(frame.sender)||!decimal(frame.seq)||frame.sender===this.account||typeof frame.text!=='string'||
       frame.text.length>4000||!Number.isSafeInteger(frame.at)||frame.at>this.now()+60000||frame.at<=this.now()-300000)return;
    const p=this.activePair();
    if(pairCommand.test(frame.text)){
      if(p&&p.account===this.account&&(!p.peer||p.peer===frame.peer)&&p.command===frame.text){
        if(p.observedPeer&&p.observedPeer!==frame.peer)p.ambiguous=true;
        p.observedPeer??=frame.peer;
        p.milkyAt??=frame.at;
      }
      return;
    }
    const route=this.core.groupRoutes().find(r=>r.account===this.account&&r.peer===frame.peer&&r.active==='milky');
    if(!route||!this.core.groupEnabled(route.id)||!this.core.sendingEnabled())return;
    const id='milky:'+frame.account+':'+frame.peer+':'+frame.seq;
    const expires=Math.min(frame.at,this.now())+300000;
    if(this.observed.has(id))return;
    while(this.observed.size>=512)this.observed.delete(this.observed.keys().next().value);
    this.observed.set(id,{key:route.key,revision:route.revision,expires});
    const message={kind:'group',groupId:route.id,senderId:'milky:'+frame.account+':'+frame.sender,id,
      mentioned:frame.mentioned===true,text:frame.text,media:copyIncomingMedia(frame.media),
      replyTarget:{scope:'group',targetId:route.id,msgId:id}};
    void Promise.resolve(this.onMessage(message,expires,'milky')).catch(()=>{});
  }
  async send(request) {
    const route=request.groupId&&this.core.groupRoutes().find(r=>r.id===request.groupId);
    if(!route)return this.official.send(request);
    if(route.active==='official'){
      try{return await this.official.send(request);}
      catch(failure){
        if(failure?.code==='QQ_NOT_CONNECTED'&&failure.messageAttempted===false)throw error('QQ_SERVICE_UNAVAILABLE');
        throw failure;
      }
    }
    if(!this.available(route,'milky'))throw error('QQ_SERVICE_UNAVAILABLE');
    if(!this.core.canDeliver(request))throw error('QQ_SEND_CANCELLED');
    if(!request.proactiveGroup&&!request.weatherAlertPermit){
      const msg=this.observed.get(request.replyTarget?.msgId);
      if(!msg||msg.key!==route.key||msg.revision!==route.revision||msg.expires<=this.now())throw error('QQ_SEND_CANCELLED');
    }
    const parts=[];
    if(typeof request.text!=='string'||request.text.length>4000||(request.image&&request.video))throw error('QQ_TEXT_INVALID');
    if(request.richMedia||(!request.image&&!request.video))parts.push({type:'text',text:request.text});
    if(request.image)parts.push({type:'image',base64:imageBase64(request.image)});
    if(request.video){
      if(!validVideo(request.video))throw error('QQ_VIDEO_INVALID');
      parts.push({type:'video',base64:request.video.buffer.toString('base64')});
    }
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const finish=(failure,value)=>{
        clearTimeout(timer);this.pending.delete(id);if(failure)reject(failure);else resolve(value);
      };
      const timer=setTimeout(()=>finish(error('QQ_SERVICE_UNAVAILABLE',true)),120000);
      this.pending.set(id,{finish});
      try{this.socket.send(JSON.stringify({type:'deliver',request:id,account:route.account,peer:route.peer,parts,
        deadline:request.deliveryDeadline??null}),err=>{if(err&&this.pending.has(id))finish(error('QQ_SERVICE_UNAVAILABLE',true));});}
      catch{finish(error('QQ_SERVICE_UNAVAILABLE'));}
    });
  }
}
