import {studyImage} from './study-briefing.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { PrivateStore } from './storage.mjs';
import { BridgeCore } from './core.mjs';
import { QQAdapter } from './qq-adapter.mjs';
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

export async function createBridgeServer({ home = process.env.QQ_BRIDGE_HOME || root, port = 19327, store = new PrivateStore(home), adapterFactory = (options) => new QQAdapter(options), weatherCommands = new WeatherCommands(), agentConfigStore = new AgentConfigStore(home), campusConfigStore = new CampusConfigStore(home), campusService, conversationAgent, morningReport, sendLimits, isMorningEnabled = async()=>{try{return JSON.parse((await fs.readFile(path.join(home,'config','morning-report.json'),'utf8')).replace(/^\uFEFF/,'')).enabled===true;}catch{return false;}} } = {}) {
  const limits=sendLimits??await loadSendLimits(home);
  await store.init();
  let configured = Boolean(await store.readCredentials());
  const worker = new PythonAgentWorker({home,toolTimeouts:{buaa_classroom_query:120000}});
  const campus = campusService || new CampusService({home,configStore:campusConfigStore});
  const weatherTools = new WeatherToolbox(weatherCommands,worker);
  const morning = morningReport || new MorningReportService({commands:weatherCommands,worker});
  const agent = conversationAgent || new ConversationAgent({toolbox:weatherTools,conversionTools:new ConversionToolbox(worker),campusTools:campus,worker,configStore:agentConfigStore,policyFile:path.join(home,'config','chat-policy.md'),modelBudget:new ModelRequestBudget(home)});
  const agentStatus = async () => {try{return await agentConfigStore.status();}catch{return {enabled:false,configured:false,code:'AGENT_CONFIG_UNAVAILABLE'};}};
  let core;
  const adapter = adapterFactory({
    canSend: request => core?.canDeliver(request) === true,
    onMessage: async (message) => {
      try { await core.handleMessage(message); } catch { /* no text or credential logging */ }
    },
    onStatus: (status) => {
      if (['blocked', 'error'].includes(status.state)) core?.setPaused(true).catch(() => {});
    },
  });
  core = new BridgeCore({ loadState: () => store.loadState(), saveState: (state) => store.saveState(state),
    send: (request) => adapter.send(request), now: () => Date.now(), limits, commandHandler: (text,context) => agent.handle(text,context) });
  await core.init();
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
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/guide': ['guide.html', 'text/html'], '/guide.css': ['guide.css', 'text/css'], '/logo.svg': ['logo.svg', 'image/svg+xml'] };
    if (req.method === 'GET' && assets[pathname]) {
      const [file, type] = assets[pathname];
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', type + '; charset=utf-8');
      try { return res.end(await fs.readFile(path.join(root, 'public', file))); }
      catch { return json(res, 500, { ok: false, code: 'ASSET_UNAVAILABLE' }); }
    }
    if (!pathname.startsWith('/api/')) return json(res, 404, { ok: false, code: 'NOT_FOUND' });
    if (!validToken(req.headers.authorization, store.token)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
    let mutationHeld = false;
    try {
      if (req.method === 'GET' && pathname === '/api/status') return json(res, 200, { ok: true, version: '0.2.1', configured, transport: adapter.status(), core: core.status(), agent:await agentStatus(), campus:await campus.status() });
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
      if (configBusy) return json(res, 409, { ok: false, code: 'CONFIG_BUSY' });
      configBusy = true; mutationHeld = true;
      let result;
      switch (pathname) {
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
            const credentials = await store.readCredentials();
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
          if (!/^[a-f0-9]{64}$/.test(data.groupKey || '')) throw new Error('INVALID_INPUT');
          if (adapter.status().state !== 'connected') return json(res, 409, { ok: false, code: 'NOT_CONNECTED' });
          result = await core.confirmGroupPairing({ groupKey: data.groupKey }); break;
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
          result=await core.notifyImage({image:report.image,idempotencyKey:key});
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
    server, core, adapter, store,
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      boundPort = server.address().port;
      return boundPort;
    },
    async close() {
      worker.close();
      campus.close();
      await adapter.disconnect();
      server.closeIdleConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const app = await createBridgeServer();
    const port = await app.listen();
    if (process.argv.includes('--connect') && app.core.status().paired) {
      const credentials=await app.store.readCredentials();
      if(credentials) await app.adapter.connect(credentials);
    }
    console.log('Codex QQ 本地测试服务已启动：http://127.0.0.1:' + port);
    console.log('运行 scripts/open-setup.ps1 打开本机配置页。发送暂停状态会跨重启保留。');
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().finally(() => process.exit(0)));
  } catch {
    console.error('启动失败：请检查端口19327、config/send-limits.json、私有目录权限和Windows当前用户加密能力。未输出凭据。');
    process.exitCode = 1;
  }
}

