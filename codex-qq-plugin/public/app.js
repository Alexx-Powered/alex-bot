const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const incoming = params.get('token');
if (incoming && /^[0-9a-f]{64}$/.test(incoming)) sessionStorage.setItem('qq-local-token', incoming);
if (location.hash) history.replaceState(null, '', '/');
const token = sessionStorage.getItem('qq-local-token');
let pendingGroupKey = null;
let monitoringInitialized=false,monitoringDirty=false,monitoringBusy=false;
const groupConsole=createGroupConsole({api,action});
const weatherAlertsConsole=createWeatherAlertsConsole({api,refresh});
const wakeWordConsole=createWakeWordEditor({container:$('globalWakeWords'),action});
const ordinaryQQPanel = token ? createOrdinaryQQPanel(api) : null;
const consoleTabs=[...document.querySelectorAll('[data-console-target]')];
function selectConsolePanel(key) {
  if (!consoleTabs.some(tab=>tab.dataset.consoleTarget===key)) key='groups';
  for (const tab of consoleTabs) {
    const active=tab.dataset.consoleTarget===key;
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
  }
  for (const panel of document.querySelectorAll('[data-console-panel]')) panel.classList.toggle('hidden',panel.dataset.consolePanel!==key);
  sessionStorage.setItem('qq-console-panel',key);
  ordinaryQQPanel?.show(key === 'connection');
}
for (const tab of consoleTabs) {
  tab.onclick=()=>selectConsolePanel(tab.dataset.consoleTarget);
  tab.onkeydown=event=>{
    if (!['ArrowDown','ArrowUp','ArrowRight','ArrowLeft'].includes(event.key)) return;
    event.preventDefault();
    const step=['ArrowDown','ArrowRight'].includes(event.key)?1:-1;
    const next=consoleTabs[(consoleTabs.indexOf(tab)+step+consoleTabs.length)%consoleTabs.length];
    selectConsolePanel(next.dataset.consoleTarget);next.focus();
  };
}
selectConsolePanel(sessionStorage.getItem('qq-console-panel')||'groups');
for (const input of document.querySelectorAll('input[type="checkbox"]')) {input.classList.add('ios-switch');input.role='switch';}
const descriptions = {
  GROUP_COMMAND_COPIED:'匹配指令已复制，请在目标群 @ 机器人后粘贴。',GROUP_COPY_MANUALLY:'请选中上方匹配指令手动复制。',
  GROUP_FEATURES_SAVED:'本群设置已保存，即刻生效。',GROUP_HELP_NOTE_INVALID:'请检查帮助页备注的内容与长度。',
  GROUP_DISABLED:'这个群已停用。',
  MONITORING_TEST_QUEUED:'已提交监控自检，请查看下方发送状态；不会发送QQ消息。',
  MONITORING_CONFIG_SAVED:'监控设置已加密保存。',MONITORING_CONFIG_INVALID:'请检查项目名、区域、工作区ID和Key；首次启用需要Key。',MONITORING_CONFIG_UNAVAILABLE:'监控配置暂不可用，请检查加密存储。',
  GRAY_GROUP_ALLOWED:'已加入灰名单：基础聊天与换算。',GROUP_ACCESS_CHANGED:'群权限已更新，该群上下文已清除。',GROUP_ACCESS_DENIED:'群权限已改变，本次结果未发送。',
  OK:'查询完成，JSON已更新。',CAMPUS_CONFIG_SAVED:'校园设置已加密保存。',CAMPUS_CONFIG_INVALID:'请检查学号和密码；首次启用或修改账号时需要同时填写两项。',
  CAMPUS_CONFIG_UNAVAILABLE:'校园加密配置暂不可用，请检查本机存储。',CAMPUS_NOT_CONFIGURED:'请先在本页填写并保存校园学号密码。',CAMPUS_DISABLED:'校园查询未启用。',
  CAMPUS_BUSY:'已有校园查询或浏览器验证正在进行，请稍后再试。',CAMPUS_INVALID_DATE:'请选择今天至未来7天内的日期。',CAMPUS_AUTH_FAILED:'校园认证未成功，请检查凭据或打开浏览器完成验证。',
  CAMPUS_INTERACTION_REQUIRED:'需要你在专用浏览器完成验证码或二次验证，请点击“打开浏览器完成验证”。',CAMPUS_NETWORK_ERROR:'校园网络请求失败，本次没有返回旧数据。',
  CAMPUS_SCHEMA_CHANGED:'校园接口数据格式发生变化，已停止生成。',CAMPUS_BROWSER_UNAVAILABLE:'校园查询浏览器未能启动，请检查Edge和本机Python依赖。',
  CAMPUS_QUERY_FAILED:'校园查询未能完成，请检查网络或重新进行浏览器验证。',CAMPUS_RENDER_FAILED:'查询或三号楼简报绘制未完成，未发送图片。',CAMPUS_OWNER_ONLY:'校园查询仅支持本人或白名单群，当前会话未开放。',
  AGENT_CONFIG_SAVED:'模型设置已保存，下次请求生效。', AGENT_CONFIG_INVALID:'请检查模型名、Key 格式；首次启用需要填写 Key。', AGENT_CONFIG_UNAVAILABLE:'模型配置暂不可用，请检查本机加密存储。',
  CONFIG_SAVED:'凭据已加密保存。现在可以连接 QQ。', CONNECTING:'正在连接 QQ，请稍候。',
  CONNECT_CANCELLED:'连接请求已被断开操作取消。',
  CONFIG_BUSY:'上一项操作仍在进行，请等待完成后再操作。',
  DISCONNECTED:'已断开连接，发送已暂停。', PAIRING_STARTED:'配对码已生成，请用自己的 QQ 私聊机器人。',
  PAIRING_PENDING:'收到了配对请求，请确认本次是你自己的操作。', PAIRED:'配对成功。现在可以发送 /ping 或测试通知。',
  SENT:'发送接口返回成功，请到 QQ 核对是否实际收到。', DUPLICATE:'这条通知已处理，未重复发送。',
  PAUSED:'已暂停发送。', RESUMED:'已恢复发送。', NOT_PAIRED:'请先完成本人配对。',
  NOT_CONNECTED:'QQ 尚未连接。', NOT_CONFIGURED:'请先填写并保存机器人凭据。',
  RATE_LIMIT_MINUTE:'已达到本地每分钟尝试上限，请稍后再试。', RATE_LIMIT_DAY:'已达到本地今日尝试上限。', RATE_LIMIT_REPLY_DAY:'普通回复已达到今日阈值，剩余额度保留给主动通知。',
  INVALID_CREDENTIAL_FORMAT:'请检查 AppID 和 AppSecret 格式。', OPERATION_FAILED:'操作失败。请检查配置与本地服务状态；未展示可能包含凭据的原始错误。',
  UNAUTHORIZED:'本地访问口令不正确，请重新运行打开配置页脚本。',
  ALREADY_PAIRED:'已经配对，不能覆盖现有接收人。', NO_PAIRING_CANDIDATE:'尚未收到有效配对消息。',
  PAIRING_EXPIRED:'配对码已过期，请重新生成。', PAIRED_APP_CHANGE_DENIED:'已配对时不允许更换 AppID，避免把消息发给其他应用下的用户。',
  GROUP_PAIRING_STARTED:'匹配指令已生成。请在目标群 @ 机器人后发送，5 分钟内有效。',
  GROUP_PAIRING_CANCELLED:'已取消待绑定群。', GROUP_ALLOWED:'这个群已加入白名单。', GROUP_REMOVED:'已移出群权限名单。',
  GROUP_PAIRING_EXPIRED:'群绑定码已过期，请重新生成。', NO_GROUP_PAIRING_CANDIDATE:'尚未收到有效的群绑定消息。',
  GROUP_PAIRING_KEY_MISMATCH:'待确认群已变化，请刷新并重新核对。', GROUP_ALREADY_ALLOWED:'这个群已在权限名单中，可在列表切换档位。',
  GROUP_LIMIT_REACHED:'所选名单已达10群的本地上限。', GROUP_NOT_FOUND:'这个群已不在权限名单中。', INVALID_INPUT:'请检查输入内容。',
};
Object.assign(descriptions,{WAKE_WORDS_SAVED:'全局唤醒词已保存，所有页面同步。',GROUP_WAKE_WORDS_SAVED:'本群唤醒词开关已保存。',WAKE_WORDS_CHANGED:'词库已在其他页面更新，请核对最新列表后再保存。',INVALID_WAKE_WORD:'请输入 1–24 字、不含空白的唤醒词。',WAKE_WORD_EXISTS:'这个唤醒词已经存在（英文不区分大小写）。',WAKE_WORD_NOT_FOUND:'该唤醒词已被删除，请刷新列表。',WAKE_WORD_LIMIT:'最多可保存 32 个唤醒词。'});
Object.assign(descriptions,{
  GROUP_DETECTION_QUEUED:'正在刷新两个账号的群内状态。',GROUP_PROBE_STARTED:'已开始核验，将向本群发送一条消息。',
  GROUP_PROBE_BUSY:'已有群正在核验。',GROUP_PROBE_UNAVAILABLE:'当前无法向本群发送核验消息，请使用群内口令。',
  GROUP_PROBE_COOLDOWN:'刚刚发起过核验，请稍后再试。',
  GROUP_ROUTE_VERIFY:'匹配指令已生成。',GROUP_ROUTE_LINKED:'已核实两个账号连接到同一个群。',GROUP_ROUTE_SAVED:'本群工作通道已保存。',
  GROUP_ROUTE_OFFLINE:'目标通道离线或当前账号已不在该群。',GROUP_ROUTE_UNVERIFIED:'两个通道还未收到同一条有效匹配指令。',
  GROUP_ROUTE_ALREADY_LINKED:'此群已有通道关联，请刷新群设置。',GROUP_ROUTE_CHANGED:'工作通道已在其他页面更改，请核对最新状态。',
  GROUP_OPENED:'已打开群设置。',GROUP_ROUTE_HAS_SETTINGS:'这个普通 QQ 群已有独立设置。要改用官方群的设置，请先在普通 QQ 群设置中移除该记录，再到官方群确认关联。',
  GROUP_ROUTE_UNLINKED:'切换到另一通道前，请先确认两个账号在同一群。'
});
function feedback(data) {
  const success = data?.ok === true;
  $('feedback').className = success ? 'success' : 'error';
  $('feedback').textContent = descriptions[data?.code] || (success ? '操作完成：' : '操作未完成：') + (data?.code || 'UNKNOWN');
}
const stageNames={core_queue:'消息排队',agent:'业务处理',worker_queue:'Python排队',worker_startup:'Python启动',worker_total:'Python总耗时',router_setup:'路由初始化',router_model:'模型路由',chat_setup:'口吻初始化',chat_model:'聊天表达',memory:'记忆',tool:'工具查询',qq_send:'QQ发送'};
Object.assign(stageNames,{warning_fetch:'获取官方预警',warning_area:'预警地区匹配',warning_render:'预警卡片绘制'});
Object.assign(stageNames,{morning_weather_prepare:'准备早间天气',morning_campus_prepare:'准备自习简报',
  morning_outdoor_index:'计算户外指数',morning_weather_delivery:'投递早间天气',morning_campus_delivery:'投递自习简报'});
