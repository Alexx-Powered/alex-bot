// Shared provider status artwork. Inputs are already verified Python facts; no network or business inference here.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCanvas, loadImage} from '@napi-rs/canvas';
import {WEATHER_REPORT_STYLE as W} from './weather-report-image.mjs';
import {encodePngTiles} from './png-strips.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const logoCache=new Map();
const FONT='Weather Noto, Alex CJK, sans-serif', MONO='Weather Mono, Weather Noto, monospace';
const BASE_COLORS={...W,muted:'#63736c',heroFrom:'#f0e3d2',heroTo:'#e7d1b8',heroMuted:'#6d604f',
  heroInk:'#3b342b',mini:'#ffffff66',line:'#e5ece7',ok:'#246c61',okFill:'#e4f1eb',
  red:'#a33637',redInk:'#722b2f',redMuted:'#88585a',redFill:'#fff4f2',redBorder:'#e4a9a5',redPill:'#f7dfdb'};
const C=BASE_COLORS;
const dark={heroInk:'#ffffff',heroMuted:'#ffffff',mini:'#ffffff16',symbolInk:'#ffffff',symbolFill:'#ffffff18',symbolRing:'#ffffff35'};
export const PROVIDER_BRANDS=Object.freeze({
  openai:{...dark,heroFrom:'#191919',heroTo:'#343434',logo:'openai.png'},
  deepseek:{...dark,heroFrom:'#415de0',heroTo:'#3149b9',logo:'deepseek.png'},
  gemini:{...dark,heroFrom:'#3564cf',heroTo:'#6854ba',logo:'gemini.png'},
  claude:{heroFrom:'#e8aa8e',heroTo:'#d97757',heroInk:'#30251f',heroMuted:'#30251f',mini:'#ffffff36',
    symbolInk:'#563420',symbolFill:'#ffffff3b',symbolRing:'#70472b30',logo:'claude.svg'},
  kimi:{...dark,heroFrom:'#0a0d10',heroTo:'#20282e',logo:'kimi.png',logoFit:'cover'},
});
const states={
  operational:['正常',C.ok,C.okFill], affected:['受影响',C.red,C.redPill],
  degraded_performance:['性能下降',C.red,C.redPill],partial_outage:['部分中断',C.red,C.redPill],
  major_outage:['服务中断',C.red,C.redPill],under_maintenance:['维护中','#775a21','#f5ecd6'],
  unknown:['待确认',C.muted,'#edf0ec'],
};
const phases={investigating:'排查中',identified:'已确认问题',monitoring:'修复后观察',
  detected:'发现问题',mitigated:'已缓解',update:'进展更新',unknown:'阶段未公布',resolved:'已恢复',scheduled:'计划维护',ongoing:'维护中',in_progress:'维护中',verifying:'验证中',completed:'维护完成'};

