import {readFile} from 'node:fs/promises';

export function parseChatPolicy(markdown){
  if(typeof markdown!=='string'||Buffer.byteLength(markdown)>16384)throw new Error('CHAT_POLICY_INVALID');
  const match=/^---\r?\nchat_enabled: (true|false)\r?\nallowed_topics: (\[[^\r\n]*\])\r?\nmax_reply_chars: (\d+)\r?\n---\r?\n([\s\S]*)$/.exec(markdown.replace(/^\uFEFF/,''));
  if(!match)throw new Error('CHAT_POLICY_INVALID');
  const topics=JSON.parse(match[2]),maxChars=Number(match[3]);
  if(!Array.isArray(topics)||topics.length>20||topics.some(t=>typeof t!=='string'||!t.trim()||t.length>40)||new Set(topics).size!==topics.length||maxChars<1||maxChars>1000)throw new Error('CHAT_POLICY_INVALID');
  return {enabled:match[1]==='true'&&topics.length>0,topics,maxChars,instructions:match[4].trim()};
}
export async function loadChatPolicy(file){return parseChatPolicy(await readFile(file,'utf8'));}

export const cleanChatText=text=>typeof text==='string'?text.replace(/<[@#][^>]*>|@(everyone|全体成员|所有人)/gi,'').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').trim():'';
