window.createGroupConsole = ({api,action}) => {
  const get=id=>document.getElementById(id);
  const sections=[
    {title:'聊天与理解',items:[
      {keys:['chat'],label:'模型聊天',hint:'自然对话与日常问答'},
      {keys:['images'],label:'图片理解',hint:'识图、表情包与图中文字'},
      {keys:['voice'],label:'语音理解',hint:'将语音转成文字后处理'},
      {keys:['memory'],label:'成员记忆',hint:'保留成员偏好，支持个人清空'},
    ]},
    {title:'查询与工具',items:[
      {keys:['conversion'],label:'固定换算',hint:'古月币、马里、马时与常用单位换算'},
      {keys:['weather','air'],label:'天气预报与空气质量',hint:'两日天气、空气质量、预报视频和历史云图；徒步沿线天气、营地睡袋与住店方案'},
      {keys:['radar'],label:'雷达',hint:'当前降水雷达与站点目录'},
      {keys:['campus'],label:'校园与教室',hint:'空教室、自习推荐与三号楼简报'},
      {keys:['status'],label:'AI服务状态',hint:'AI 平台可用性与服务状态查询'},
      {keys:['balance'],label:'DeepSeek余额',hint:'主人已配置的 DeepSeek API 余额'},
    ]},
    {title:'定时推送',items:[
      {keys:['morningWeather'],label:'早间天气',hint:'每天 07:30 · 天气、空气与运动建议'},
      {keys:['morningCampus'],label:'三号楼自习简报',hint:'每天 07:30 · 三号楼空教室与自习安排'},
    ]},
  ];
  let catalog=[],defaults={},directory=[],groups=[],signature='',selected,ready=false,busy=false,initialized=false;
  let wakeEditor=null,lastCore={},groupPanel='features';
  let connections={groups:[],directory:[]},connectionSignature='';
  const channelName={official:'官方 Bot',milky:'普通 QQ · NoneBot'};
  const routeFor=group=>connections.groups.find(row=>row.groupKey===group.groupKey);
  const baselines=new WeakMap();
  const settingsSignature=({disabledWakeWords,name,...group})=>JSON.stringify(group);
  function read(container) {
    const value={...baselines.get(container)};
    for (const input of container.querySelectorAll('input[data-features]')) {
      if (input.dataset.changed==='true') for (const key of input.dataset.features.split(',')) value[key]=input.checked;
    }
    return value;
  }
  function switchInput(name,checked) {
    const input=document.createElement('input');
    input.type='checkbox';input.role='switch';input.className='ios-switch';
    input.setAttribute('aria-label',name);input.checked=checked;
    return input;
  }
  function grid(container,features) {
    baselines.set(container,{...features});container.replaceChildren();
    for (const section of sections) {
      const items=section.items.filter(item=>item.keys.every(key=>catalog.some(feature=>feature.key===key)));
      if (!items.length) continue;
      const block=document.createElement('div');block.className='settings-block';
      const heading=document.createElement('h4');heading.textContent=section.title;
      const rows=document.createElement('div');rows.className='settings-rows';
      for (const item of items) {
        const row=document.createElement('label');row.className='setting-row';
        const copy=document.createElement('span');copy.className='setting-copy';
        const title=document.createElement('span');title.className='setting-title';title.textContent=item.label;
        const hint=document.createElement('span');hint.className='setting-hint';hint.textContent=item.hint;
        const input=switchInput(item.label,item.keys.some(key=>features[key]===true));
        input.dataset.features=item.keys.join(',');
        const partial=item.keys.some(key=>features[key]===true)&&!item.keys.every(key=>features[key]===true);
        if (partial) {
          const badge=document.createElement('span');badge.className='partial-badge';badge.textContent='部分开启';
          title.append(badge);hint.textContent='切换此开关后，两项功能同步开启或关闭。';
        }
        input.onchange=()=>{
          input.dataset.changed='true';title.querySelector('.partial-badge')?.remove();hint.textContent=item.hint;
        };
        copy.append(title,hint);row.append(copy,input);rows.append(row);
      }
      block.append(heading,rows);
      if (items.some(item=>item.keys.includes('weather'))) {
        const details=document.createElement('details');
        const summary=document.createElement('summary');summary.textContent='天气视频怎么发？';
        const examples=document.createElement('p');examples.className='help';
        examples.textContent='默认看未来 24 小时。发「发 云图 南京」看预报，发「发 48h动态温度 新疆」看两天。地点可换成城市、省区或大区。';
        const history=document.createElement('p');history.className='help';
        history.textContent='回看近 6 小时卫星观测，发「发 历史云图 南京」。';
        details.append(summary,examples,history);block.append(details);
      }
      container.append(block);
    }
  }
  function preset(container,all) {
    for (const input of container.querySelectorAll('input[data-features]')) {
      const keys=input.dataset.features.split(',');
      input.checked=all||keys.every(key=>defaults[key]===true);
      input.dataset.changed='true';input.closest('label').querySelector('.partial-badge')?.remove();
    }
  }
  function navigation() {
    get('groupNavigation').replaceChildren();
    for (const group of groups) {
      const button=document.createElement('button');button.type='button';button.className='group-nav-item';
      button.setAttribute('aria-pressed',String(selected===group.groupKey));
      const name=document.createElement('strong');name.textContent=group.name;
      const info=document.createElement('span');
      const route=routeFor(group);
      info.textContent=channelName[route?.active||'official']+(route?.number?' · 双通道':'')+' · '+(group.enabled===false?'已停用':'已启用');
      button.append(name,info);button.onclick=()=>select(group.groupKey);get('groupNavigation').append(button);
    }
    get('groupCount').textContent=String(groups.length);
    if(connections.directory.length){
      const details=document.createElement('details'),summary=document.createElement('summary');
      summary.textContent='普通 QQ 已加入、待关联（'+connections.directory.length+'）';
      const list=document.createElement('ul');
      for(const {name,number} of connections.directory){
        const item=document.createElement('li');item.textContent=name+' · '+number;list.append(item);
      }
      details.append(summary,list);get('groupNavigation').append(details);
    }
  }
  function renderConnection(group) {
    const panel=get('groupConnection');
    if(!panel||!group)return;
    const oldNumber=panel.querySelector('select')?.value;
    panel.replaceChildren();
    const route=routeFor(group)||{active:'official'};
    const label=document.createElement('strong');label.textContent='工作通道';
    const state=document.createElement('span');
    const online=route.active==='milky'?route.milkyOnline:connections.officialOnline;
    state.textContent=channelName[route.active]+' · '+(online?'在线':'离线');
    panel.append(label,state);
    const profile=document.createElement('p');profile.className='help';
    const names=route.names||{};
    const unavailable=route.profileState==='denied'?'官方接口未授权读取群名':route.profileState==='unavailable'?'官方暂未返回群名':'等待官方查询群名';
    profile.textContent=(names.official?'官方群名 '+names.official:names.milky?'普通 QQ 群名 '+names.milky:unavailable)+
      (route.number?' · 群号 '+route.number:' · 数字群号待核实');
    panel.append(profile);
    function button(text,fn,disabled=false) {
      const el=document.createElement('button');el.type='button';el.textContent=text;el.disabled=disabled;
      el.onclick=async()=>{el.disabled=true;try{await fn();}finally{el.disabled=false;}};return el;
    }
    if(route.number){
      const other=route.active==='official'?'milky':'official';
      const detail=document.createElement('span');detail.className='help';
      detail.textContent=channelName[other]+' '+((other==='milky'?route.milkyOnline:connections.officialOnline)?'在线':'离线');
      panel.append(detail,button('切换到'+channelName[other],()=>action('group/connection/select',{
        groupKey:group.groupKey,channel:other,revision:route.revision
      }),!(other==='milky'?route.milkyOnline:connections.officialOnline)));
      return;
    }
    const pair=connections.pairing;
    if(pair?.groupKey===group.groupKey){
      const help=document.createElement('p');help.className='help';
      help.textContent='在'+(pair.number?'群 '+(pair.name||'')+'（'+pair.number+'）':'要识别的群')+'中 @ 官方 Bot，发送下面的指令（五分钟内有效）。';
      const code=document.createElement('code');code.textContent=pair.command;
      const seen=document.createElement('span');seen.setAttribute('role','status');
      seen.textContent='官方 Bot '+(pair.official?'已收到':'等待中')+' · 普通 QQ '+(pair.milky?'已收到':'等待中');
      panel.append(help,code,seen,button('确认关联此群',()=>action('group/connection/confirm',{
        groupKey:group.groupKey,command:pair.command
      }),!pair.matched));
      if(pair.official&&pair.milky&&!pair.matched){
        const mismatch=document.createElement('span');mismatch.textContent=pair.ambiguous?'多个群收到同一指令，请重新匹配。':'两条消息时间不一致，请重新匹配。';
        panel.append(mismatch,button('重新生成匹配指令',()=>action('group/connection/verify',{groupKey:group.groupKey,number:''})));
      }
      return;
    }
    if(!connections.directory.length||!connections.online)return;
    const select=document.createElement('select'),caption=document.createElement('label');
    select.id='groupConnectionNumber';caption.htmlFor=select.id;caption.textContent='关联普通 QQ 群';
    select.add(new Option('通过群内指令自动识别群号',''));
    for(const {name,number} of connections.directory)select.add(new Option(name+' · '+number,number));
    if(connections.directory.some(g=>g.number===oldNumber))select.value=oldNumber;
    const verify=button('生成匹配指令',()=>action('group/connection/verify',{
      groupKey:group.groupKey,number:select.value
    }),!connections.officialOnline);
    panel.append(caption,select,verify);
  }
  function deliveryLog(group) {
    const panel=document.createElement('details');
    const summary=document.createElement('summary');
    summary.textContent='群聊日志';
    const list=document.createElement('ul');
    const status=document.createElement('p');
    status.className='help';status.setAttribute('role','status');
    const refresh=document.createElement('button');
    refresh.type='button';refresh.textContent='刷新日志';refresh.className='subtle';
    const time=new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Shanghai'});
    const reasons={
      QQ_TARGET_PERMISSION_DENIED:'该群发送权限被拒，请核对 QQ 群权限及机器人成员状态',
      PERMISSION_DENIED:'QQ 拒绝发送权限', QQ_SERVICE_UNAVAILABLE:'QQ 服务暂时不可用',
      RATE_LIMITED:'QQ 限流', DELIVERY_UNCERTAIN:'提交结果未确认', PLATFORM_REJECTED:'平台拒绝或未能提交',
    };
    async function load() {
      if(refresh.disabled)return;
      refresh.disabled=true;status.textContent='正在读取本群日志…';
      try {
        const data=await api('group/'+group.groupKey+'/delivery-log');
        if(!data.ok || !Array.isArray(data.entries))throw Error();
        list.replaceChildren();
        for(const entry of data.entries) {
          const item=document.createElement('li');
          const feature=catalog.find(f=>f.key===entry.feature)?.label || '群消息';
          const stage=entry.phase==='upload'?'上传':entry.phase==='send'?'提交':'';
          const fields=[time.format(entry.at),feature,stage,reasons[entry.code] || entry.code];
          if(entry.state==='uncertain' && entry.code!=='DELIVERY_UNCERTAIN')fields.push('回执未确认');
          if(entry.bizCode)fields.push('QQ '+entry.bizCode);
          if(entry.httpStatus)fields.push('HTTP '+entry.httpStatus);
          item.textContent=fields.filter(Boolean).join(' · ');list.append(item);
        }
        status.textContent=data.entries.length?'最近 '+data.entries.length+' 条发送失败或回执未确认记录（北京时间）':'暂无本群发送失败记录';
      } catch {
        status.textContent='本群日志读取失败，可以刷新重试。';
      } finally {refresh.disabled=false;}
    }
    refresh.onclick=load;panel.ontoggle=()=>{if(panel.open)void load();};
    panel.append(summary,status,list,refresh);
    return panel;
  }

  function renderEditor() {
    get('groupList').replaceChildren();
    wakeEditor=null;
    const group=groups.find(g=>g.groupKey===selected);
    if (!group) return;
    const form=document.createElement('form');form.className='group-card';form.dataset.groupKey=group.groupKey;
    const header=document.createElement('div');header.className='group-editor-heading';
    const heading=document.createElement('h3');heading.textContent=group.name;
    header.append(heading);
    const connectionPanel=document.createElement('section');connectionPanel.id='groupConnection';
    connectionPanel.className='group-connection';connectionPanel.setAttribute('aria-label','群连接方式');
    const enabledRow=document.createElement('label');enabledRow.className='setting-row group-enable';
    const enabledText=document.createElement('span');enabledText.className='setting-copy';
    const title=document.createElement('span');title.className='setting-title';title.textContent='启用这个群';
    const hint=document.createElement('span');hint.className='setting-hint';hint.textContent='停用后停止群内处理，保留功能设置';
    enabledText.append(title,hint);
    const enabled=switchInput('启用这个群',group.enabled!==false);enabledRow.append(enabledText,enabled);
    const features=document.createElement('div');features.className='feature-sections';grid(features,group.features||defaults);
    const {maxLength=240,maxLines=6,defaultWhenChatOff=''}=lastCore.groupHelpNote||{};
    const initialHelpNote=group.helpNote??(group.features?.chat===false?defaultWhenChatOff:'');
    const helpNoteLabel=document.createElement('label');helpNoteLabel.htmlFor='groupHelpNote';helpNoteLabel.textContent='帮助页备注';
    const helpNote=document.createElement('textarea');helpNote.id='groupHelpNote';helpNote.rows=3;
    helpNote.maxLength=maxLength;helpNote.value=initialHelpNote;helpNote.setAttribute('aria-describedby','groupHelpNoteHint');
    const helpNoteHint=document.createElement('p');helpNoteHint.id='groupHelpNoteHint';helpNoteHint.className='help';
    const helpNoteDescription=`显示在本群 /help 图片底部。清空后隐藏，最多 ${maxLength} 字、${maxLines} 行。`;
    helpNoteHint.textContent=helpNoteDescription;
    helpNote.oninput=()=>{helpNote.removeAttribute('aria-invalid');helpNoteHint.textContent=helpNoteDescription;};
    helpNoteLabel.append(helpNote);
    const controls=document.createElement('div');controls.className='actions group-savebar';
    const basic=document.createElement('button');basic.type='button';basic.className='subtle';basic.textContent='基础功能';basic.onclick=()=>preset(features,false);
    const all=document.createElement('button');all.type='button';all.className='subtle';all.textContent='全部开启';all.onclick=()=>preset(features,true);
    const save=document.createElement('button');save.type='submit';save.textContent='保存设置';
    const remove=document.createElement('button');remove.type='button';remove.className='subtle danger';remove.textContent='移除群';remove.onclick=()=>action('group/remove',{groupKey:group.groupKey});
    controls.append(basic,all,remove,save);
    const note=document.createElement('p');note.className='help settings-note';note.textContent='更改后点击保存。两个 07:30 推送独立开关；全部开启包含 DeepSeek 余额与两项定时推送。';
    const alertLink=document.createElement('button');alertLink.type='button';alertLink.className='secondary';alertLink.textContent='管理本群实时气象预警';
    alertLink.onclick=()=>document.dispatchEvent(new CustomEvent('weather-alerts-select',{detail:group.groupKey}));
    form.append(enabledRow,features,alertLink,helpNoteLabel,helpNoteHint,note,controls);
    form.onsubmit=async event=>{
      event.preventDefault();save.disabled=true;
      const result=await action('group/features',{groupKey:group.groupKey,enabled:enabled.checked,features:read(features),
        ...(helpNote.value!==initialHelpNote?{helpNote:helpNote.value}:{})});
      save.disabled=false;
      if(result?.code==='GROUP_HELP_NOTE_INVALID') {
        helpNote.setAttribute('aria-invalid','true');
        helpNoteHint.textContent=`请检查备注内容，限 ${maxLength} 字和 ${maxLines} 行。`;
        helpNote.focus();
      }
    };
    const navigation=document.createElement('nav');navigation.className='group-subnavigation';navigation.role='tablist';navigation.setAttribute('aria-label','本群设置');
    const featureTab=document.createElement('button'),wakeTab=document.createElement('button');
    featureTab.type=wakeTab.type='button';featureTab.role=wakeTab.role='tab';
    featureTab.textContent='功能开关';wakeTab.textContent='唤醒词设置';
    const wakeSection=document.createElement('section');wakeSection.className='group-wake-section';
    form.id='group-feature-settings';wakeSection.id='group-wake-settings';
    featureTab.id='group-feature-tab';wakeTab.id='group-wake-tab';
    featureTab.setAttribute('aria-controls',form.id);wakeTab.setAttribute('aria-controls',wakeSection.id);
    form.role=wakeSection.role='tabpanel';form.setAttribute('aria-labelledby',featureTab.id);wakeSection.setAttribute('aria-labelledby',wakeTab.id);
    const choose=panel=>{
      groupPanel=panel;form.classList.toggle('hidden',panel!=='features');wakeSection.classList.toggle('hidden',panel!=='wake');
      featureTab.setAttribute('aria-selected',String(panel==='features'));wakeTab.setAttribute('aria-selected',String(panel==='wake'));
    };
    featureTab.onclick=()=>choose('features');wakeTab.onclick=()=>choose('wake');
    for(const tab of [featureTab,wakeTab])tab.onkeydown=event=>{
      if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
      event.preventDefault();choose(groupPanel==='features'?'wake':'features');(groupPanel==='features'?featureTab:wakeTab).focus();
    };
    navigation.append(featureTab,wakeTab);get('groupList').append(header,connectionPanel,deliveryLog(group),navigation,form,wakeSection);renderConnection(group);choose(groupPanel);
    wakeEditor=window.createWakeWordEditor({container:wakeSection,action,groupKey:group.groupKey});
    wakeEditor.update(lastCore,group);
  }
  function select(key) {
    selected=key;
    get('groupEnrollment').classList.toggle('hidden',key!==null);get('groupList').classList.toggle('hidden',key===null);
    navigation();renderEditor();
  }
  get('groupAdd').onclick=()=>select(null);
  get('groupNewBasic').onclick=()=>preset(get('groupNewFeatures'),false);
  get('groupNewAll').onclick=()=>preset(get('groupNewFeatures'),true);
  return {
    selectGroup:key=>select(key),
    enrollmentFeatures:()=>read(get('groupNewFeatures')),
    update(core,transport,schedule={},channels) {
      lastCore=core;
      connections=channels??{groups:[],directory:[],officialOnline:transport.state==='connected'};
      const nextConnectionSignature=JSON.stringify(connections);
      const changed=nextConnectionSignature!==connectionSignature;connectionSignature=nextConnectionSignature;
      ready=core.paired&&!core.paused&&transport.state==='connected';
      get('managedGroups').classList.remove('hidden');
      get('groupMorningState').textContent=schedule.active?
        '北京时间 '+(schedule.prepareActive?schedule.prepareTime+' 准备 · ':'')+schedule.time+' 发送 · '+schedule.cutoffTime+' 截止 · 天气 '+(schedule.weatherGroups||0)+' 群 · 自习 '+(schedule.campusGroups||0)+' 群':'调度当前未运行';
      catalog=core.groupFeatureCatalog||[];defaults=core.groupDefaultFeatures||{};
      if (!initialized&&catalog.length) {grid(get('groupNewFeatures'),defaults);initialized=true;}
      const next=[...(core.allowedGroups||[]),...(core.grayGroups||[])];
      const previous=groups.find(g=>g.groupKey===selected);
      const current=next.find(g=>g.groupKey===selected);
      const nextSignature=JSON.stringify(next.map(settingsSignature));
      groups=next;
      if (signature!==nextSignature) {
        signature=nextSignature;
        if (selected===undefined||(selected!==null&&!current)) {select(groups[0]?.groupKey||null);return;}
        navigation();
        if (current&&(!previous||settingsSignature(current)!==settingsSignature(previous))) {renderEditor();return;}
      }
      if(changed||previous?.name!==current?.name){
        navigation();renderConnection(current);
        const title=get('groupList').querySelector('.group-editor-heading h3');
        if(current&&title)title.textContent=current.name;
      }
      wakeEditor?.update(core,current);
    },
  };
};
