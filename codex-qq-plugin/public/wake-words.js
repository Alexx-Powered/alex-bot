window.createWakeWordEditor = ({container,action,groupKey=null}) => {
  let words=[],revision=-1,savedDisabled=[],dirty=false,busy=false,signature='';
  const disabled=new Set(),textDrafts=new Map();
  const element=(tag,className,text)=>{
    const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;
  };
  function button(text,handler,danger=false) {
    const node=element('button','subtle'+(danger?' danger':''),text);node.type='button';node.disabled=busy;node.onclick=handler;return node;
  }
  async function mutate(route,data,{groupSave=false}={}) {
    if(busy)return;
    busy=true;draw();
    try {
      const result=await action(route,data);
      if(result?.ok&&result.status) {
        if(groupSave)dirty=false;
        update(result.status);
      }
      return result;
    } finally {busy=false;draw();}
  }
  function draw() {
    container.replaceChildren();container.classList.add('wake-word-manager');
    if(groupKey)container.append(element('h3',null,'本群唤醒词'));
    container.append(element('p','help',groupKey?
      '开关只影响当前群，修改后保存本群设置。增删改唤醒词会同步到所有群。':
      '这里是全局词库。在任何页面增删改都会同步；每个群可以单独开关。'));
    const list=element('div','wake-word-list');
    if(!words.length)list.append(element('p','help','暂无唤醒词。群内仍可直接 @ 机器人。'));
    for(const word of words) {
      const row=element('div','wake-word-row');
      const input=element('input','wake-word-text');input.type='text';input.maxLength=48;input.autocomplete='off';
      input.value=textDrafts.get(word.id)??word.text;input.disabled=busy;
      input.setAttribute('aria-label','唤醒词：'+word.text);
      input.oninput=()=>textDrafts.set(word.id,input.value);
      row.append(input);
      if(groupKey) {
        const toggle=element('input','ios-switch');toggle.type='checkbox';toggle.role='switch';toggle.checked=!disabled.has(word.id);toggle.disabled=busy;
        toggle.setAttribute('aria-label','在本群启用“'+word.text+'”');
        toggle.onchange=()=>{dirty=true;if(toggle.checked)disabled.delete(word.id);else disabled.add(word.id);};
        row.append(toggle);
      }
      const actions=element('div','wake-word-actions');
      actions.append(button('全局改名',()=>mutate('wake-words/rename',{id:word.id,text:textDrafts.get(word.id)??word.text,revision})),
        button('全局删除',()=>mutate('wake-words/delete',{id:word.id,revision}),true));
      row.append(actions);list.append(row);
    }
    container.append(list);
    const add=element('form','wake-word-add');
    const input=element('input');input.type='text';input.required=true;input.maxLength=48;input.autocomplete='off';input.placeholder='输入新的唤醒词';
    input.setAttribute('aria-label',groupKey?'在群页新增全局唤醒词':'新增全局唤醒词');input.disabled=busy;
    const submit=element('button','subtle','全局添加');submit.type='submit';submit.disabled=busy;
    add.append(input,submit);add.onsubmit=event=>{event.preventDefault();void mutate('wake-words/add',{text:input.value,revision});};
    container.append(add,element('p','help wake-word-footnote','最多 32 个，每个 1–24 字，不含空白；英文不区分大小写。新增词默认在所有群开启。唤醒时在词后加空格和问题。'));
    if(groupKey) {
      const footer=element('div','wake-word-save');
      footer.append(element('span','help','仅保存本群开关，@ 机器人始终可用。'),
        button('保存本群唤醒设置',()=>mutate('group/wake-words',{groupKey,disabledWakeWords:[...disabled],revision},{groupSave:true})));
      container.append(footer);
    }
  }
  function update(core,group) {
    group=group??[...(core.allowedGroups||[]),...(core.grayGroups||[])].find(g=>g.groupKey===groupKey);
    const nextWords=core.wakeWords||[],nextDisabled=group?.disabledWakeWords||[];
    const nextSignature=JSON.stringify([core.wakeWordRevision,nextWords,nextDisabled]);
    if(signature===nextSignature)return;
    signature=nextSignature;words=nextWords;revision=core.wakeWordRevision??0;savedDisabled=nextDisabled;
    if(!dirty){disabled.clear();for(const id of savedDisabled)disabled.add(id);}
    const ids=new Set(words.map(word=>word.id));
    for(const id of disabled)if(!ids.has(id))disabled.delete(id);
    for(const [id,value] of textDrafts)if(!ids.has(id)||words.find(word=>word.id===id)?.text===value)textDrafts.delete(id);
    draw();
  }
  return {update};
};
