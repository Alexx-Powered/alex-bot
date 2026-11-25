import {milkyTimeline} from './telemetry.mjs';
import {createConnection} from 'node:net';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isOrdinaryGroupId} from './core.mjs';
import {WebSocket} from 'ws';
import {imageBase64,QQAdapterError} from './qq-adapter.mjs';
import {validVideo} from './video-media.mjs';
import {copyIncomingMedia} from './incoming-media.mjs';

const decimal=s=>typeof s==='string'&&/^[1-9]\d{0,18}$/.test(s)&&BigInt(s)<=9223372036854775807n;
const error=(code,attempted=false)=>new QQAdapterError(code,{messageAttempted:attempted,phase:'send'});
const pairCommand=/^\/group-link ([a-f0-9]{32})$/;
const membershipTTL=90_000;
const officialPollMs=120_000;
const pairingTTL=300_000;
const offlineNoticeTTL=15*60_000;
const noticeTime=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

export class GroupConnections {
  constructor({core,official,onMessage,onState,socketPath,now=Date.now}) {
    Object.assign(this,{core,official,onMessage,onState,socketPath,now});
    this.directory=new Map(); this.pending=new Map(); this.observed=new Map();
    this.profileChecks=new Map();
    this.memberships=new Map();
    this.generation=0;
  }
  start() {
    if(this.official.groupProfile){
      this.profileTimer=setInterval(()=>{
        void this.refreshProfile().catch(()=>{});
        void this.refreshMembership().catch(()=>{});
      },3500).unref();
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
      ws.on('open',()=>{this.bridgeOpen=true;});
      ws.on('close',()=>{
        if(this.bridgeOpen&&!this.closed)this.onState?.('milky.bridge_closed',this.now());
        this.bridgeOpen=false;
        this.reset();
        if(!this.closed)this.retry=setTimeout(connect,2000).unref();
      });
    };
    connect();
  }
  reset({socketClosed=true}={}) {
    this.account=null;this.directory.clear();this.observed.clear();this.configSignature=null;
    this.directoryUnavailable=false;
    if(this.pair?.mode==='probe'&&!this.pair.ticket)this.finishProbe(this.pair,'GROUP_ROUTE_OFFLINE');
    // HTTP sends already accepted by the gateway can finish across event-stream reconnects.
    if(socketClosed)for(const request of [...this.pending.values()])request.finish(error('QQ_SERVICE_UNAVAILABLE',true));
  }
  close() {this.closed=true;clearTimeout(this.retry);clearTimeout(this.noticeRetry);clearInterval(this.profileTimer);this.socket?.terminate();this.reset();}
  async refreshProfile() {
    if(this.closed||this.checkingProfile||this.official.status().state!=='connected')return;
    const routes=this.core.groupRoutes().filter(r=>!r.ordinaryOnly);
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
  officialDisconnected() {
    this.generation++;
    this.memberships.clear();
  }
  observePresence(id,state,at) {
    const now=this.now(),previous=this.memberships.get(id);
    if(!this.core.groupRoutes().some(r=>r.id===id&&!r.ordinaryOnly)||!Number.isSafeInteger(at)||at<now-300000||at>now+60000)return;
    at=Math.min(at,now);
    if(previous&&(at<previous.at||(at===previous.at&&previous.state==='absent')))return;
    this.memberships.set(id,{state,at,source:'event',next:previous?.next??0,
      proactive:state==='present'&&previous?.proactive===true});
  }
  async refreshMembership() {
    if(this.closed||this.readingMembership||!this.official.groupMembership||this.official.status().state!=='connected')return;
    const routes=this.core.groupRoutes().filter(r=>!r.ordinaryOnly);
    for(const id of this.memberships.keys())if(!routes.some(r=>r.id===id))this.memberships.delete(id);
    const route=routes.find(r=>(this.memberships.get(r.id)?.next??0)<=this.now());
    if(!route)return;
    const previous=this.memberships.get(route.id),generation=this.generation;
    this.readingMembership=true;
    try{
      const result=await this.official.groupMembership(route.id);
      if(this.closed||generation!==this.generation||!this.core.groupRoutes().some(r=>r.id===route.id))return;
      const current=this.memberships.get(route.id),now=this.now();
      if(current!==previous || (result.state==='unknown'&&current?.source==='event'&&now-current.at<officialPollMs)){
        if(current)current.next=now+30000;
        return;
      }
      this.memberships.set(route.id,{...result,source:'api',at:now,next:now+(result.state==='present'?officialPollMs:30000)});
    }finally{this.readingMembership=false;}
  }
  officialPresence(route) {
    if(route.ordinaryOnly)return 'unlinked';
    if(this.official.status().state!=='connected')return 'offline';
    const record=this.memberships.get(route.id);
    return record&&this.now()-record.at<officialPollMs*2?record.state:'unknown';
  }
  available(route,channel) {
    return channel==='official'?this.officialPresence(route)==='present':
      this.live()&&!this.directoryUnavailable&&route.account===this.account&&this.directory.has(route.peer);
  }
  detect({groupKey}) {
    const route=this.core.groupRoutes().find(r=>r.key===groupKey);
    if(!route)return {ok:false,code:'GROUP_NOT_FOUND'};
    const now=this.now(),entry=this.memberships.get(route.id);
    if(entry&&(!this.lastDetection||now-this.lastDetection>=10000))entry.next=0;
    if(!this.lastDetection||now-this.lastDetection>=10000){
      this.lastDetection=now;
      if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:'refresh'}));
    }
    return {ok:true,code:'GROUP_DETECTION_QUEUED'};
  }
  activePair() {
    if(this.pair&&this.now()>=this.pair.expires){
      if(this.pair.mode==='probe')this.finishProbe(this.pair,'GROUP_PROBE_TIMEOUT');
      else this.pair=null;
    }
    return this.pair;
  }
  sync() {
    if(!this.live())return;
    const peers=this.core.sendingEnabled()?this.core.groupRoutes().filter(r=>r.active==='milky'&&this.available(r,'milky')&&this.core.groupEnabled(r.id)).map(r=>r.peer):[];
    const pair=this.activePair();
    const frame=JSON.stringify({type:'subscriptions',account:this.account,peers,
      verification:pair&&pair.account===this.account?{peer:pair.peer,command:pair.command,probe:pair.mode==='probe'}:null});
    if(frame!==this.configSignature){this.socket.send(frame);this.configSignature=frame;}
  }
  rosterKey() {
    return this.account?createHash('sha256').update('milky-roster:'+this.account).digest('hex'):null;
  }
  open({number,rosterKey}) {
    const account=this.account;
    const current=()=>this.live()&&!this.directoryUnavailable&&this.account===account&&this.rosterKey()===rosterKey&&this.directory.has(number);
    if(!current())return {ok:false,code:'GROUP_ROUTE_OFFLINE'};
    return this.core.openOrdinaryGroup(account,number,this.directory.get(number),current);
  }
  summary() {
    const routes=this.core.groupRoutes(),online=this.live();
    const pair=this.activePair();
    const byNumber=new Map(routes.filter(r=>r.account===this.account&&r.peer).map(r=>[r.peer,r]));
    const directory=[];
    if(online&&!this.directoryUnavailable)for(const [number,name] of this.directory){
      const known=byNumber.get(number);
      if(!known||known.ordinaryOnly)directory.push({number,name,...(known?{managed:true}:{})});
    }
    return {online,officialOnline:this.official.status().state==='connected',
      groups:routes.map(r=>{
        const official=this.officialPresence(r);
        const candidates=r.peer?[]:directory.filter(g=>r.names.official&&g.name===r.names.official);
        const milky=this.directoryUnavailable?'unknown':!online?'offline':r.account&&r.account!==this.account?'otherAccount':
          r.peer?(this.directory.has(r.peer)?'present':'absent'):candidates.length?'candidate':directory.length?'unverified':'absent';
        return {groupKey:r.key,active:r.active,revision:r.revision,names:r.names,official,milky,candidates,
        canProbe:!r.peer&&directory.length>0&&official==='present'&&this.memberships.get(r.id)?.proactive===true&&
          this.core.sendingEnabled()&&this.core.groupEnabled(r.id)&&this.core.groupAccess(r.id)==='white',
        profileState:this.profileChecks.get(r.key)?.state,
        profileCode:this.profileChecks.get(r.key)?.bizCode,profileHttp:this.profileChecks.get(r.key)?.httpStatus,
        ...(r.peer?{number:r.peer,milkyOnline:this.available(r,'milky')}:{})};}),
      directory,rosterKey:this.rosterKey(),probeResult:this.probeResult,
      pairing:pair?.mode==='probe'?{mode:'probe',groupKey:pair.key,matched:!!pair.ticket,
        ...(pair.ticket?{number:pair.observedPeer,name:this.directory.get(pair.observedPeer),command:pair.ticket}:{})}:pair?{groupKey:pair.key,number:pair.peer||pair.observedPeer,name:this.directory.get(pair.peer||pair.observedPeer),
        ambiguous:Boolean(pair.ambiguous),command:pair.command,official:pair.officialAt!=null,milky:pair.milkyAt!=null,
        matched:this.proofMatches(pair),expires:pair.expires}:null};
  }
  startPair({groupKey,number}) {
    if(this.activePair()?.mode==='probe')return {ok:false,code:'GROUP_PROBE_BUSY'};
    const route=this.core.groupRoutes().find(r=>r.key===groupKey);
    if(!route||(number!==''&&!decimal(number)))return {ok:false,code:'INVALID_INPUT'};
    if(route.peer||this.core.groupRoutes().some(r=>!r.ordinaryOnly&&r.account===this.account&&r.peer===number))return {ok:false,code:'GROUP_ROUTE_ALREADY_LINKED'};
    if(!this.live()||this.directoryUnavailable||!this.directory.size||(number&&!this.directory.has(number))||
      ['offline','absent'].includes(this.officialPresence(route)))return {ok:false,code:'GROUP_ROUTE_OFFLINE'};
    this.pair={key:groupKey,id:route.id,peer:number,account:this.account,command:'/group-link '+randomBytes(16).toString('hex'),
      expires:this.now()+pairingTTL};
    this.sync();return {ok:true,code:'GROUP_ROUTE_VERIFY'};
  }
  startProbe({groupKey}) {
    if(this.activePair())return {ok:false,code:'GROUP_PROBE_BUSY'};
    const route=this.core.groupRoutes().find(r=>r.key===groupKey);
    if(!route||!this.summary().groups.find(r=>r.groupKey===groupKey)?.canProbe)return {ok:false,code:'GROUP_PROBE_UNAVAILABLE'};
    if(this.lastProbe&&this.now()-this.lastProbe<60000)return {ok:false,code:'GROUP_PROBE_COOLDOWN'};
    const nonce=randomBytes(16).toString('hex');
    const pair={mode:'probe',key:groupKey,id:route.id,peer:'',account:this.account,nonce,command:'群连接核验 '+nonce,expires:this.now()+60000};
    this.lastProbe=this.now();this.probeResult=null;this.pair=pair;
    pair.timeout=setTimeout(()=>this.finishProbe(pair,'GROUP_PROBE_TIMEOUT'),60000).unref();
    this.sync();
    return {ok:true,code:'GROUP_PROBE_STARTED'};
  }
  finishProbe(pair,code) {
    if(this.pair!==pair)return;
    clearTimeout(pair.timeout);clearTimeout(pair.settle);
    this.pair=null;this.probeResult={groupKey:pair.key,code};
    this.sync();
  }
  async submitProbe(pair) {
    if(pair.startedAt!==undefined)return;
    pair.startedAt=this.now();
    const current=()=>this.activePair()===pair&&this.live()&&!this.directoryUnavailable&&
      this.account===pair.account&&this.officialPresence(pair)==='present';
    try{
      const receipt=await this.core.notifyGroupProbe(pair.key,pair.nonce,pair.expires,current);
      if(!receipt.ok||!current())return this.finishProbe(pair,receipt.ok?'GROUP_ROUTE_OFFLINE':receipt.code);
      pair.accepted=true;
      this.settleProbe(pair);
    }catch{this.finishProbe(pair,'GROUP_PROBE_FAILED');}
  }
  settleProbe(pair) {
    if(pair.ambiguous)return this.finishProbe(pair,'GROUP_PROBE_AMBIGUOUS');
    if(!pair.accepted||!pair.observedPeer||pair.settle)return;
    // Allow duplicate observations from another group to invalidate this proof.
    pair.settle=setTimeout(()=>{
      if(this.activePair()!==pair)return;
      const peer=pair.observedPeer;
      if(!this.available({...pair,peer},'milky')||!this.available(pair,'official'))return this.finishProbe(pair,'GROUP_ROUTE_OFFLINE');
      pair.ticket=randomUUID();
      clearTimeout(pair.timeout);
      pair.expires=this.now()+pairingTTL;
      pair.timeout=setTimeout(()=>this.finishProbe(pair,'GROUP_PROBE_TIMEOUT'),pairingTTL).unref();
    },2500).unref();
  }
  proofMatches(pair) {
    return !pair.ambiguous&&Number.isFinite(pair.officialAt)&&Number.isFinite(pair.milkyAt)&&Math.abs(pair.officialAt-pair.milkyAt)<=5000;
  }
  observeOfficial(message,expires) {
    if(message?.kind!=='group'||!pairCommand.test(message.text))return false;
    const p=this.activePair();
    if(p&&p.id===message.groupId&&message.mentioned&&message.text===p.command&&Number.isFinite(expires))
      {p.officialAt??=expires-pairingTTL;this.observePresence(p.id,'present',p.officialAt);}
    return true;
  }
  async confirm({groupKey,command}) {
    const p=this.activePair();
    if(!p||p.key!==groupKey||typeof command!=='string'||(p.mode==='probe'?
      !p.ticket||p.ticket!==command||p.ambiguous:p.command!==command||!this.proofMatches(p)))return {ok:false,code:'GROUP_ROUTE_UNVERIFIED'};
    const peer=p.peer||p.observedPeer;
    if(!this.available({...p,peer},'milky')||!this.available(p,'official'))return {ok:false,code:'GROUP_ROUTE_OFFLINE'};
    clearTimeout(p.timeout);clearTimeout(p.settle);
    this.pair=null;this.sync();return this.core.linkGroupRoute(groupKey,p.account,peer,this.directory.get(peer));
  }
  sendOfflineNotice() {
    clearTimeout(this.noticeRetry);
    const notice=this.offlineNotice;
    if(!notice || notice.submitted || this.closed || this.now()-notice.at>offlineNoticeTTL)return;
    if(this.official.status().state!=='connected' || !this.core.sendingEnabled()){
      this.noticeRetry=setTimeout(()=>this.sendOfflineNotice(),15_000).unref();
      return;
    }
    notice.submitted=true;
    const text='普通 QQ 掉线提醒。北京时间 '+noticeTime.format(notice.at)+'，Milky 上报了账号下线。请在控制台「连接与账号 → 普通 QQ」查看当前状态。';
    void this.core.notify({text,idempotencyKey:notice.key}).then(result=>{
      if(!result.ok && result.code!=='DUPLICATE')console.warn('ordinary_qq_offline_notice',result.code);
    }).catch(()=>console.warn('ordinary_qq_offline_notice','DELIVERY_ERROR'));
  }
  receive(frame) {
    if(frame.type==='account_offline'){
      const now=this.now();
      if(!decimal(frame.account)||!Number.isSafeInteger(frame.at)||frame.at<now-offlineNoticeTTL||frame.at>now+5000)return;
      const key='ordinary-offline:'+frame.account+':'+frame.at;
      if(this.offlineNotice && (this.offlineNotice.key===key || this.offlineNotice.at>frame.at))return;
      this.onState?.('milky.account_offline',frame.at);
      this.offlineNotice={key,at:frame.at,submitted:false};
      this.sendOfflineNotice();
      return;
    }
    if(frame.type==='roster_error'){
      if(!this.directoryUnavailable)this.onState?.('milky.roster_error',this.now());
      this.directoryUnavailable=true;
      this.configSignature=null;
      if(this.pair?.mode==='probe'&&!this.pair.ticket)this.finishProbe(this.pair,'GROUP_ROUTE_OFFLINE');
      return;
    }
    if(frame.type==='offline'){if(this.account)this.onState?.('milky.channel_offline',this.now());this.reset({socketClosed:false});return;}
    if(frame.type==='probe_ready'){
      const p=this.activePair();
      if(p?.mode==='probe'&&p.account===frame.account&&p.command===frame.command)void this.submitProbe(p);
      return;
    }
    if(frame.type==='roster'){
      if(!decimal(frame.account)||!Array.isArray(frame.groups)||frame.groups.length>5000)throw Error('INVALID_ROSTER');
      const directory=new Map();
      for(const g of frame.groups){
        if(!decimal(g.number)||typeof g.name!=='string'||g.name.length>160)throw Error('INVALID_GROUP');
        directory.set(g.number,g.name);
      }
      if(frame.account!==this.account||this.directoryUnavailable)this.onState?.('milky.roster_ready',this.now());
      if(frame.account!==this.account)this.reset({socketClosed:false});
      this.account=frame.account;this.directory=directory;this.lastRoster=this.now();this.directoryUnavailable=false;this.sync();
      const updates=this.core.groupRoutes().filter(r=>r.account===this.account&&directory.has(r.peer)&&r.names.milky!==directory.get(r.peer));
      if(updates.length)void this.core.rememberGroupNames(updates.map(r=>({...r,name:directory.get(r.peer)})),'milky').catch(()=>{});
      return;
    }
    if(frame.type==='receipt'){
      const request=this.pending.get(frame.request);
      if(!request)return;
      request.timeline?.({nonebotDeliveryAt:frame.deliveryAt,gatewayReturnedAt:frame.returnedAt,nodeReceiptAt:this.now()});
      if(frame.outcome==='accepted'&&decimal(frame.seq))request.finish(null,{ok:true});
      else if(frame.outcome==='cancelled')request.finish(error('QQ_SEND_CANCELLED'));
      else if(frame.outcome==='rejected')request.finish(new QQAdapterError('QQ_SEND_REJECTED',{
        bizCode:Number.isSafeInteger(frame.retcode)?frame.retcode:undefined,phase:'send',messageAttempted:true}));
      else request.finish(error('QQ_SERVICE_UNAVAILABLE',true));
      return;
    }
    if(frame.type!=='message'||!this.live()||this.directoryUnavailable||frame.account!==this.account||!this.directory.has(frame.peer)||
       !decimal(frame.sender)||!decimal(frame.seq)||frame.sender===this.account||typeof frame.text!=='string'||
       frame.text.length>4000||!Number.isSafeInteger(frame.at)||frame.at>this.now()+60000||frame.at<=this.now()-300000)return;
    const p=this.activePair();
    if(p?.mode==='probe'&&frame.text===p.command){
      if(p.startedAt===undefined||p.account!==this.account||frame.at<p.startedAt-1000||frame.at>this.now()+1000)return;
      if(p.observedPeer&&p.observedPeer!==frame.peer)p.ambiguous=true;
      p.observedPeer??=frame.peer;
      this.settleProbe(p);return;
    }
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
    void Promise.resolve(this.onMessage(message,expires,'milky',{qqEventAt:frame.at,nonebotReceivedAt:frame.receivedAt,nodeReceivedAt:this.now()})).catch(()=>{});
  }
  async send(request) {
    const route=request.groupId&&this.core.groupRoutes().find(r=>r.id===request.groupId);
    if(!route){
      if(isOrdinaryGroupId(request.groupId))throw error('QQ_SEND_CANCELLED');
      return this.official.send(request);
    }
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
      const timer=setTimeout(()=>finish(error('QQ_SERVICE_UNAVAILABLE',true)),220000);
      const timeline=milkyTimeline();
      timeline({nodeSubmittedAt:this.now()});
      this.pending.set(id,{finish,timeline});
      try{this.socket.send(JSON.stringify({type:'deliver',request:id,account:route.account,peer:route.peer,parts,
        deadline:request.deliveryDeadline??null}),err=>{if(err&&this.pending.has(id))finish(error('QQ_SERVICE_UNAVAILABLE',true));});}
      catch{finish(error('QQ_SERVICE_UNAVAILABLE'));}
    });
  }
}
