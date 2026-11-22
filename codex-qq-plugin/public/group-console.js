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
  let selectionVersion=0;
  function navigation() {
    const nav=get('groupNavigation');
    const previousFocus=nav.contains(document.activeElement)?document.activeElement.dataset.navId:null;
    nav.replaceChildren();
    function add(id,title,description,pressed,onClick){
      const button=document.createElement('button');button.type='button';button.className='group-nav-item';
      button.dataset.navId=id;button.setAttribute('aria-pressed',String(pressed));
      const name=document.createElement('strong');name.textContent=title;
      const info=document.createElement('span');info.textContent=description;
      button.append(name,info);button.onclick=onClick;nav.append(button);
      if(id===previousFocus)button.focus({preventScroll:true});
    }
    for (const group of groups) {
      const route=routeFor(group);
      const both=route?.official==='present'&&route?.milky==='present';
      const info=(route?.active==='milky'?'普通 QQ':'官方 Bot')+'处理'+(both?' · 双端在群':'')+
        (group.enabled===false?' · 已停用':'');
      add(group.groupKey,group.name,info,selected===group.groupKey,()=>select(group.groupKey));
    }
    const discovered=connections.directory.filter(row=>!row.managed);
    const rosterKey=connections.rosterKey;
    for(const {name,number} of discovered){
      add('roster-'+number,name||'QQ 群 '+number,'普通 QQ · '+number+' · 打开设置',false,async event=>{
        const version=++selectionVersion;
        const button=event.currentTarget;button.disabled=true;
        try{
          const result=await action('group/connection/open',{number,rosterKey});
          if(result?.ok&&version===selectionVersion&&groups.some(g=>g.groupKey===result.groupKey)){
            select(result.groupKey);
            nav.querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
          }
        }finally{button.disabled=false;}
      });
    }
    get('groupCount').textContent=String(groups.length+discovered.length);
  }
  const presenceLabel={present:'已在群内',absent:'不在群内',offline:'账号离线',unknown:'暂未核实',
    candidate:'发现同名群',unverified:'待核对群号',unlinked:'未关联',otherAccount:'当前登录了其他账号'};
  function renderConnection(group) {
    const panel=get('groupConnection');
    if(!panel||!group)return;
    const previousNumber=panel.querySelector('select')?.value;
    const expanded=panel.querySelector('details')?.open;
    const focused=panel.contains(document.activeElement)?document.activeElement.id:null;
    const route=routeFor(group)||{active:'official'};
    const element=(tag,content,className)=>{
      const el=document.createElement(tag);
      if(content!==undefined)el.textContent=content;
      if(className)el.className=className;
      return el;
    };
    const button=(id,text,run,disabled=false)=>{
      const el=element('button',text,'secondary');
      el.type='button';el.id=id;el.disabled=disabled;
      el.onclick=async()=>{el.disabled=true;try{await run();}finally{el.disabled=disabled;}};
      return el;
    };
    const heading=element('div',undefined,'connection-heading');
    heading.append(element('h4','群内账号'),button('groupDetect','重新检测',()=>action('group/connection/detect',{groupKey:group.groupKey})));
    const accounts=element('div',undefined,'presence-grid');
    const names=route.names||{};
    for(const [key,label] of [['official','官方 Bot'],['milky','普通 QQ']]){
      const state=route[key]||'unknown';
      const row=element('div',undefined,'presence-row');
      row.append(element('strong',label));
      const badge=element('span',presenceLabel[state]||presenceLabel.unknown,'presence-status');
      badge.dataset.state=state;row.append(badge);accounts.append(row);
    }
    const controls=element('fieldset',undefined,'connection-choice');
    controls.append(element('legend','群消息工作通道'));
    const options=element('div',undefined,'connection-options');
    for(const [key,label] of [['official','官方 Bot'],['milky','普通 QQ']]){
      const option=element('label'),input=element('input');
      input.type='radio';input.name='selectedGroupConnection';input.id='channel-'+key;
      input.checked=route.active===key;
      input.disabled=!input.checked&&(!route.number||route[key]!=='present');
      const text=element('span',label);
      input.onchange=async()=>{
        if(!input.checked)return;
        const radios=Array.from(options.querySelectorAll('input'));
        const disabled=radios.map(el=>el.disabled);
        for(const el of radios)el.disabled=true;
        try{
          const result=await action('group/connection/select',{groupKey:group.groupKey,channel:key,revision:route.revision});
          if(!result?.ok&&options.isConnected)for(const el of radios)el.checked=el.id==='channel-'+route.active;
        }finally{if(options.isConnected)radios.forEach((el,i)=>{el.disabled=disabled[i];});}
      };
      option.append(input,text);options.append(option);
    }
    controls.append(options);
    panel.replaceChildren(heading,accounts,controls);
    const identity=[names.official&&names.official!==group.name?'官方群名 '+names.official:null,route.number?'已核实群号 '+route.number:null].filter(Boolean);
    if(identity.length)panel.append(element('p',identity.join(' · '),'help'));
    if(!route.number){
      const pair=connections.pairing;
      const report=connections.probeResult;
      if(report?.groupKey===group.groupKey&&!pair){
        const reason={GROUP_PROBE_AMBIGUOUS:'多个群收到了核验消息。',GROUP_PROBE_TIMEOUT:'核验超时，尚未确认群号。',
          GROUP_ROUTE_OFFLINE:'核验期间连接中断。',QQ_TARGET_PERMISSION_DENIED:'QQ 拒绝向该群发送核验消息。',
          DELIVERY_UNCERTAIN:'核验消息的发送结果尚未确认。',RATE_LIMITED:'QQ 限制了本次发送。'};
        panel.append(element('p',reason[report.code]||'核验未完成，可以使用群内口令。','help'));
      }
      if(pair?.groupKey===group.groupKey){
        const box=element('div',undefined,'connection-verify');
        if(pair.mode==='probe'){
          const status=element('p',pair.matched?'普通 QQ 在「'+pair.name+'」（'+pair.number+'）收到了核验消息。':'正在等待普通 QQ 收到本群核验消息…');
          status.setAttribute('role','status');box.append(status);
        }else{
          box.append(element('p','在目标群 @ 官方 Bot，发送下面的指令。'),element('code',pair.command));
          box.append(element('p','官方 Bot '+(pair.official?'已收到':'等待中')+' · 普通 QQ '+(pair.milky?'已收到':'等待中'),'help'));
          if(pair.number)box.append(element('p','识别的群号 '+pair.number,'help'));
        }
        if(pair.matched)box.append(button('groupConfirm','确认群号并关联',()=>action('group/connection/confirm',{groupKey:group.groupKey,command:pair.command})));
        if(pair.ambiguous||(pair.official&&pair.milky&&!pair.matched))box.append(button('groupRetry','重新生成口令',()=>action('group/connection/verify',{groupKey:group.groupKey,number:''})));
        panel.append(box);
      }else if(connections.online&&connections.directory.length){
        const candidates=route.candidates||[];
        if(candidates.length)panel.append(element('p','同名候选：'+candidates.map(g=>g.name+'（'+g.number+'）').join('、'),'help'));
        if(route.canProbe)panel.append(button('groupProbe','向本群发送一条核验消息',()=>action('group/connection/probe',{groupKey:group.groupKey}),!!pair));
        const details=element('details'),summary=element('summary','使用群内口令核对群号');
        const select=element('select'),caption=element('label','目标普通 QQ 群');
        select.id='groupConnectionNumber';caption.htmlFor=select.id;
        select.add(new Option('自动识别群号',''));
        for(const {name,number} of connections.directory)select.add(new Option(name+' · '+number,number));
        if(connections.directory.some(g=>g.number===previousNumber))select.value=previousNumber;
        details.append(summary,caption,select,button('groupVerify','生成匹配指令',()=>action('group/connection/verify',{groupKey:group.groupKey,number:select.value}),
          !!pair||['offline','absent'].includes(route.official)));
        details.open=!!expanded;panel.append(details);
      }
    }
    if(focused)document.getElementById(focused)?.focus({preventScroll:true});
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
    selectionVersion++;
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