function font(c,size,weight=400,mono=false){c.font=`${weight} ${size}px ${mono?MONO:FONT}`;}
function txt(c,t,x,y,size=12,color=C.ink,weight=400,{align='left',mono=false,maxWidth}={}){
  c.save();font(c,size,weight,mono);c.fillStyle=color;c.textAlign=align;
  const width=c.measureText(t).width;
  if(maxWidth&&width>maxWidth+.1)throw Error(`TEXT_OVERFLOW: ${t} (${width}/${maxWidth})`);
  const left=align==='right'?x-width:align==='center'?x-width/2:x;
  if(left<0||left+width>W.width+.1)throw Error(`CANVAS_OVERFLOW: ${t}`);
  c.fillText(t,x,y);c.restore();
}
function wrap(c,text,size,width,weight=400){
  c.save();font(c,size,weight);const lines=[];
  for(const paragraph of text.split('\n')){
    let line='';
    for(const word of paragraph.match(/[A-Za-z0-9]+(?:[.\-/][A-Za-z0-9]+)*|\s+|./gu)||[]){
      const tokens=c.measureText(word).width>width?Array.from(word):[word];
      for(const token of tokens){
        if(line&&c.measureText(line+token).width>width){lines.push(line.trim());line=token.trimStart();}
        else line+=token;
      }
    }
    if(line)lines.push(line.trim());
  }
  c.restore();return lines;
}
function box(c,x,y,w,h,fill,radius=18,stroke){
  c.save();c.beginPath();c.roundRect(x,y,w,h,radius);c.fillStyle=fill;c.fill();
  if(stroke){c.strokeStyle=stroke;c.lineWidth=1;c.stroke();}c.restore();
}
function line(c,x1,y1,x2,y2,color=C.line){c.save();c.strokeStyle=color;c.lineWidth=.7;c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.stroke();c.restore();}
function check(c,x,y,r,color,width){c.save();c.strokeStyle=color;c.lineWidth=width;c.lineCap='round';c.lineJoin='round';c.beginPath();c.moveTo(x-r*.41,y-r*.01);c.lineTo(x-r*.1,y+r*.29);c.lineTo(x+r*.47,y-r*.33);c.stroke();c.restore();}
function alertMark(c,x,y,r,color,width){c.save();c.strokeStyle=color;c.lineWidth=width;c.lineCap='round';c.beginPath();c.moveTo(x,y-r*.45);c.lineTo(x,y+r*.08);c.stroke();c.fillStyle=color;c.beginPath();c.arc(x,y+r*.42,width*.55,0,Math.PI*2);c.fill();c.restore();}
function layout(c,m){
  const rows=m.rows.map(row=>{const lines=wrap(c,row.label,13.1,260,500);return{row,lines,height:Math.max(46,22+lines.length*19)};});
  const service={top:368,rows,height:60+rows.reduce((sum,row)=>sum+row.height,0)};let y=service.top+service.height;
  const incidents=[...(m.incidents||[]),...(m.notice?[m.notice]:[])].map(incident=>{
    y+=18;const top=y;
    const titleLines=wrap(c,incident.title,18,352,650);
    let cursor=62+titleLines.length*25+12;
    const fields=[['影响服务',incident.affected||'官方暂未列明'],['问题表现',incident.symptom||'官方暂未发布详细说明'],
      ['最新进展',incident.progress||'官方暂未披露处理阶段']].map(([label,value])=>{
      const lines=wrap(c,value,12.2,352,450);const item={label,lines,top:cursor};
      cursor+=17+lines.length*20+14;return item;
    });
    const height=cursor+51;y=top+height;return{incident,top,height,titleLines,fields,divider:cursor-1};
  });
  return{service,incidents,footer:y+26,height:y+92+(m.scopeNote?20:0)};
}
function draw(c,m,l,brand,logo){
  const C={...BASE_COLORS,...brand};
  c.fillStyle=C.background;c.fillRect(0,0,W.width,l.height);
  txt(c,'亚历克斯 · 服务状态',20,30,10.5,C.muted);
  txt(c,m.checkedAt.slice(0,10).replaceAll('-','.'),420,30,9.7,C.muted,500,{align:'right',mono:true});
  txt(c,m.title,20,78,32,C.ink,750);
  const history=m.mode==='historical';
  txt(c,history?'历史回放 · 非当前状态':'官方服务状态',20,104,12,history?'#81571e':C.muted,history?600:400);
  if(brand.logoFit==='cover'){
    // Fill the existing rounded frame; trim the source's thin square border.
    const side=Math.min(logo.width,logo.height)-2;
    c.save();c.beginPath();c.roundRect(356,49,64,64,19);c.clip();
    c.drawImage(logo,(logo.width-side)/2,(logo.height-side)/2,side,side,356,49,64,64);c.restore();
  }else{
    box(c,356,49,64,64,'#ffffff',19);
    const ratio=Math.min(52/logo.width,52/logo.height);
    c.drawImage(logo,388-logo.width*ratio/2,81-logo.height*ratio/2,logo.width*ratio,logo.height*ratio);
  }
  const top=136,gradient=c.createLinearGradient(20,top,420,top+212);
  gradient.addColorStop(0,C.heroFrom);gradient.addColorStop(1,C.heroTo);
  c.save();c.shadowColor='#53432d12';c.shadowBlur=18;c.shadowOffsetY=6;box(c,20,top,400,212,gradient,24);c.restore();
  txt(c,'整体状态',40,top+31,12,C.heroMuted);
  txt(c,m.statusTitle,40,top+80,m.statusTitle.length>5?30:34,C.heroInk,700,{maxWidth:264});
  txt(c,m.summary,40,top+108,11.5,C.heroMuted,400,{maxWidth:360});
  const normal=m.overall==='operational';
  c.save();c.strokeStyle=C.symbolRing;c.lineWidth=1;c.beginPath();c.arc(354,top+67,43,0,Math.PI*2);c.stroke();
  c.fillStyle=C.symbolFill;c.beginPath();c.arc(354,top+67,32,0,Math.PI*2);c.fill();c.restore();
  if(normal)check(c,354,top+67,32,C.symbolInk,4.5);else alertMark(c,354,top+67,29,C.symbolInk,4.5);
  box(c,40,top+133,170,59,C.mini,13);box(c,222,top+133,178,59,C.mini,13);
  txt(c,'进行中事件',52,top+155,10,C.heroMuted);
  txt(c,String(m.incidentCount),52,top+180,18,C.heroInk,600,{mono:true});
  txt(c,history?'回放时间 · 北京时间':'检查时间 · 北京时间',234,top+155,10,C.heroMuted);
  txt(c,m.checkedAt.slice(11,19),234,top+180,15,C.heroInk,500,{mono:true});

  const s=l.service;box(c,20,s.top,400,s.height,'#ffffff',18,C.border);
  txt(c,'01',36,s.top+31,11,'#2b7a78',500,{mono:true});txt(c,'服务概览',60,s.top+33,17,C.ink,700);
  txt(c,m.listLabel,404,s.top+31,9.5,C.muted,400,{align:'right'});
  let rowTop=s.top+58;
  s.rows.forEach(({row,lines,height},i)=>{
    const y=rowTop;const [label,color,fill]=states[row.state]||states.unknown;
    lines.forEach((value,index)=>txt(c,value,36,y+21+index*19,13.1,C.ink,500,{maxWidth:263}));
    const pillWidth=label.length>3?88:label.length>2?76:60;const x=404-pillWidth;
    box(c,x,y+3,pillWidth,29,fill,14.5);
    if(row.state==='operational')check(c,x+13,y+17.5,8,color,1.6);
    else alertMark(c,x+13,y+17,7,color,1.5);
    txt(c,label,x+25,y+22,11.2,color,500,{maxWidth:pillWidth-30});
    if(i<m.rows.length-1)line(c,36,y+height-10,404,y+height-10);
    rowTop+=height;
  });
  l.incidents.forEach(({incident:i,top:t,height,titleLines,fields,divider},index)=>{
    box(c,20,t,400,height,C.redFill,18,C.redBorder);
    txt(c,String(index+2).padStart(2,'0'),36,t+31,11,C.red,500,{mono:true});
    txt(c,'故障详情',60,t+33,17,C.redInk,700);
    const phase=phases[i.phase]||'阶段未公布';
    const pw=Math.max(68,phase.length*10.5+22);box(c,404-pw,t+15,pw,26,C.redPill,13);
    txt(c,phase,404-pw/2,t+33,10.5,C.red,600,{align:'center'});
    titleLines.forEach((text,index)=>txt(c,text,44,t+68+index*25,18,C.redInk,650,{maxWidth:352}));
    for(const field of fields){
      txt(c,field.label,44,t+field.top,9.6,C.redMuted,500);
      field.lines.forEach((text,index)=>txt(c,text,44,t+field.top+21+index*20,12.2,C.redInk,450,{maxWidth:352}));
    }
    line(c,44,t+divider,396,t+divider,'#edc5bf');
    const updated=i.updatedAt?i.updatedAt.slice(11,16)+' 更新 · 北京时间':'官方未提供更新时间';
    txt(c,updated,44,t+divider+22,9.3,C.redMuted,400);
    txt(c,i.eta||'恢复时间暂未公布',396,t+divider+22,9.3,C.redMuted,400,{align:'right'});
  });
  line(c,20,l.footer,420,l.footer,C.border);
  txt(c,m.sourceLabel||'官方来源',20,l.footer+23,9.5,C.muted);
  txt(c,new URL(m.source).hostname,420,l.footer+23,10,C.muted,500,{align:'right',mono:true});
  txt(c,history?'历史事件仅用于样式预览；该事件后续已恢复。':'官方聚合状态，不代表个人账户或网络的可用性。',
    20,l.footer+45,9.4,C.muted,400,{maxWidth:400});
  if(m.scopeNote)txt(c,m.scopeNote,20,l.footer+64,9.2,C.muted,400,{maxWidth:400});
}

