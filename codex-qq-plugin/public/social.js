const $=id=>document.getElementById(id);
const params=new URLSearchParams(location.hash.slice(1)),incoming=params.get('token');
if(incoming&&/^[0-9a-f]{64}$/u.test(incoming))sessionStorage.setItem('qq-local-token',incoming);
if(location.hash)history.replaceState(null,'','/social');
const token=sessionStorage.getItem('qq-local-token');
async function api(route,data){const r=await fetch('/api/social/'+route,{method:data?'POST':'GET',headers:{Authorization:'Bearer '+token,...data?{'Content-Type':'application/json'}:{}},body:data?JSON.stringify(data):undefined});if(!r.ok)throw Error('REQUEST_FAILED');return r.json();}
function show(c){$('socialEnabled').checked=c.enabled;$('socialWhite').checked=c.autoWhiteImages;$('socialMemes').checked=c.autoMemes;$('socialASR').checked=c.asrEnabled;$('socialStatus').textContent=c.asrConfigured?'语音 Key 已保存':'语音 Key 未配置；有 QQ 平台转写的语音仍可理解';}
if(!token)$('socialStatus').textContent='请先从带管理令牌的机器人设置页进入';
else api('status').then(r=>show(r.config)).catch(()=>$('socialStatus').textContent='暂时无法读取设置');
$('socialConfig').addEventListener('submit',async e=>{e.preventDefault();
 const data={enabled:$('socialEnabled').checked,autoWhiteImages:$('socialWhite').checked,autoMemes:$('socialMemes').checked,asrEnabled:$('socialASR').checked};
 if($('socialKey').value.trim())data.apiKey=$('socialKey').value.trim();$('socialKey').value='';
 try{const r=await api('config',data);if(r.ok){show(r.config);$('socialStatus').textContent='已加密保存，下次消息生效'}else $('socialStatus').textContent='保存失败；启用付费转写前需要填写百炼 Key';}catch{$('socialStatus').textContent='暂时无法保存设置';}
});
