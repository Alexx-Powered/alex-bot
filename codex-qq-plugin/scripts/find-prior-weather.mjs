import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const base='C:/Users/Alex/.codex/sessions';
const re=/CAMS|天气.{0,10}API|API.{0,10}天气|天气.{0,10}爬虫|爬虫.{0,10}天气/i;
async function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){await scan(p);continue;}if(!e.name.endsWith('.jsonl')||e.name.includes('01a1819a-113f-7e00-bc91-971f98e7c0f4'))continue;for await(const line of readline.createInterface({input:fs.createReadStream(p),crlfDelay:Infinity})){if(!re.test(line))continue;let j;try{j=JSON.parse(line)}catch{continue}const v=j.payload;if(j.type==='response_item'&&v?.type==='message'&&v?.role==='user'){const text=v.content?.map(x=>x.text||'').join(' ')||''; if(re.test(text))console.log(JSON.stringify({file:p,text:text.slice(0,1800)}));}}}}
await scan(base);
