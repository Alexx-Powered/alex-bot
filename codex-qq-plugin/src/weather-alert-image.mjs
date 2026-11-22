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

// The CMA feed uses Beijing local time; regional sources can supply ISO timestamps.
function effectiveTime(value){
  if(typeof value!=='string')return NaN;
  const local=value.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}:\d{2})(:\d{2})?$/);
  if(local)return Date.parse(`${local[1]}-${local[2]}-${local[3]}T${local[4]}${local[5]||':00'}+08:00`);
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value)?Date.parse(value):NaN;
}

export function weatherAlertHeading(alert){
  const cancellation=alert.cancelled===true||alert.change==='解除';
  if(cancellation){
    const effective=effectiveTime(alert.effective);
    if(effective>Date.parse(alert.checkedAt||alert.publishedAt)){
      return {title:`${alert.hazard}预警即将解除`,label:`${stamp(new Date(effective).toISOString())} 起解除`,cleared:false};
    }
    const original=[alert.color,alert.previousColor].find(color=>color!=='未分色'&&Object.hasOwn(palette,color));
    return {title:`${alert.hazard}预警解除`,label:`${alert.hazard}${original||''}预警：`,cleared:true};
  }
  const label=alert.change==='升级'&&alert.previousColor?`升级 · ${alert.previousColor} → ${alert.color}`:alert.change||'新增';
  return {title:`${alert.hazard}${alert.color==='未分色'?'':alert.color}预警`,label,cleared:false};
}

/** Active warnings use their level color. The cleared notice uses a green header. */
export async function renderWeatherAlert(alert){
  if(!alert||!Array.isArray(alert.matches)||!alert.matches.length||typeof alert.description!=='string'||alert.description.length>9000)throw Error('ALERT_IMAGE_INVALID');
  const measuring=createCanvas(2,2),m=measuring.getContext('2d');
  const width=W.width,inner=width-80,colors=palette[alert.color]||palette.未分色;
  const regions=[...new Set(alert.matches.map(v=>v.area.name))].join(' / ');
  const regionLines=lines(m,regions,26,width-48,650);
  const {title,label,cleared}=weatherAlertHeading(alert);
  const redNotice=alert.color==='红色'&&!alert.cancelled&&alert.change!=='解除';
  const heroColors=cleared?['#e8f2ec','#cfe3d8']:colors;
  const heroInk=cleared?'#234d3c':'#ffffff';
  const titleLines=lines(m,title,30,inner,650);
  const labelX=cleared?65:40;
  const labelLines=lines(m,label,12,width-40-labelX,500);
  const extraLabelHeight=(labelLines.length-1)*18;
  const issuerLines=lines(m,`${alert.issuer} · ${stamp(alert.publishedAt)}`,12,inner);
  const bodyLines=lines(m,bodyCopy(alert),15,inner);
  const parents=[...new Map((alert.provinceContext||[]).filter(p=>p.headline!==alert.headline).map(p=>[`${p.headline}|${p.publishedAt}`,p])).values()];
  const parentLines=parents.length?lines(m,parents.map(parentCopy).join('\n'),13,inner):[];
  const headerHeight=61+regionLines.length*36,heroHeight=75+extraLabelHeight+titleLines.length*39+issuerLines.length*19;
  const noticeTop=headerHeight+heroHeight+16;
  const bodyTop=noticeTop+(redNotice?48:0),bodyHeight=38+bodyLines.length*23;
  const parentTop=bodyTop+bodyHeight+14,parentHeight=parentLines.length?51+parentLines.length*20:0;
  const height=(parentHeight?parentTop+parentHeight:bodyTop+bodyHeight)+47;
  const canvas=createCanvas(Math.round(width*W.scale),Math.ceil(height*W.scale)),c=canvas.getContext('2d');
  c.scale(W.scale,W.scale);c.fillStyle=W.background;c.fillRect(0,0,width,height);
  text(c,'亚历克斯 · 实时气象预警',24,36,12,W.muted,500);
  regionLines.forEach((s,i)=>text(c,s,24,80+i*36,26,W.ink,650));
  const gradient=c.createLinearGradient(24,headerHeight,width-24,headerHeight+heroHeight);gradient.addColorStop(0,heroColors[0]);gradient.addColorStop(1,heroColors[1]);
  box(c,24,headerHeight,width-48,heroHeight,gradient,22);
  if(cleared){
    const y=headerHeight+23;
    c.fillStyle='#35654f';c.beginPath();c.arc(49,y,9,0,Math.PI*2);c.fill();
    c.strokeStyle='#ffffff';c.lineWidth=1.8;c.lineCap='round';c.lineJoin='round';
    c.beginPath();c.moveTo(45,y);c.lineTo(48,y+3);c.lineTo(53,y-3);c.stroke();
  }
  labelLines.forEach((s,i)=>text(c,s,labelX,headerHeight+28+i*18,12,heroInk,500));
  let y=headerHeight+68+extraLabelHeight;for(const s of titleLines){text(c,s,40,y,30,heroInk,650);y+=39;}
  for(const s of issuerLines){text(c,s,40,y+1,12,heroInk,450);y+=19;}
  if(redNotice){
    box(c,24,noticeTop,width-48,36,'#fff0f0',12);
    text(c,'0 分 · 拉',40,noticeTop+24,15,'#af1930',650);
    text(c,'红色预警期间应当避免外出',132,noticeTop+24,13,'#922036',600);
  }
  box(c,24,bodyTop,width-48,bodyHeight,'#ffffff');
  bodyLines.forEach((s,i)=>text(c,s,40,bodyTop+34+i*23,15,W.ink));
  if(parentHeight){
    const contextColors=cleared?palette.白色:colors;
    box(c,24,parentTop,width-48,parentHeight,contextColors[2]);
    text(c,`${alert.province} · 省级预警`,40,parentTop+28,14,contextColors[0],650);
    parentLines.forEach((s,i)=>text(c,s,40,parentTop+52+i*20,13,contextColors[0]));
  }
  text(c,'来源：'+(['北京市应急管理局','天津市生态环境局'].includes(alert.source)?alert.source:'中国气象局'),24,height-20,11,W.muted);
  try{return {buffer:await encodePngTiles({width:canvas.width,height:canvas.height,
    renderTile:(top,tileHeight)=>Buffer.from(c.getImageData(0,top,canvas.width,tileHeight).data.buffer)}),mimeType:'image/png'};}
  finally{canvas.width=1;canvas.height=1;measuring.width=1;measuring.height=1;}
}
