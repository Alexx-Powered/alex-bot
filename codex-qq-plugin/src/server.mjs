import {GroupWeatherScheduler} from './group-weather-scheduler.mjs';
import {validMorningInput} from './morning-settings.mjs';
import {SocialConfigStore} from './social-config.mjs';
import {GroupMorningService,createGroupMorningStatus,groupMorningClock} from './group-morning.mjs';
import {SocialService} from './social-service.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { PrivateStore } from './storage.mjs';
import { BridgeCore } from './core.mjs';
import { QQAdapter } from './qq-adapter.mjs';
import {GroupConnections} from './group-connections.mjs';
import { WeatherCommands, beijingDay, isCityQuery } from './weather-commands.mjs';
import {WeatherToolbox} from './weather-tools.mjs';
import {ConversationAgent} from './conversation-agent.mjs';
import {AgentConfigStore} from './agent-config.mjs';
import {PythonAgentWorker} from './python-agent.mjs';
import {MorningReportService} from './morning-report.mjs';
import {createCalendarAirQuality} from './morning-pm25.mjs';
import {loadSendLimits} from './send-limits.mjs';
import {ModelRequestBudget} from './chat-safety.mjs';
import {CampusConfigStore} from './campus-config.mjs';
import {CampusService} from './campus-service.mjs';
import {isEntrypoint} from './entrypoint.mjs';
import {MonitoringConfigStore} from './monitoring-config.mjs';
import {Telemetry,milkyTimeline,measureSpan} from './telemetry.mjs';
import {RagHealthCheck} from './rag-health.mjs';
import {ResearchHealthCheck} from './research-health.mjs';
import {HikingHealthCheck,indexWhenIdle} from './hiking-health.mjs';
import {WeatherAlertsService} from './weather-alerts.mjs';
import {OrdinaryQQControl} from './ordinary-qq-control.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBody = 16384;
const locationCodes = new Set(['LOCATION_AMBIGUOUS', 'LOCATION_NOT_FOUND', 'LOCATION_INPUT_INVALID', 'LOCATION_SOURCE_UNAVAILABLE']);
const safeLocationSuggestion = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 60 && /^[\p{Script=Han}\p{Script=Latin}\d ·（）()，,.'-]+$/u.test(value);
function validToken(value, token) {
  const supplied = Buffer.from(value || '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('JSON_REQUIRED');
  let total = 0; const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBody) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('INVALID_INPUT');
  return data;
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }

export async function createBridgeServer({ home = process.env.QQ_BRIDGE_HOME || root, port = 19327, store = new PrivateStore(home), adapterFactory, weatherCommands = new WeatherCommands({home,air:createCalendarAirQuality(home)}), agentConfigStore = new AgentConfigStore(home), campusConfigStore = new CampusConfigStore(home), campusService, conversationAgent, agentWorker, ragEnabled = Boolean(process.env.QQ_RAG_CONFIG), morningReport, groupMorningNow, groupMorningSleep, sendLimits, monitoringConfigStore = new MonitoringConfigStore(home), socialConfigStore = new SocialConfigStore(home), socialService, telemetry, prewarm = false, isMorningEnabled = async()=>{try{return JSON.parse((await fs.readFile(path.join(home,'config','morning-report.json'),'utf8')).replace(/^\uFEFF/,'')).enabled===true;}catch{return false;}} } = {}) {
  const readTransportCredentials = () => store.readCredentials();
  const limits=sendLimits??await loadSendLimits(home);
  const monitoring=telemetry||new Telemetry({home,configStore:monitoringConfigStore});
  await store.init();
  let configured = Boolean(await readTransportCredentials());
  const worker = agentWorker || new PythonAgentWorker({home,toolTimeouts:{satellite_video:190000,cloud_video:190000,pm25_video:190000,precipitation_video:190000,temperature_video:190000,buaa_classroom_query:210000,buaa_classroom_data:210000,liang_status:75000,radar_image:150000}});
  const ragHealth = new RagHealthCheck({worker,enabled:ragEnabled});
  const researchHealth = new ResearchHealthCheck({worker,enabled:ragEnabled,configStore:agentConfigStore});
  const hikingHealth = new HikingHealthCheck({worker,enabled:ragEnabled,configStore:agentConfigStore});
  let ragMaintenance=null;
  const campus = campusService || new CampusService({home,configStore:campusConfigStore});
  const weatherTools = new WeatherToolbox(weatherCommands,worker);
  const morning = morningReport || new MorningReportService({commands:weatherCommands,home,worker});
  const social=socialService||(prewarm ? new SocialService({home,configStore:socialConfigStore,agentConfigStore}):null);
  const agent = conversationAgent || new ConversationAgent({campusTools:campus,worker,configStore:agentConfigStore,policyFile:path.join(home,'config','chat-policy.md'),modelBudget:new ModelRequestBudget(home),socialService:social});
  const agentStatus = async () => {try{return await agentConfigStore.status();}catch{return {enabled:false,configured:false,code:'AGENT_CONFIG_UNAVAILABLE'};}};
  let core,weatherAlerts,connections;
  const receive=(message,expires,channel,times)=>monitoring.run({scope:message.kind},()=>{
    if(channel==='milky')milkyTimeline()(times??{});
    return core.handleMessage(message,expires,channel);
  });
  const makeAdapter = adapterFactory ?? (options => new QQAdapter(options));
  const adapter = makeAdapter({
    groupAddressed: (groupId,text) => core?.addressesGroupMessage(groupId,text)===true,
    canSend: request => core?.canDeliver(request) === true &&
      (!request.groupId||!core.groupRoutes().some(r=>r.id===request.groupId&&r.active!=='official')),
    onGroupJoin: event => (event.messageId!==undefined&&core?.groupAccess(event.groupId)!==null)
      ? undefined : core?.recordOfficialGroupJoin(event),
    onGroupPresence:(id,state,at)=>connections?.observePresence(id,state,at),
    onMessage: async (message, replyExpiresAt) => {
      try { if(!connections?.observeOfficial(message,replyExpiresAt))await receive(message,replyExpiresAt,'official'); } catch { /* no text or credential logging */ }
    },
    onStatus: (status) => {
      if(status.state==='connected')connections?.sendOfflineNotice();
      else connections?.officialDisconnected();
      if (['blocked','error'].includes(status.state) &&
          ['QQ_BOT_BANNED','QQ_BOT_UNAVAILABLE','QQ_PERMISSION_DENIED'].includes(status.code)) {
        core?.setPaused(true).catch(() => {});
      }
    },
  });
  core = new BridgeCore({ loadState: async () => {
    const raw = await store.loadState();
    if (raw?.identityDomain != null) throw Error('TRANSPORT_STATE_MISMATCH');
    return raw;
  }, saveState: state => store.saveState(state),
    send: (request) => measureSpan('qq_send',()=>connections.send(request)), now: () => groupMorningNow?Number(groupMorningNow()):Date.now(), limits, observeMessage:social?(data,context)=>social.observe(data,context):null, commandHandler: (text,context) => measureSpan('agent',async()=>await weatherAlerts.handle(text,context)??await agent.handle(text,context)) });
  await core.init();
  connections=new GroupConnections({core,official:adapter,onMessage:receive,
    onState:(operation,at)=>void monitoring.run({operation,transport:'milky'},()=>milkyTimeline()({stateEventAt:at})).catch(()=>{}),
    socketPath:process.env.QQ_GROUP_CHANNEL_SOCKET});
  const groupTransport={status:()=>adapter.status().state==='connected'||core.groupRoutes().some(r=>r.active==='milky'&&connections.available(r,'milky'))
    ? {state:'connected'} : {state:'disconnected'}};
  weatherAlerts=new WeatherAlertsService({home,core,adapter:groupTransport});
  const morningOptions={core,adapter:groupTransport,morning,campus,
    runRetry:(context,work)=>monitoring.run(context,work),now:groupMorningNow,sleep:groupMorningSleep};
  const groupMorning=new GroupMorningService(morningOptions);
  const weatherScheduler=new GroupWeatherScheduler(morningOptions,(context,work)=>monitoring.run(context,work));
  const morningScheduleStatus=createGroupMorningStatus();
  if(prewarm){worker.prewarm();await worker.warmup().catch(()=>false);}
  let configBusy = false;
  const ordinaryQQ = new OrdinaryQQControl({roster:() =>
    connections.live() && !connections.directoryUnavailable ? connections.lastRoster : 0});
  let connectionGeneration = 0;
  let boundPort = port;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expectedHost = '127.0.0.1:' + boundPort;
    const expectedOrigin = 'http://' + expectedHost;
    if (req.headers.host !== expectedHost) return json(res, 403, { ok: false, code: 'HOST_DENIED' });
    if (req.headers.origin && req.headers.origin !== expectedOrigin) return json(res, 403, { ok: false, code: 'ORIGIN_DENIED' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { ok: false, code: 'CROSS_SITE_DENIED' });
    let pathname;
    try { pathname = new URL(req.url, expectedOrigin).pathname; } catch { return json(res, 400, { ok: false, code: 'INVALID_URL' }); }
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, service: 'alex-codex-qq', version: '0.2.1' });
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/group-console.js': ['group-console.js','text/javascript'], '/style.css': ['style.css', 'text/css'], '/guide': ['guide.html', 'text/html'], '/guide.css': ['guide.css', 'text/css'], '/logo.png': ['logo.png', 'image/png'], '/social': ['social.html','text/html'], '/social.js':['social.js','text/javascript'], '/logo.svg': ['logo.svg', 'image/svg+xml'] };
    assets['/ordinary-qq.js']=['ordinary-qq.js','text/javascript'];
    assets['/wake-words.js']=['wake-words.js','text/javascript'];
    assets['/weather-alerts.js']=['weather-alerts.js','text/javascript'];
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', type.startsWith('text/') ? type + '; charset=utf-8' : type);
      try { return res.end(await fs.readFile(path.join(root, 'public', file))); }
      catch { return json(res, 500, { ok: false, code: 'ASSET_UNAVAILABLE' }); }
    }
    if (!pathname.startsWith('/api/')) return json(res, 404, { ok: false, code: 'NOT_FOUND' });
    const admin=validToken(req.headers.authorization,store.token);
    const integration=store.integrationToken&&validToken(req.headers.authorization,store.integrationToken);
    if(!admin&&!integration)return json(res,401,{ok:false,code:'UNAUTHORIZED'});
    if(!admin&&!['/api/status','/api/notify','/api/notify-all-allowed','/api/weather/preview','/api/weather/briefing','/api/morning/test-all-allowed','/api/group/morning/run','/api/group/morning/prepare'].includes(pathname))return json(res,403,{ok:false,code:'INTEGRATION_SCOPE_DENIED'});
    let mutationHeld = false;
    try {
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ok: true, version: '0.2.1', configured, transport: adapter.status(), core: core.status({includeHelpNotes:admin}), agent:await agentStatus(), campus:await campus.status(),
        groupMorning:{...await morningScheduleStatus(),preparation:groupMorning.status(),enabledGroups:core.captureMorningTargets().length,
          weatherGroups:core.captureMorningTargets('morningWeather').length,campusGroups:core.captureMorningTargets('morningCampus').length},
        ...(admin?{weatherAlerts:await weatherAlerts.status(),groupConnections:connections.summary()}:{} ) });
      if (req.method === 'GET' && pathname === '/api/ordinary-qq/status') return json(res, 200, await ordinaryQQ.status());
      if(req.method==='GET'&&pathname==='/api/weather-alerts/status')return json(res,200,await weatherAlerts.status());
      if (req.method === 'GET' && pathname === '/api/monitoring/status') return json(res,200,{ok:true,config:await monitoringConfigStore.status(),telemetry:await monitoring.status(),transportDiagnostics:adapter.diagnostics?.()});
      if (req.method === 'GET' && pathname === '/api/social/status') return json(res,200,{ok:true,config:await socialConfigStore.status()});
      const groupLogRoute = /^\/api\/group\/([a-f0-9]{64})\/delivery-log$/.exec(pathname);
      if (req.method === 'GET' && groupLogRoute) {
        const log = core.groupDeliveryLog(groupLogRoute[1]);
        return json(res, log.ok ? 200 : 404, log);
      }
      if (req.method === 'GET' && pathname === '/api/campus/status') return json(res,200,{ok:true,...await campus.status()});
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
      const data = await body(req);
      if (pathname === '/api/ordinary-qq/login/start') {
        if (Object.keys(data).length) throw Error('INVALID_INPUT');
        return json(res, 200, await ordinaryQQ.startLogin());
      }
      if(pathname.startsWith('/api/group/connection/')){
        const op=pathname.slice('/api/group/connection/'.length);
        const fields={open:['number','rosterKey'],verify:['groupKey','number'],probe:['groupKey'],detect:['groupKey'],confirm:['groupKey','command'],select:['groupKey','channel','revision']};
        if(!Object.hasOwn(fields,op)||Object.keys(data).length!==fields[op].length||Object.keys(data).some(k=>!fields[op].includes(k)))throw Error('INVALID_INPUT');
        const result=op==='open'?await connections.open(data):op==='probe'?connections.startProbe(data):op==='detect'?connections.detect(data):
          op==='verify'?connections.startPair(data):op==='confirm'?await connections.confirm(data):
          await core.selectGroupRoute(data,(route,channel)=>connections.available(route,channel));
        return json(res,200,result);
      }
      if(pathname==='/api/weather-alerts/search'){
        if(Object.keys(data).some(k=>k!=='query')||typeof data.query!=='string'||data.query.length>48)throw Error('INVALID_INPUT');
        return json(res,200,await weatherAlerts.search(data.query));
      }
      if(pathname==='/api/weather-alerts/configure'){
        if(Object.keys(data).some(k=>!['targetKey','operation','query','code','enabled','revision'].includes(k)))throw Error('INVALID_INPUT');
        return json(res,200,await weatherAlerts.configure(data));
      }
      if(pathname==='/api/weather-alerts/preview'){
        if(Object.keys(data).some(k=>k!=='code')||!/^\d{6}$/.test(data.code||''))throw Error('INVALID_INPUT');
        return json(res,200,await weatherAlerts.preview(data.code));
      }
      if (pathname === '/api/rag/check') {
        const checked = await ragHealth.run(data);
        return json(res,checked.statusCode,checked.body);
      }
      if (pathname === '/api/hiking/check') {
        const checked=await hikingHealth.run(data);return json(res,checked.statusCode,checked.body);
      }
      if (pathname === '/api/rag/index') {
        if(Object.keys(data).length||!ragEnabled)return json(res,400,{ok:false,code:'INVALID_INPUT'});
        return json(res,200,{ok:true,...await indexWhenIdle(worker)});
      }
      if (pathname === '/api/research/check') {
        const checked=await researchHealth.run(data);
        return json(res,checked.statusCode,checked.body);
      }
      // Safety controls must reach the core even while a slow preview, send or
      // credential read holds the operation lock. setPaused sets its stop flag
      // synchronously, before waiting for the core's persistence queue.
      if (pathname === '/api/pause' && data.paused === true) {
        return json(res, 200, await core.setPaused(true));
      }
      if (pathname === '/api/disconnect') {
        ++connectionGeneration;
        const paused = core.setPaused(true);
        await Promise.all([paused, adapter.disconnect()]);
        await core.cancelPairing();
        return json(res, 200, { ok: true, code: 'DISCONNECTED' });
      }
      if(pathname==='/api/group/remove'||(pathname==='/api/group/access'&&data.access==='gray')){
        if(!/^[a-f0-9]{64}$/.test(data.groupKey||''))throw new Error('INVALID_INPUT');
        return json(res,200,await(pathname.endsWith('/remove')?core.removeAllowedGroup({groupKey:data.groupKey}):core.setGroupAccess({groupKey:data.groupKey,access:'gray'})));
      }
      if (pathname==='/api/group/wake-words') {
        if (Object.keys(data).some(k=>!['groupKey','disabledWakeWords','revision'].includes(k))) throw Error('INVALID_INPUT');
        return json(res,200,await core.setGroupWakeWords(data));
      }
      if (['/api/wake-words/add','/api/wake-words/rename','/api/wake-words/delete'].includes(pathname)) {
        const operation=pathname.split('/').at(-1);
        const keys=operation==='add'?['text','revision']:operation==='rename'?['id','text','revision']:['id','revision'];
        if (Object.keys(data).some(k=>!keys.includes(k))) throw Error('INVALID_INPUT');
        return json(res,200,await core.changeWakeWord({...data,operation}));
      }
      if (pathname==='/api/group/features') {
        if (Object.keys(data).some(k=>!['groupKey','enabled','features','helpNote','morningSchedule'].includes(k))) throw Error('INVALID_INPUT');
        if(data.morningSchedule!==undefined){
          const schedule=data.morningSchedule;
          if(!validMorningInput(schedule)||(schedule.location&&!isCityQuery(schedule.location))||Object.keys(schedule).some(key=>!['location','time'].includes(key)))throw Error('INVALID_INPUT');
          const status=core.status(),group=[...status.allowedGroups,...status.grayGroups].find(g=>g.groupKey===data.groupKey);
          if(!group)return json(res,200,{ok:false,code:'GROUP_NOT_FOUND'});
          const previous=group.morningSchedule;
          try {
            const place=!schedule.location?null:previous?.location===schedule.location?previous.place:
              await weatherCommands.locations.resolve(schedule.location,{preferBest:true});
            data.morningSchedule={...schedule,place};
          } catch(error) {
            return json(res,200,{ok:false,code:locationCodes.has(error?.code)?error.code:'LOCATION_SOURCE_UNAVAILABLE'});
          }
        }
        return json(res,200,await core.setGroupFeatures(data));
      }
      // Preparation must not hold the configuration lock across slow network
      // requests: the separate 07:30 dispatcher and safety controls stay usable.
      if(['/api/group/morning/prepare','/api/group/morning/run'].includes(pathname)) {
        if(Object.keys(data).length)throw Error('INVALID_INPUT');
        const preparing=pathname.endsWith('/prepare');
        const result=await monitoring.run({
          operation:preparing?'morning.prepare':'morning.dispatch',
          date:groupMorningClock(groupMorningNow?.()).date,
        },()=>preparing ? groupMorning.prepare() : groupMorning.run());
        return json(res,200,result);
      }
      if (configBusy) return json(res, 409, { ok: false, code: 'CONFIG_BUSY' });
      configBusy = true; mutationHeld = true;
      let result;
      switch (pathname) {
        case '/api/monitoring/test': {
          if(Object.keys(data).length)throw Error('INVALID_INPUT');
          await monitoring.run({scope:'c2c',synthetic:true},()=>measureSpan('agent',async()=>({ok:true,code:'MONITORING_TEST'})));
          result={ok:true,code:'MONITORING_TEST_QUEUED'};break;
        }
        case '/api/social/config': {
          try{const config=await socialConfigStore.save(data);result={ok:true,code:'SOCIAL_CONFIG_SAVED',config};}
          catch{result={ok:false,code:'SOCIAL_CONFIG_INVALID'};}
          break;
        }
        case '/api/monitoring/config': {
          try{const config=await monitoringConfigStore.save(data);result={ok:true,code:'MONITORING_CONFIG_SAVED',config};}
          catch(error){result={ok:false,code:error.code==='MONITORING_CONFIG_INVALID'?'MONITORING_CONFIG_INVALID':'MONITORING_CONFIG_UNAVAILABLE'};}
          break;
        }
        case '/api/campus/config': {
          try{const status=await campusConfigStore.save(data);result={ok:true,code:'CAMPUS_CONFIG_SAVED',campus:status};}
          catch(error){result={ok:false,code:error.code==='CAMPUS_CONFIG_INVALID'?'CAMPUS_CONFIG_INVALID':'CAMPUS_CONFIG_UNAVAILABLE'};}
          break;
        }
        case '/api/campus/query':
        case '/api/campus/login': {
          const queried=await campus.run(data,pathname.endsWith('/login')?'login':'query');
          result=queried.data;break;
        }
        case '/api/campus/briefing': {
          if(Object.keys(data).some(k=>!['date','requestId'].includes(k))||typeof data.requestId!=='string'||!/^[a-f0-9]{32}$/.test(data.requestId))throw new Error('INVALID_INPUT');
          const status=core.status();
          if(!status.paired){result={ok:false,code:'NOT_PAIRED'};break;}
          if(status.paused){result={ok:false,code:'PAUSED'};break;}
          if(adapter.status().state!=='connected'){result={ok:false,code:'NOT_CONNECTED'};break;}
          if(status.minuteAttempts>=status.limits.minuteAttempts){result={ok:false,code:'RATE_LIMIT_MINUTE'};break;}
          if(!status.remainingDailyAttempts){result={ok:false,code:'RATE_LIMIT_DAY'};break;}
          const report=await campus.run({date:data.date||''},'report');
          if(!report.data.ok){result={ok:false,code:report.data.code,data:report.data};break;}
          const delivery=await core.notifyImage({image:report.image,idempotencyKey:'campus:'+data.requestId});
          result={ok:delivery.ok,code:delivery.code,data:report.data,delivery};break;
        }
        case '/api/morning/test-all-allowed': {
          if(Object.keys(data).some(key=>key!=='idempotencyKey')||typeof data.idempotencyKey!=='string'||!/^[a-zA-Z0-9._:-]{1,100}$/.test(data.idempotencyKey))throw new Error('INVALID_INPUT');
          const stop=code=>({ok:false,code,results:[],attempted:0,sent:0});
          const status=core.status();
          if(!await isMorningEnabled()){result=stop('MORNING_NOT_ENABLED');break;}
          if(!status.paired){result=stop('NOT_PAIRED');break;}
          if(status.paused){result=stop('PAUSED');break;}
          if(adapter.status().state!=='connected'){result=stop('NOT_CONNECTED');break;}
          const targets=1+status.groupCount;
          if(status.dailyAttempts+targets>status.limits.dailyAttempts){result=stop('RATE_LIMIT_DAY');break;}
          if(status.minuteAttempts+targets>status.limits.minuteAttempts){result=stop('RATE_LIMIT_MINUTE');break;}
          const report=await morning.create();
          if(report.date!==beijingDay())throw new Error('WEATHER_DATE_CHANGED');
          if(!/^morning-rules-v\d+$/.test(report.analysis?.version||'')){result=stop('MORNING_ANALYSIS_UNAVAILABLE');break;}
          result=await core.notifyImageAllAllowed({image:report.image,idempotencyKey:data.idempotencyKey});
          break;
        }
        case '/api/notify-all-allowed':
          if(Object.keys(data).some(key=>!['text','idempotencyKey'].includes(key))||typeof data.text!=='string'||!data.text.trim()||data.text.length>1500||typeof data.idempotencyKey!=='string'||!/^[a-zA-Z0-9._:-]{1,100}$/.test(data.idempotencyKey))throw new Error('INVALID_INPUT');
          result=await core.notifyAllAllowed(data);break;
        case '/api/morning/preview': {
          if(Object.keys(data).some(key=>key!=='part')||(Object.hasOwn(data,'part')&&!['weather','campus'].includes(data.part)))throw new Error('INVALID_INPUT');
          const part=data.part??'weather',date=groupMorningClock().date;
          result=await monitoring.run({operation:'morning.preview',date,part},async()=>{
            if(part==='campus'){
              const report=await measureSpan('morning_campus_prepare',()=>campus.run({date},'report',{scheduledMorning:true}),
                value=>value.data.ok?null:value.data);
              if(!report.data.ok)return {ok:false,code:report.data.code,date};
              const rooms=report.data.rooms.filter(room=>room.building==='三号楼').length;
              if(!report.image||!rooms)return {ok:false,code:'CAMPUS_IMAGE_MISSING',date};
              return {ok:true,date,rooms,fetchedAt:report.data.fetched_at,imageBytes:report.image.buffer.length};
            }
            const report=await measureSpan('morning_weather_prepare',()=>morning.create({scheduledMorning:true}));
            return {ok:true,date:report.date,cities:report.cities,plan:report.plan,analysis:report.analysis,
              pm25Source:report.pm25Source,morningQuality:report.morningQuality,imageBytes:report.image?.buffer.length};
          });break;
        }
        case '/api/agent/config': {
          try {await agentConfigStore.save(data);result={ok:true,code:'AGENT_CONFIG_SAVED',agent:await agentStatus()};}
          catch(error){result={ok:false,code:error.code==='AGENT_CONFIG_INVALID'?'AGENT_CONFIG_INVALID':'AGENT_CONFIG_UNAVAILABLE'};}
          break;
        }
        case '/api/config': {
          if (!/^[0-9]{4,30}$/.test(data.appId || '') || typeof data.appSecret !== 'string' || data.appSecret.length < 8 || data.appSecret.length > 512 || /\s/.test(data.appSecret)) {
            return json(res, 400, { ok: false, code: 'INVALID_CREDENTIAL_FORMAT' });
          }
            const previous = await store.readCredentials();
            if (core.status().paired && previous?.appId !== data.appId) return json(res, 409, { ok: false, code: 'PAIRED_APP_CHANGE_DENIED' });
            await adapter.disconnect();
            await core.cancelPairing();
            await core.setPaused(true);
            await store.saveCredentials({ appId: data.appId, appSecret: data.appSecret });
            configured = true;
            result = { ok: true, code: 'CONFIG_SAVED' };
          break;
        }
        case '/api/connect': {
            const generation = connectionGeneration;
            const credentials = await readTransportCredentials();
            if (generation !== connectionGeneration) { result = { ok: false, code: 'CONNECT_CANCELLED' }; break; }
            if (!credentials) return json(res, 409, { ok: false, code: 'NOT_CONFIGURED' });
            await adapter.disconnect();
            await core.cancelPairing();
            if (generation !== connectionGeneration) { result = { ok: false, code: 'CONNECT_CANCELLED' }; break; }
            await adapter.connect(credentials);
            if (generation !== connectionGeneration) {
              await adapter.disconnect();
              result = { ok: false, code: 'CONNECT_CANCELLED' }; break;
            }
            result = { ok: true, code: 'CONNECTING' };
          break;
        }
        case '/api/pair/start':
          if (adapter.status().state !== 'connected') return json(res, 409, { ok: false, code: 'NOT_CONNECTED' });
          result = await core.startPairing(); break;
        case '/api/pair/confirm': result = await core.confirmPairing(); break;
        case '/api/group/start':
          if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(data.name)) throw new Error('INVALID_INPUT');
          if (adapter.status().state !== 'connected') return json(res, 409, { ok: false, code: 'NOT_CONNECTED' });
          if(data.access!==undefined&&!['white','gray'].includes(data.access))throw new Error('INVALID_INPUT');
          result = await core.startGroupPairing({ name: data.name.trim(),access:data.access||'white' }); break;
        case '/api/group/confirm':
          if(Object.keys(data).some(key=>!['groupKey','features'].includes(key)))throw new Error('INVALID_INPUT');
          if (!/^[a-f0-9]{64}$/.test(data.groupKey || '')) throw new Error('INVALID_INPUT');
          if (adapter.status().state !== 'connected') return json(res, 409, { ok: false, code: 'NOT_CONNECTED' });
          result = await core.confirmGroupPairing({ groupKey: data.groupKey,features:data.features }); break;
        case '/api/group/cancel': result = await core.cancelGroupPairing(); break;
        case '/api/group/remove':
          if (!/^[a-f0-9]{64}$/.test(data.groupKey || '')) throw new Error('INVALID_INPUT');
          result = await core.removeAllowedGroup({ groupKey: data.groupKey }); break;
        case '/api/group/access':
          if(!/^[a-f0-9]{64}$/.test(data.groupKey||'')||!['white','gray'].includes(data.access))throw new Error('INVALID_INPUT');
          result=await core.setGroupAccess({groupKey:data.groupKey,access:data.access});break;
        case '/api/pause':
          if (typeof data.paused !== 'boolean') throw new Error('INVALID_INPUT');
          result = await core.setPaused(data.paused); break;
        case '/api/test-notify':
          result = await core.notify({ text: 'Codex QQ 最小测试：这是一条由本机发送的主动通知。', idempotencyKey: 'ui-test-' + randomUUID() }); break;
        case '/api/notify':
          if (typeof data.text !== 'string' || data.text.length > 1500 || typeof data.idempotencyKey !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(data.idempotencyKey)) throw new Error('INVALID_INPUT');
          result = await core.notify({ text: data.text, idempotencyKey: data.idempotencyKey }); break;
        case '/api/weather/preview': {
          result=await monitoring.run({scope:'c2c'},async()=>{
            const report=await weatherTools.briefing({cities:data.cities || ['beijing'],renderImage:false});
            return {ok:true,date:report.date,cities:report.cities,text:report.text};
          });
          break;
        }
        case '/api/weather/briefing': {
          const mode = data.mode === undefined ? 'daily' : data.mode;
          if (!['daily','test'].includes(mode)) throw new Error('INVALID_INPUT');
          const scheduledTest=data.scheduledMorning!==undefined;
          if(scheduledTest&&(mode!=='test'||data.scheduledMorning!==true||
            Object.keys(data).some(key=>!['mode','scheduledMorning','idempotencyKey'].includes(key))||
            typeof data.idempotencyKey!=='string'||!/^[a-zA-Z0-9._:-]{1,64}$/.test(data.idempotencyKey)))throw Error('INVALID_INPUT');
          const enhanced=mode==='daily'&&await isMorningEnabled();
          let cities = data.cities === undefined ? ['beijing'] : data.cities;
          if (mode === 'daily') {
            const plan=enhanced?morning.plan():{city:'beijing'},aliases=plan.city==='tianjin'?['tianjin','天津','天津市']:['beijing','北京','北京市'];
            if (data.cities!==undefined&&(!Array.isArray(cities)||cities.length!==1||!aliases.includes(cities[0]))) {
              result = { ok: false, code: 'DAILY_CITY_RESTRICTED' }; break;
            }
            cities = [plan.city];
          }
          if (!core.status().paired) { result={ok:false,code:'NOT_PAIRED'}; break; }
          if (core.status().paused) { result={ok:false,code:'PAUSED'}; break; }
          if (adapter.status().state !== 'connected') { result={ok:false,code:'NOT_CONNECTED'}; break; }
          if(scheduledTest){
            const status=core.status();
            if(status.minuteAttempts>=status.limits.minuteAttempts){result={ok:false,code:'RATE_LIMIT_MINUTE'};break;}
            if(!status.remainingDailyAttempts){result={ok:false,code:'RATE_LIMIT_DAY'};break;}
            result=await monitoring.run({operation:'morning.test',date:beijingDay()},async()=>{
              const report=await morning.create({scheduledMorning:true});
              if(report.date!==beijingDay())throw Error('WEATHER_DATE_CHANGED');
              if(!report.image)throw Error('WEATHER_IMAGE_MISSING');
              const delivery=await core.notifyImage({image:report.image,idempotencyKey:'morning-owner-test:'+data.idempotencyKey});
              return {...delivery,date:report.date,pm25Source:report.pm25Source};
            });
            break;
          }
          const report=enhanced?await morning.create():await weatherTools.briefing({cities,renderImage:true});
          if(report.date!==beijingDay())throw new Error('WEATHER_DATE_CHANGED');
          const key=mode === 'test' ? 'weather-test-'+randomUUID() : 'weather-daily-'+report.date;
          if(!report.image) throw new Error('WEATHER_IMAGE_MISSING');
          if(mode==='daily'){
            result=await core.notifyImageAllAllowed({image:report.image,idempotencyKey:key,groupsOnly:true});
            const campusReport=await campus.run({date:report.date},'report');
            if(!campusReport.image)throw Error('CAMPUS_IMAGE_MISSING');
            const campusDelivery=await core.notifyImageAllAllowed({image:campusReport.image,idempotencyKey:key+'-building3',groupsOnly:true});
            result={ok:result.ok&&campusDelivery.ok,code:result.ok&&campusDelivery.ok?'SENT':'MORNING_PARTIAL',weather:result,campus:campusDelivery};
          }else result=await core.notifyImage({image:report.image,idempotencyKey:key});
          break;
        }
        default: return json(res, 404, { ok: false, code: 'NOT_FOUND' });
      }
      json(res, 200, result);
    } catch (error) {
      if (['/api/weather/preview', '/api/weather/briefing'].includes(pathname) && locationCodes.has(error?.code)) {
        const result = { ok: false, code: error.code };
        if (error.code === 'LOCATION_AMBIGUOUS' && Array.isArray(error.suggestions)) {
          result.suggestions = error.suggestions.filter(safeLocationSuggestion).slice(0, 8);
        }
        return json(res, 200, result);
      }
      const inputCodes = new Set(['JSON_REQUIRED', 'BODY_TOO_LARGE', 'INVALID_INPUT']);
      const code = inputCodes.has(error.message) ? error.message : error instanceof SyntaxError ? 'INVALID_JSON' : 'OPERATION_FAILED';
      json(res, code === 'OPERATION_FAILED' ? 500 : 400, { ok: false, code });
    } finally { if (mutationHeld) configBusy = false; if(req.method==='POST')connections.sync(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 3000;
  return {
    server, core, adapter, store, monitoring, readTransportCredentials, weatherAlerts,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      boundPort = server.address().port;
      connections.start();
      if(prewarm){weatherAlerts.start();weatherScheduler.start();}
      if(prewarm&&ragEnabled&&!ragMaintenance){ragMaintenance=setInterval(()=>{void indexWhenIdle(worker);},60000);ragMaintenance.unref();}
      return boundPort;
    },
    async close() {
      connections.close();
      weatherAlerts.close();weatherScheduler.close();
      clearInterval(ragMaintenance);
      worker.close();
      weatherCommands.close?.();
      social?.close();
      campus.close();
      await adapter.disconnect();
      server.closeIdleConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (await isEntrypoint(import.meta.url)) {
  let app;
  try {
    const transport = process.env.QQ_TRANSPORT ?? 'official';
    if (transport !== 'official') throw Error('TRANSPORT_INVALID');
    app = await createBridgeServer({prewarm:true});
    const port = await app.listen();
    if (process.argv.includes('--connect') && app.core.status().paired) {
      const credentials=await app.readTransportCredentials();
      if(credentials) await app.adapter.connect(credentials);
    }
    console.log('Codex QQ 本地测试服务已启动：http://127.0.0.1:' + port);
    console.log('运行 scripts/open-setup.ps1 打开本机配置页。发送暂停状态会跨重启保留。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().finally(() => process.exit(0)));
  } catch {
    await app?.close().catch(() => {});
    console.error('启动失败：请检查端口19327、config/send-limits.json、私有目录权限和平台加密凭据。未输出凭据。');
    process.exitCode = 1;
  }
}

