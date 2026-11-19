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
  const baselines=new WeakMap();
  const settingsSignature=({disabledWakeWords,...group})=>JSON.stringify(group);
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
      const info=document.createElement('span');info.textContent=(group.groupNumber||'已登记群')+' · '+(group.enabled===false?'已停用':'已启用');
      button.append(name,info);button.onclick=()=>select(group.groupKey);get('groupNavigation').append(button);
    }
    get('groupCount').textContent=String(groups.length);
  }
  function renderEditor() {
    get('groupList').replaceChildren();
    wakeEditor=null;
    const group=groups.find(g=>g.groupKey===selected);
    if (!group) return;
    const form=document.createElement('form');form.className='group-card';form.dataset.groupKey=group.groupKey;
    const header=document.createElement('div');header.className='group-editor-heading';
    const heading=document.createElement('h3');heading.textContent=group.name;
    const detail=document.createElement('p');detail.className='help';detail.textContent=group.groupNumber?'群号 '+group.groupNumber:'QQ 官方机器人群';
    header.append(heading,detail);
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
    navigation.append(featureTab,wakeTab);get('groupList').append(header,navigation,form,wakeSection);choose(groupPanel);
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
    update(core,transport,schedule={}) {
      lastCore=core;
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
      wakeEditor?.update(core,current);
    },
  };
};