Object.assign(stageNames,{weather_forecast_primary:'主预报接口',weather_metadata_primary:'主起报元数据',
  weather_forecast_backup:'备用预报接口',weather_metadata_backup:'备用起报元数据'});
const scheduledTraceNames={'morning.prepare':'早报准备','morning.dispatch':'早报投递','morning.preview':'早报预览','morning.retry':'早报重试'};
Object.assign(stageNames,{weather_video:'天气视频',resolve_location:'地点解析',heavy_queue:'渲染资源排队',video_cache_hit:'视频缓存命中',
  video_prepare_worker:'渲染进程初始化',video_fetch_gdps:'获取 GDPS 云量',video_fetch_ifs:'读取 ECMWF 预报',video_fetch_gfs:'读取 GFS 备用预报',video_fetch_cams:'读取 CAMS 空气预报',video_fetch_forecast:'查询备用预报接口',video_fetch_satellite:'获取卫星观测',
  video_download_slowest:'最慢一次下载',video_decode_slowest:'最慢一次解码',video_render_frames:'绘图及帧写盘',video_encode_h264:'H.264 编码',
  video_read_mp4:'读取成片',weather_fetch:'获取天气',air_fetch:'获取空气质量',weather_render:'天气绘图',radar_query:'雷达查询',qq_media_upload:'QQ 媒体上传',qq_message_submit:'QQ 消息提交'});
