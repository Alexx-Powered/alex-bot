import {createCanvas} from '@napi-rs/canvas';
import {WEATHER_REPORT_STYLE as W} from './weather-report-image.mjs';
import {encodePngTiles} from './png-strips.mjs';

const FONT='Weather Noto, Alex CJK, sans-serif';
const palette={白色:['#52616b','#70828f','#f1f5f7'],蓝色:['#17446b','#286791','#e7f1fa'],黄色:['#795b16','#997321','#fff4d5'],
  橙色:['#80431e','#b66a2c','#fff0e3'],红色:['#802e36','#a9444a','#fbe9e8'],未分色:['#14343c','#1c5558','#e5efed']};
const text=(c,s,x,y,size=14,color=W.ink,weight=400)=>{c.font=`${weight} ${size}px ${FONT}`;c.fillStyle=color;c.fillText(s,x,y);};
function lines(c,s,size,width,weight=400){c.font=`${weight} ${size}px ${FONT}`;const result=[];
  for(const paragraph of String(s).split(/\r?\n/)){let line='';for(const ch of paragraph){if(line&&c.measureText(line+ch).width>width){
    const chars=[...line],carry=/^[，。；：！？、）》】」』）,.!?;:)\]]$/.test(ch)&&chars.length>1?chars.pop():'';
    result.push(chars.join(''));line=carry;
  }line+=ch;}if(line)result.push(line);}
  return result;
}
const box=(c,x,y,w,h,fill,r=18)=>{c.fillStyle=fill;c.beginPath();c.roundRect(x,y,w,h,r);c.fill();};
const stamp=s=>Number.isFinite(Date.parse(s))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(s)):'—';
const publicationParts=s=>Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(new Date(s)).map(p=>[p.type,p.value]));
const samePublication=(match,parts)=>(!match[1]||+match[1]===+parts.year)&&+match[2]===+parts.month&&+match[3]===+parts.day&&+match[4]===+parts.hour&&+(match[5]||0)===+parts.minute;
function parentCopy(p){
  const headline=String(p.headline).replace(/[。.]$/,'');
  const date=headline.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日\s*(\d{1,2})时(?:(\d{1,2})分)?/);
  const compact=date&&Number.isFinite(Date.parse(p.publishedAt))&&samePublication(date,publicationParts(p.publishedAt))?headline.replace(date[0],''):headline;
  return `${compact}（${stamp(p.publishedAt)}）`;
}

// Omit only the publication prefix already displayed in the heading. Keep the
// complete scope, validity period and advice; unfamiliar wording stays intact.
function bodyCopy(alert){
  const full=alert.description;
  if(!Number.isFinite(Date.parse(alert.publishedAt)))return full;
  const escape=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`^${escape(alert.issuer)}\\s*(?:(\\d{4})年)?(\\d{1,2})月(\\d{1,2})日\\s*(\\d{1,2})时(?:(\\d{1,2})分)?发布${escape(alert.hazard)}${escape(alert.color==='未分色'?'':alert.color)}(?:省级)?预警(?:信号)?[：:]\\s*`);
  const match=full.match(pattern);if(!match||match[0].length===full.length)return full;
  if(!samePublication(match,publicationParts(alert.publishedAt)))return full;
  return full.slice(match[0].length);
}

/** Color follows the official warning level. No model summarization. */
export async function renderWeatherAlert(alert){
  if(!alert||!Array.isArray(alert.matches)||!alert.matches.length||typeof alert.description!=='string'||alert.description.length>9000)throw Error('ALERT_IMAGE_INVALID');
  const measuring=createCanvas(2,2),m=measuring.getContext('2d');
  const width=W.width,inner=width-80,colors=palette[alert.color]||palette.未分色;
  const regions=[...new Set(alert.matches.map(v=>v.area.name))].join(' / ');
  const regionLines=lines(m,regions,26,width-48,650);
  const title=alert.cancelled?`${alert.hazard}预警解除`:`${alert.hazard}${alert.color==='未分色'?'':alert.color}预警`;
  const titleLines=lines(m,title,30,inner,650);
  const issuerLines=lines(m,`${alert.issuer} · ${stamp(alert.publishedAt)}`,12,inner);
  const bodyLines=lines(m,bodyCopy(alert),15,inner);
  const parents=[...new Map((alert.provinceContext||[]).filter(p=>p.headline!==alert.headline).map(p=>[`${p.headline}|${p.publishedAt}`,p])).values()];
  const parentLines=parents.length?lines(m,parents.map(parentCopy).join('\n'),13,inner):[];
  const headerHeight=61+regionLines.length*36,heroHeight=75+titleLines.length*39+issuerLines.length*19;
  const bodyTop=headerHeight+heroHeight+16,bodyHeight=38+bodyLines.length*23;
  const parentTop=bodyTop+bodyHeight+14,parentHeight=parentLines.length?51+parentLines.length*20:0;
  const height=(parentHeight?parentTop+parentHeight:bodyTop+bodyHeight)+47;
  const canvas=createCanvas(Math.round(width*W.scale),Math.ceil(height*W.scale)),c=canvas.getContext('2d');
  c.scale(W.scale,W.scale);c.fillStyle=W.background;c.fillRect(0,0,width,height);
  text(c,'亚历克斯 · 实时气象预警',24,36,12,W.muted,500);
  regionLines.forEach((s,i)=>text(c,s,24,80+i*36,26,W.ink,650));
  const gradient=c.createLinearGradient(24,headerHeight,width-24,headerHeight+heroHeight);gradient.addColorStop(0,colors[0]);gradient.addColorStop(1,colors[1]);
  box(c,24,headerHeight,width-48,heroHeight,gradient,22);
  const change=alert.change==='升级'&&alert.previousColor?`升级 · ${alert.previousColor} → ${alert.color}`:alert.change||'新增';
  text(c,change,40,headerHeight+28,12,'#ffffff',500);
  let y=headerHeight+68;for(const s of titleLines){text(c,s,40,y,30,'#ffffff',650);y+=39;}
  for(const s of issuerLines){text(c,s,40,y+1,12,'#ffffff',450);y+=19;}
  box(c,24,bodyTop,width-48,bodyHeight,'#ffffff');
  bodyLines.forEach((s,i)=>text(c,s,40,bodyTop+34+i*23,15,W.ink));
  if(parentHeight){
    box(c,24,parentTop,width-48,parentHeight,colors[2]);
    text(c,`${alert.province} · 省级预警`,40,parentTop+28,14,colors[0],650);
    parentLines.forEach((s,i)=>text(c,s,40,parentTop+52+i*20,13,colors[0]));
  }
  text(c,'来源：'+(['北京市应急管理局','天津市生态环境局'].includes(alert.source)?alert.source:'中国气象局'),24,height-20,11,W.muted);
  try{return {buffer:await encodePngTiles({width:canvas.width,height:canvas.height,
    renderTile:(top,tileHeight)=>Buffer.from(c.getImageData(0,top,canvas.width,tileHeight).data.buffer)}),mimeType:'image/png'};}
  finally{canvas.width=1;canvas.height=1;measuring.width=1;measuring.height=1;}
}