/** Weather-width image, using small reusable strips to keep ECS memory bounded. */
export async function renderProviderStatusImage(model,{scale=W.scale}={}){
  const brand=PROVIDER_BRANDS[model.provider];
  if(!brand||!Number.isFinite(scale)||scale<1||scale>W.scale)throw Error('STATUS_BRAND_INVALID');
  if(!Array.isArray(model.rows)||!Array.isArray(model.incidents)||model.incidents.length!==model.incidentCount)throw Error('STATUS_REPORT_INVALID');
  if(model.overall==='operational'&&(model.incidentCount||model.notice||model.rows.some(r=>r.state!=='operational')))throw Error('INCONSISTENT_NORMAL_STATE');
  if(model.overall!=='operational'&&!model.incidents.length&&!model.notice)throw Error('ABNORMAL_STATUS_REQUIRES_DETAIL');
  if(!logoCache.has(model.provider))logoCache.set(model.provider,loadImage(path.join(here,'../public/provider-status',brand.logo)));
  const logo=await logoCache.get(model.provider);
  const probe=createCanvas(1,1),l=layout(probe.getContext('2d'),model);
  const width=Math.round(W.width*scale),height=Math.round(l.height*scale);
  if(width*height>20_000_000)throw Error('STATUS_IMAGE_TOO_TALL');
  const tile=createCanvas(width,Math.min(512,height)),c=tile.getContext('2d');
  try{
    const buffer=await encodePngTiles({width,height,renderTile:(top,tileHeight)=>{
      c.resetTransform();c.clearRect(0,0,width,tile.height);c.setTransform(scale,0,0,scale,0,-top);
      draw(c,model,l,brand,logo);c.resetTransform();
      return c.getImageData(0,0,width,tileHeight).data;
    }});
    return{buffer,mimeType:'image/png',width,height};
  }finally{tile.width=1;tile.height=1;probe.width=1;probe.height=1;}
}