const duration=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`${Math.round(value)} ms`:'—';
async function refreshMonitoring({force=false}={}){
  if(monitoringBusy)return;monitoringBusy=true;
  try{
    const state=await api('monitoring/status');
    if(!state?.ok){$('monitoringState').textContent=descriptions[state?.code]||'监控状态暂不可用';return;}
    const config=state.config||{},telemetry=state.telemetry||{},remote=telemetry.langsmith||{};
    $('monitoringState').textContent=(config.configured?'LangSmith Key 已加密保存':'尚未保存 LangSmith Key')+' · '+(config.enabled?'远端监控已启用':'仅本地耗时记录')+' · '+(remote.lastCode||'等待样本');
    if(force||(!monitoringInitialized&&!monitoringDirty&&!document.querySelector('#monitoringConfig:focus-within'))){
      $('monitoringEnabled').checked=config.enabled===true;$('monitoringProject').value=config.project||'alex-bot';
      $('monitoringEndpoint').value=config.endpoint||'https://api.smith.langchain.com';$('monitoringWorkspace').value=config.workspaceId||'';
      monitoringInitialized=true;
    }
    const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
    const summary=telemetry.summary||{};
    $('monitoringCounters').textContent=`远端已发送 ${count(remote.sent)} · 待发送 ${count(remote.pending)} · 已丢弃 ${count(remote.dropped)}；业务样本 ${count(summary.count)} · 耗时中位数 ${duration(summary.medianMs)} · P95 ${duration(summary.p95Ms)}（不计监控自检）。监控发送失败不会阻塞QQ回复。`;
    const recent=Array.isArray(telemetry.recent)?telemetry.recent.slice(0,10):[];
    const container=$('monitoringRecent');container.replaceChildren();
    if(!recent.length){const p=document.createElement('p');p.className='help';p.textContent='暂无耗时样本，收到下一条QQ请求后更新。';container.append(p);return;}
    const table=document.createElement('table'),head=document.createElement('thead'),heading=document.createElement('tr');
    for(const label of ['时间','场景','总耗时','分段']){const th=document.createElement('th');th.textContent=label;heading.append(th);}
    head.append(heading);table.append(head);const body=document.createElement('tbody');
    for(const trace of recent){
      const row=document.createElement('tr'),stamp=new Date(trace.at);
      const stages=Array.isArray(trace.stages)?trace.stages.slice(0,64):[];
      const scene=Object.hasOwn(scheduledTraceNames,trace.operation)?scheduledTraceNames[trace.operation]:
        trace.synthetic===true?'监控自检':trace.scope==='group'?'群聊':trace.scope==='c2c'?'私聊':'请求';
      const values=[Number.isFinite(stamp.getTime())?stamp.toLocaleTimeString('zh-CN',{hour12:false}):'—',scene,duration(trace.totalMs),stages.map(stage=>`${stageNames[stage.name]||'其他'} ${duration(stage.ms)}`).join(' / ')];
      for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}body.append(row);
    }
    table.append(body);container.append(table);
  }catch{$('monitoringState').textContent='监控状态暂不可用';}
  finally{monitoringBusy=false;}
}
async function api(route, data) {
  const response = await fetch('/api/' + route, { method:data===undefined?'GET':'POST',
    headers:{ Authorization:'Bearer '+token, ...(data===undefined?{}:{'Content-Type':'application/json'}) },
    ...(data===undefined?{}:{body:JSON.stringify(data)}), cache:'no-store', credentials:'omit' });
  return response.json();
}
const states={disconnected:'QQ 未连接',connecting:'正在连接 QQ',connected:'QQ 已连接',reconnecting:'正在重新连接',blocked:'平台关闭了连接',error:'连接异常'};
async function refresh() {
  if (!token) return;
  try {
    const state=await api('status');
    if (!state.ok) { feedback(state); return; }
    const transport=state.transport || {}, core=state.core || {};
    const limits=core.limits;
    $('sendLimits').textContent=limits?`本地今日 ${core.dailyAttempts}/${limits.dailyAttempts} 次、最近一分钟 ${core.minuteAttempts}/${limits.minuteAttempts} 次发送尝试；总计达到 ${limits.replyDailyAttempts} 次后，最后 ${limits.reservedNotifications} 次只供主动通知。`:'本地限额暂不可用。';
    const agent=state.agent||{};
    const campus=state.campus||{};
    $('campusState').textContent=(campus.configured?'校园凭据已加密保存':'尚未保存校园凭据')+' · '+(campus.enabled?'查询已启用':'查询未启用')+(campus.busy?' · 正在查询/验证':'')+(campus.lastCode?' · '+(descriptions[campus.lastCode]||campus.lastCode):'');
    if(!document.querySelector('#campusConfig:focus-within'))$('campusEnabled').checked=campus.enabled===true;
    $('agentState').textContent=(agent.configured?'模型 Key 已保存':'尚未配置模型 Key')+' · '+(agent.enabled?'自然语言已启用':'自然语言未启用')+' · '+(agent.model||'deepseek-flash');
    if(!document.querySelector('#agentConfig:focus-within')){$('agentEnabled').checked=agent.enabled===true;$('agentModel').value=agent.model||'deepseek-flash';}
    $('connection').textContent=states[transport.state] || '状态未知';
    $('connectionDot').className='dot'+(transport.state==='connected'?' online':'');
    $('stateDetails').textContent=(state.configured?'凭据已保存':'尚未配置凭据')+' · '+(core.paired?'已配对本人':'尚未配对')+' · '+(core.paused?'发送暂停':'发送可用')+(transport.code?' · '+transport.code:'');
    $('pairStatus').textContent=core.paired?'已绑定本人 '+(core.ownerHint||''):(core.pendingPairing?'已收到配对消息 '+(core.candidateHint||'')+'。确认这是你刚才发送的命令。':'尚未收到配对消息。');
    $('pairConfirm').disabled=!core.pendingPairing || core.paired;
    $('pairStart').disabled=core.paired || transport.state!=='connected';
    $('testNotify').disabled=!core.paired || core.paused || transport.state!=='connected';
    if(core.paired) $('pairBox').classList.add('hidden');
    const pendingGroup = core.pendingGroup;
    pendingGroupKey = pendingGroup?.groupKey || null;
    $('groupStart').disabled = !core.paired || core.paused || transport.state !== 'connected';
    $('groupConfirm').disabled = !pendingGroupKey || core.paused || transport.state !== 'connected';
    $('groupStatus').textContent = pendingGroup
      ? `已收到备注为“${pendingGroup.name}”的群内匹配指令。请确认它来自你刚才操作的目标群。`
      : core.pendingGroupPairing ? '等待目标群发送绑定命令。' : '尚无待确认群。';
    if (!core.pendingGroupPairing || pendingGroup) $('groupCodeBox').classList.add('hidden');
    groupConsole.update(core,transport,state.groupMorning,state.groupConnections);
    weatherAlertsConsole.update(state.weatherAlerts);
    wakeWordConsole.update(core);
    void refreshMonitoring();
  } catch { $('connection').textContent='本地服务不可达'; }
}
async function action(route,data={}) { try { const result=await api(route,data); feedback(result); await refresh(); return result; } catch { feedback({ok:false,code:'OPERATION_FAILED'}); } }
if (!token) { $('locked').classList.remove('hidden'); $('workspace').classList.add('hidden'); }
else {
  $('monitoringConfig').addEventListener('input',()=>{monitoringDirty=true;});
  $('monitoringConfig').addEventListener('submit',async event=>{
    event.preventDefault();
    const value={enabled:$('monitoringEnabled').checked,project:$('monitoringProject').value.trim(),endpoint:$('monitoringEndpoint').value,workspaceId:$('monitoringWorkspace').value.trim()};
    if($('monitoringKey').value.trim())value.apiKey=$('monitoringKey').value.trim();
    $('monitoringKey').value='';
    const result=await action('monitoring/config',value);
    if(result?.ok){monitoringDirty=false;await refreshMonitoring({force:true});}
  });
  $('monitoringRefresh').onclick=()=>refreshMonitoring();
  $('monitoringTest').onclick=async()=>{await action('monitoring/test',{});await refreshMonitoring();};
  let jsonObjectUrl;
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  $('campusDate').value=today;$('campusDate').min=today;$('campusDate').max=new Date(Date.now()+8*3600000+7*86400000).toISOString().slice(0,10);
  $('campusConfig').addEventListener('submit',async event=>{
    event.preventDefault();
    const value={enabled:$('campusEnabled').checked};
    const username=$('campusUsername').value.trim(),password=$('campusPassword').value;
    if(username||password){value.username=username;value.password=password;}
    $('campusUsername').value='';$('campusPassword').value='';
    await action('campus/config',value);
  });
  async function campusAction(mode){
    const buttons=['campusQuery','campusBriefing','campusLogin'];buttons.forEach(id=>$(id).disabled=true);
    if(jsonObjectUrl){URL.revokeObjectURL(jsonObjectUrl);jsonObjectUrl=null;}
    $('campusDownload').classList.add('hidden');$('campusDownload').removeAttribute('href');
    try{
      $('campusOutput').textContent='正在查询，结果将在完成后显示。';
      const result=await api('campus/'+mode,{date:$('campusDate').value,...(mode==='briefing'?{requestId:crypto.randomUUID().replaceAll('-','')}:{})});
      const data=result.data||result;
      if(data.schema_version==='buaa-classrooms.v1'){
        const json=JSON.stringify(data,null,2);$('campusOutput').textContent=json;
        if(jsonObjectUrl)URL.revokeObjectURL(jsonObjectUrl);
        jsonObjectUrl=URL.createObjectURL(new Blob([json],{type:'application/json;charset=utf-8'}));
        $('campusDownload').href=jsonObjectUrl;$('campusDownload').download='xueyuanlu-'+(data.date||today)+'.json';$('campusDownload').classList.remove('hidden');
      }else{$('campusOutput').textContent=JSON.stringify(result,null,2);}
      feedback(result);await refresh();
    }catch{feedback({ok:false,code:'CAMPUS_QUERY_FAILED'});$('campusOutput').textContent='本次查询未完成。';}
    finally{buttons.forEach(id=>$(id).disabled=false);}
  }
  $('campusQuery').onclick=()=>campusAction('query');$('campusBriefing').onclick=()=>campusAction('briefing');$('campusLogin').onclick=()=>campusAction('login');
  $('agentConfig').addEventListener('submit',async event=>{
    event.preventDefault();
    const value={enabled:$('agentEnabled').checked,model:$('agentModel').value.trim()};
    if($('agentKey').value.trim())value.apiKey=$('agentKey').value.trim();
    $('agentKey').value='';await action('agent/config',value);
  });
  $('credentials').addEventListener('submit',async event=>{
    event.preventDefault();
    const value={appId:$('appId').value.trim(),appSecret:$('appSecret').value.trim()};
    $('appSecret').value='';
    await action('config',value);
  });
  $('connect').onclick=()=>action('connect'); $('disconnect').onclick=()=>action('disconnect');
  $('refresh').onclick=refresh;
  $('pairStart').onclick=async()=>{const result=await action('pair/start');if(result?.ok&&result.code){
    const code=result.pairingCode;
    if(code){$('pairCommand').textContent='/pair '+code;$('pairBox').classList.remove('hidden');}
  }};
  $('pairConfirm').onclick=()=>action('pair/confirm'); $('testNotify').onclick=()=>action('test-notify');
  $('pause').onclick=()=>action('pause',{paused:true}); $('resume').onclick=()=>action('pause',{paused:false});
  $('groupStart').onclick=async()=>{
    const result = await action('group/start', { name: $('groupName').value.trim(),access:$('groupAccess').value });
    if (result?.ok && result.groupPairingCode) {
      $('groupCommand').textContent = '/group-bind ' + result.groupPairingCode;
      $('groupCodeBox').classList.remove('hidden');
    }
  };
  $('groupConfirm').onclick=async()=>{
    const groupKey=pendingGroupKey;
    if(!groupKey)return;
    const result=await action('group/confirm',{groupKey,features:groupConsole.enrollmentFeatures()});
    if(result?.ok)groupConsole.selectGroup(groupKey);
  };
  $('groupCopy').onclick=async()=>{
    try {await navigator.clipboard.writeText($('groupCommand').textContent);feedback({ok:true,code:'GROUP_COMMAND_COPIED'});}
    catch {$('groupCommand').focus();feedback({ok:false,code:'GROUP_COPY_MANUALLY'});}
  };
  $('groupCancel').onclick=()=>action('group/cancel');
  refresh(); setInterval(refresh,3000);
}

