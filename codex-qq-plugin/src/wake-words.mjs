export const WAKE_WORD_LIMITS = Object.freeze({count:32,length:24});
export const DEFAULT_WAKE_WORDS = Object.freeze(['梁圣','梁祖','梁嗨','小难梁','大肥鱼'].map((text,index)=>
  Object.freeze({id:'default-'+index,text})));
export const validWakeWordId = value => typeof value==='string'&&/^(?:default-[0-4]|[a-f0-9]{16})$/.test(value);
export const normalizeWakeWord = text => typeof text==='string'?text.trim().normalize('NFC'):null;
export const validWakeWordText = text => typeof text==='string'&&text===normalizeWakeWord(text)&&
  Array.from(text).length>=1&&Array.from(text).length<=WAKE_WORD_LIMITS.length&&!/[\s\p{Cc}\p{Cf}]/u.test(text);
export const wakeWordKey = text => text.toLowerCase();
export function validWakeWords(words) {
  return Array.isArray(words)&&words.length<=WAKE_WORD_LIMITS.count&&words.every(word=>word&&
    Object.keys(word).length===2&&validWakeWordId(word.id)&&validWakeWordText(word.text))&&
    new Set(words.map(word=>word.id)).size===words.length&&new Set(words.map(word=>wakeWordKey(word.text))).size===words.length;
}
export const validDisabledWakeWords = ids => Array.isArray(ids)&&ids.length<=WAKE_WORD_LIMITS.count&&
  ids.every(validWakeWordId)&&new Set(ids).size===ids.length;

// Literal leading words, followed by whitespace. Never compile user text as a regexp.
export function parseGroupWake(text,mentioned,words,disabled=[]) {
  const raw=text.trim().normalize('NFC');
  const word=words.find(word=>!disabled.includes(word.id)&&
    wakeWordKey(raw.slice(0,word.text.length))===wakeWordKey(word.text)&&/^\s+\S/u.test(raw.slice(word.text.length)));
  return {command:word?raw.slice(word.text.length).trimStart():raw,
    addressed:Boolean(word)||mentioned===true||/^\/(?:识图|记忆)(?:\s|$)/u.test(raw)};
}
