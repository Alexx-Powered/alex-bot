import {SocialConfigStore} from './social-config.mjs';
import {GroupMorningService,createGroupMorningStatus} from './group-morning.mjs';
import {SocialService} from './social-service.mjs';
import {studyImage} from './study-briefing.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { PrivateStore } from './storage.mjs';
import { BridgeCore } from './core.mjs';
import { QQAdapter } from './qq-adapter.mjs';
import { OneBotAdapter, validateOneBotProfile } from './onebot-adapter.mjs';
import { WeatherCommands, beijingDay } from './weather-commands.mjs';
import {WeatherToolbox} from './weather-tools.mjs';
import {ConversationAgent} from './conversation-agent.mjs';
import {AgentConfigStore} from './agent-config.mjs';
import {PythonAgentWorker} from './python-agent.mjs';
import {MorningReportService} from './morning-report.mjs';
import {loadSendLimits} from './send-limits.mjs';
import {ModelRequestBudget} from './chat-safety.mjs';
import {ConversionToolbox} from './conversion-tools.mjs';
import {CampusConfigStore} from './campus-config.mjs';
import {CampusService} from './campus-service.mjs';
import {PublicStatusService} from './public-status.mjs';
import {isEntrypoint} from './entrypoint.mjs';
import {MonitoringConfigStore} from './monitoring-config.mjs';
import {Telemetry,measureSpan} from './telemetry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxBody = 16384;
const locationCodes = new Set(['LOCATION_AMBIGUOUS', 'LOCATION_NOT_FOUND', 'LOCATION_INPUT_INVALID', 'LOCATION_SOURCE_UNAVAILABLE']);
const safeLocationSuggestion = value => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= 60 && /^[\p{Script=Han}\p{Script=Latin}\d ·（）()，,.'-]+$/u.test(value);
function validToken(value, token) {
  const supplied = Buffer.from(value || '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function body(req, limit = maxBody) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new Error('JSON_REQUIRED');
  let total = 0; const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('INVALID_INPUT');
  return data;
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }

export async function createBridgeServer({ home = process.env.QQ_BRIDGE_HOME || root, port = 19327, store = new PrivateStore(home), adapterFactory, oneBotProfile = null, weatherCommands = new WeatherCommands({home}), agentConfigStore = new AgentConfigStore(home), campusConfigStore = new CampusConfigStore(home), campusService, conversationAgent, morningReport, sendLimits, monitoringConfigStore = new MonitoringConfigStore(home), socialConfigStore = new SocialConfigStore(home), socialService, telemetry, prewarm = false, isMorningEnabled = async()=>{try{return JSON.parse((await fs.readFile(path.join(home,'config','morning-report.json'),'utf8')).replace(/^\uFEFF/,'')).enabled===true;}catch{return false;}} } = {}) {
  const profile = oneBotProfile === null ? null : validateOneBotProfile(oneBotProfile);
  const identityDomain = profile ? 'qq_uin_'+profile.selfId : null;
  const readTransportCredentials = () => profile ?? store.readCredentials();
  const limits=sendLimits??await loadSendLimits(home);
  const monitoring=telemetry||new Telemetry({home,configStore:monitoringConfigStore});
  await store.init();
  let configured = Boolean(await readTransportCredentials());
  const worker = new PythonAgentWorker({home,toolTimeouts:{buaa_classroom_query:120000,liang_status:75000,radar_image:150000}});
  const campus = campusService || new CampusService({home,configStore:campusConfigStore});
  const statusTools = new PublicStatusService({home});
  const weatherTools = new WeatherToolbox(weatherCommands,worker);
  const morning = morningReport || new MorningReportService({commands:weatherCommands,worker});
  const enableSocial = prewarm && (!profile || profile.mode === 'normal');
  const social=socialService||(enableSocial ? new SocialService({home,configStore:socialConfigStore,agentConfigStore}):null);
  const agent = conversationAgent || new ConversationAgent({toolbox:weatherTools,conversionTools:new ConversionToolbox(worker),campusTools:campus,statusTools,worker,configStore:agentConfigStore,policyFile:path.join(home,'config','chat-policy.md'),modelBudget:new ModelRequestBudget(home),socialService:social});
  const agentStatus = async () => {try{return await agentConfigStore.status();}catch{return {enabled:false,configured:false,code:'AGENT_CONFIG_UNAVAILABLE'};}};
  let core;
  const makeAdapter = adapterFactory ?? (options => profile ? new OneBotAdapter(options) : new QQAdapter(options));
  const adapter = makeAdapter({
    groupAddressed: (groupId,text) => core?.addressesGroupMessage(groupId,text)===true,
    canSend: request => core?.canDeliver(request) === true,
    admit: event => core?.admitsOneBotEvent(event) === true,
    onMessage: async (message) => {
      try { await monitoring.run({scope:message?.kind},()=>core.handleMessage(message)); } catch { /* no text or credential logging */ }
    },
    onStatus: (status) => {
      if (['blocked', 'error'].includes(status.state)) core?.setPaused(true).catch(() => {});
    },
  });
  core = new BridgeCore({ loadState: async () => {
    const raw = await store.loadState();
    if (raw && (raw.identityDomain ?? null) !== identityDomain) throw Error('TRANSPORT_STATE_MISMATCH');
    return raw;
  }, saveState: state => store.saveState(identityDomain ? {...state,identityDomain} : state), oneBotMode:profile?.mode,
    send: (request) => measureSpan('qq_send',()=>adapter.send(request)), now: () => Date.now(), limits, observeMessage:social?(data,context)=>social.observe(data,context):null, commandHandler: (text,context) => measureSpan('agent',()=>agent.handle(text,context)) });
  await core.init();
  const groupMorning=new GroupMorningService({core,adapter,morning,campus});
  const morningScheduleStatus=createGroupMorningStatus();
  if(prewarm){worker.prewarm();await worker.warmup().catch(()=>false);}
  let configBusy = false;
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
    assets['/wake-words.js']=['wake-words.js','text/javascript'];
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
    if(!admin&&!['/api/status','/api/notify','/api/notify-all-allowed','/api/weather/preview','/api/weather/briefing','/api/morning/test-all-allowed','/api/study-briefing','/api/group/morning/run'].includes(pathname))return json(res,403,{ok:false,code:'INTEGRATION_SCOPE_DENIED'});
    let mutationHeld = false;
    try {
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ok: true, version: '0.2.1', configured, transport: adapter.status(), core: core.status(), agent:await agentStatus(), campus:await campus.status(),
        groupMorning:{...await morningScheduleStatus(),enabledGroups:core.captureMorningTargets().length,
          weatherGroups:core.captureMorningTargets('morningWeather').length,campusGroups:core.captureMorningTargets('morningCampus').length} });
      if (req.method === 'GET' && pathname === '/api/monitoring/status') return json(res,200,{ok:true,config:await monitoringConfigStore.status(),telemetry:await monitoring.status(),transportDiagnostics:adapter.diagnostics?.()});
      if (req.method === 'GET' && pathname === '/api/social/status') return json(res,200,{ok:true,config:await socialConfigStore.status()});
      if (req.method === 'GET' && pathname === '/api/group/directory') {
        if (!core.status().paired) return json(res,409,{ok:false,code:'NOT_PAIRED'});
        try {
          const groups=await adapter.listGroups();
          return json(res,200,{ok:true,groups:groups.map(({id,name,number})=>({
            name,number,groupKey:createHash('sha256').update('group:'+id).digest('hex'),
          }))});
        } catch {return json(res,503,{ok:false,code:'GROUP_DIRECTORY_UNAVAILABLE'});}
      }
      if (req.method === 'GET' && pathname === '/api/campus/status') return json(res,200,{ok:true,...await campus.status()});
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
      const data = await body(req, pathname === '/api/study-briefing' ? 2100000 : maxBody);
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
        if (Object.keys(data).some(k=>!['groupKey','enabled','features'].includes(k))) throw Error('INVALID_INPUT');
        return json(res,200,await core.setGroupFeatures(data));
      }
      if (configBusy) return json(res, 409, { ok: false, code: 'CONFIG_BUSY' });
      configBusy = true; mutationHeld = true;
      let result;
      switch (pathname) {
        case '/api/group/morning/run':
          if (Object.keys(data).length) throw Error('INVALID_INPUT');
          result=!profile||profile.mode==='normal'?await groupMorning.run():{ok:false,code:'GROUP_MORNING_UNAVAILABLE'};
          break;
        case '/api/group/bind': {
          if (Object.keys(data).some(k=>!['groupKey','features'].includes(k)) || !/^[a-f0-9]{64}$/.test(data.groupKey||'')) throw Error('INVALID_INPUT');
          let groups;
          try {groups=await adapter.listGroups();}
          catch {result={ok:false,code:'GROUP_DIRECTORY_UNAVAILABLE'};break;}
          const selected=groups.find(g=>createHash('sha256').update('group:'+g.id).digest('hex')===data.groupKey);
          result=selected?await core.addDiscoveredGroup({...selected,features:data.features}):{ok:false,code:'GROUP_DIRECTORY_CHANGED'};
          break;
        }
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
        case '/api/study-briefing': {
          if(adapter.status().state!=='connected'){result={ok:false,code:'NOT_CONNECTED'};break;}
          const image=await studyImage(data);
          result=await core.notifyImage({image,idempotencyKey:data.idempotencyKey});break;
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
          if(Object.keys(data).length)throw new Error('INVALID_INPUT');
          const report=await morning.create();
          result={ok:true,date:report.date,cities:report.cities,plan:report.plan,analysis:report.analysis};break;
        }
        case '/api/agent/config': {
          try {await agentConfigStore.save(data);result={ok:true,code:'AGENT_CONFIG_SAVED',agent:await agentStatus()};}
          catch(error){result={ok:false,code:error.code==='AGENT_CONFIG_INVALID'?'AGENT_CONFIG_INVALID':'AGENT_CONFIG_UNAVAILABLE'};}
          break;
        }
        case '/api/config': {
          if (profile) return json(res,409,{ok:false,code:'OPERATOR_MANAGED_TRANSPORT'});
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
          const report=await weatherTools.briefing({cities:data.cities || ['beijing'],renderImage:false});
          result={ok:true,date:report.date,cities:report.cities,text:report.text};
          break;
        }
        case '/api/weather/briefing': {
          const mode = data.mode === undefined ? 'daily' : data.mode;
          if (!['daily','test'].includes(mode)) throw new Error('INVALID_INPUT');
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
    } finally { if (mutationHeld) configBusy = false; }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 3000;
  return {
    server, core, adapter, store, monitoring, readTransportCredentials,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      boundPort = server.address().port;
      return boundPort;
    },
    async close() {
      worker.close();
      weatherCommands.close?.();
      social?.close();
      campus.close();
      statusTools.close();
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
    if (!['official','onebot11'].includes(transport)) throw Error('TRANSPORT_INVALID');
    const profile = transport === 'onebot11'
      ? validateOneBotProfile(JSON.parse(await fs.readFile(path.join(process.env.CREDENTIALS_DIRECTORY,'onebot.json'),'utf8'))) : null;
    app = await createBridgeServer({prewarm:true,oneBotProfile:profile});
    const port = await app.listen();
    if (process.argv.includes('--connect') && app.core.status().paired && (!profile || !app.core.status().paused)) {
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

