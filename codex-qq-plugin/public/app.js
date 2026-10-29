const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.hash.slice(1));
const incoming = params.get('token');
if (incoming && /^[0-9a-f]{64}$/.test(incoming)) sessionStorage.setItem('qq-local-token', incoming);
if (location.hash) history.replaceState(null, '', '/');
const token = sessionStorage.getItem('qq-local-token');
let pendingGroupKey = null;
const descriptions = {
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
  GROUP_PAIRING_STARTED:'群绑定码已生成，请只在指定群发送。机器人需有接收所有消息权限。',
  GROUP_PAIRING_CANCELLED:'已取消待绑定群。', GROUP_ALLOWED:'这个群已加入白名单。', GROUP_REMOVED:'已移出群权限名单。',
  GROUP_PAIRING_EXPIRED:'群绑定码已过期，请重新生成。', NO_GROUP_PAIRING_CANDIDATE:'尚未收到有效的群绑定消息。',
  GROUP_PAIRING_KEY_MISMATCH:'待确认群已变化，请刷新并重新核对。', GROUP_ALREADY_ALLOWED:'这个群已在权限名单中，可在列表切换档位。',
  GROUP_LIMIT_REACHED:'所选名单已达10群的本地上限。', GROUP_NOT_FOUND:'这个群已不在权限名单中。', INVALID_INPUT:'请检查输入内容。',
};
function feedback(data) {
  const success = data?.ok === true;
  $('feedback').className = success ? 'success' : 'error';
  $('feedback').textContent = descriptions[data?.code] || (success ? '操作完成：' : '操作未完成：') + (data?.code || 'UNKNOWN');
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
      ? `收到“${pendingGroup.name}”${pendingGroup.access==='gray'?'灰名单':'白名单'}绑定请求（${pendingGroup.groupHint}）。请确认它来自你指定的群。`
      : core.pendingGroupPairing ? '等待目标群发送绑定命令。' : '尚无待确认群。';
    if (!core.pendingGroupPairing || pendingGroup) $('groupCodeBox').classList.add('hidden');
    $('groupList').replaceChildren();
    for (const [access,groups] of [['white',core.allowedGroups||[]],['gray',core.grayGroups||[]]]) for (const group of groups) {
      const row = document.createElement('p');
      const name = document.createElement('span'); name.textContent = `${group.name} · ${access==='white'?'白名单：全部业务':'灰名单：聊天与换算'} · ${group.groupHint} `;
      const change=document.createElement('button');change.className='secondary';change.textContent=access==='white'?'改为灰名单':'改为白名单';
      change.onclick=()=>action('group/access',{groupKey:group.groupKey,access:access==='white'?'gray':'white'});
      const remove = document.createElement('button'); remove.className = 'subtle'; remove.textContent = '移出名单';
      remove.onclick = () => action('group/remove', { groupKey: group.groupKey });
      row.append(name, change, remove); $('groupList').append(row);
    }
  } catch { $('connection').textContent='本地服务不可达'; }
}
async function action(route,data={}) { try { const result=await api(route,data); feedback(result); await refresh(); return result; } catch { feedback({ok:false,code:'OPERATION_FAILED'}); } }
if (!token) { $('locked').classList.remove('hidden'); $('workspace').classList.add('hidden'); }
else {
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
  $('groupConfirm').onclick=()=> pendingGroupKey && action('group/confirm', { groupKey: pendingGroupKey });
  $('groupCancel').onclick=()=>action('group/cancel');
  refresh(); setInterval(refresh,3000);
}

