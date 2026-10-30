// Pure QQ attachment projection. Text URLs and quoted msg_elements are never attachments.
const hosts=['qpic.cn','gtimg.cn','gtimg.com','multimedia.nt.qq.com','multimedia.nt.qq.com.cn','qqbot.ugcimg.cn'];
export function qqMediaURL(value){
  if(typeof value!=='string'||value.length>4096||/\s/u.test(value))return null;
  if(value.startsWith('//'))value='https:'+value;
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==='443')&&hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h))?u.href:null;}catch{return null;}
}
export function incomingMedia(attachments){
  if(!Array.isArray(attachments))return [];
  return attachments.slice(0,4).flatMap(a=>{
    if(!a||typeof a!=='object')return [];
    const type=String(a.content_type||'').toLowerCase().split(';')[0];
    const kind=(type==='image'||type.startsWith('image/'))?'image':type==='voice'||type==='audio'||type.startsWith('audio/')||a.voice_wav_url||a.asr_refer_text?'audio':null;
    if(!kind)return [];
    const url=qqMediaURL(kind==='audio'?(a.voice_wav_url||a.url):a.url);
    const transcript=typeof a.asr_refer_text==='string'?a.asr_refer_text.slice(0,2000):'';
    if(!url&&!transcript)return [];
    return [{kind,url:url||'',...(transcript?{transcript}:{}),...(type==='image/gif'?{animated:true}:{})}];
  });
}
export function copyIncomingMedia(media){
  if(!Array.isArray(media))return [];
  return media.slice(0,4).flatMap(a=>{
    if(!a||!['image','audio'].includes(a.kind))return [];
    const url=qqMediaURL(a.url);
    const transcript=a.kind==='audio'&&typeof a.transcript==='string'?a.transcript.slice(0,2000):'';
    return url||transcript?[{kind:a.kind,url:url||'',...(transcript?{transcript}:{}),...(a.animated===true?{animated:true}:{})}]:[];
  });
}
