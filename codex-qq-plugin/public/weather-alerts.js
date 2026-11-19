/* Subscriptions are scoped to the selected conversation, never a typed QQ ID. */
window.createWeatherAlertsConsole=({api,refresh})=>{
  const get=id=>document.getElementById(id);let snapshot,selected,signature='',busy=false;
  const status=get('alertFeedback'),list=get('alertRegions'),select=get('alertTarget');
  const messages={ALERT_SOURCE_PARTIAL:'部分官方来源暂不可用，下次检查会重试。',ALERT_SAVED:'已保存。',ALERT_CONFIG_CHANGED:'设置已变化，请刷新后重试。',ALERT_LIMIT:'每个聊天最多订阅 5 个地区。',ALERT_TARGET_DENIED:'请先为这个群开启天气功能。',ALERT_AREA_NOT_SUBSCRIBED:'此地区尚未订阅。',ALERT_SOURCE_UNAVAILABLE:'官方数据暂不可用，下次检查会重试。',ALERT_STORAGE_INVALID:'订阅文件读取失败，请联系维护者。'};
  const hint=s=>{status.textContent=s;};
  const button=(label,fn)=>{const b=document.createElement('button');b.type='button';b.className='subtle';b.textContent=label;b.onclick=fn;return b;};
  const toggle=(label,checked,fn)=>{const input=document.createElement('input');input.type='checkbox';input.role='switch';input.className='ios-switch';input.setAttribute('aria-label',label);input.checked=checked;input.onchange=()=>fn(input.checked);return input;};
  async function save(value){if(busy)return;busy=true;list.setAttribute('aria-busy','true');hint('正在保存…');
    try{const r=await api('weather-alerts/configure',{targetKey:selected,revision:snapshot.revision,...value});hint(messages[r.code]|| (r.ok?'已保存。':'保存失败，请重试。'));await refresh();}
    catch{hint('保存失败，请重试。');}finally{busy=false;list.removeAttribute('aria-busy');render();}}
  function render(){
    if(!snapshot)return;const target=snapshot.targets.find(t=>t.key===selected);
    list.replaceChildren();get('alertMaster').checked=target?.enabled===true;get('alertMaster').disabled=!target||busy||!target.allowed;
    get('alertSearchButton').disabled=!target||busy||!target.allowed;
    get('alertScopeHint').textContent=!target?.allowed?'请先开启本群天气功能。':'';
    get('alertScopeHint').hidden=!!target?.allowed;
    for(const r of target?.regions||[]){const row=document.createElement('div');row.className='setting-row';const copy=document.createElement('span');copy.className='setting-copy';
      const title=document.createElement('strong');title.className='setting-title';title.textContent=r.name;
      const help=document.createElement('span');help.className='setting-hint';help.textContent=r.level==='province'?'省级发布单位的预警':r.level==='city'?'本市、所辖区县及省级预警':'本区县及所属市、省级预警';copy.append(title,help);const coverage=snapshot.health?.coverage?.find(c=>c.code===r.code);if(coverage?.heavyPollution==='source_not_verified'){const note=document.createElement('span');note.className='setting-hint';note.textContent='重污染公告来源待接入；气象预警继续订阅';copy.append(note);}
      const controls=document.createElement('span');controls.className='alert-region-controls';
      const sw=toggle(r.name+'实时预警',r.enabled,enabled=>save({operation:'toggle',code:r.code,enabled}));sw.disabled=busy||!target.allowed;
      const remove=button('删除',()=>save({operation:'remove',code:r.code}));remove.disabled=busy;controls.append(sw,remove);row.append(copy,controls);list.append(row);}
    if(!target?.regions.length){const p=document.createElement('p');p.className='help';p.textContent='尚未添加地区';list.append(p);}
  }
  select.onchange=()=>{selected=select.value;get('alertSearchResults').replaceChildren();render();};
  get('alertMaster').onchange=()=>save({operation:'master',enabled:get('alertMaster').checked});
  get('alertSearchForm').onsubmit=async e=>{e.preventDefault();if(busy)return;const query=get('alertQuery').value.trim();if(!query)return;
    busy=true;get('alertSearchButton').disabled=true;hint('正在匹配地区…');get('alertSearchResults').replaceChildren();
    try{const r=await api('weather-alerts/search',{query});if(!r.ok){hint(messages[r.code]||'地区匹配服务暂不可用，请重试。');return;}const results=r.suggestions||[];hint(results.length?'点击地区添加':'未找到，请补充省、市或区县名称。');
      for(const place of results){get('alertSearchResults').append(button(place.name,async()=>{await save({operation:'add',code:place.code});get('alertSearchResults').replaceChildren();}));}
    }catch{hint('匹配失败，请重试。');}finally{busy=false;render();}};
  document.addEventListener('weather-alerts-select',e=>{const t=snapshot?.targets.find(t=>t.groupKey===e.detail);if(t){selected=t.key;select.value=selected;render();}get('nav-alerts').click();});
  return {update(value){if(!value)return;snapshot=value;
    const next=JSON.stringify([value.targets,value.health?.coverage]);if(next!==signature){signature=next;select.replaceChildren();for(const t of value.targets){const o=document.createElement('option');o.value=t.key;o.textContent=t.name;select.append(o);}
      if(!value.targets.some(t=>t.key===selected))selected=value.targets[0]?.key;select.value=selected||'';if(!busy)render();}
    const h=value.health||{},when=h.lastSuccessAt?new Date(h.lastSuccessAt).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}):'';
    get('alertHealth').textContent=(when?`更新于 ${when}`:'')+(h.lastCode&&h.lastCode!=='OK'?`${when?' · ':''}${messages[h.lastCode]||h.lastCode}`:'')+(h.pending?` · 待发送 ${h.pending} 条`:'');
    get('alertHealth').hidden=!get('alertHealth').textContent;
    if(!value.ok)hint(messages[value.code]||'预警设置暂不可用。');
  }};
};
