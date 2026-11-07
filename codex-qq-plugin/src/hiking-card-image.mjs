import {createCanvas,loadImage} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';
import {CHINESE_FONT} from './render-fonts.mjs';
import {temperatureColor,temperatureTextColor} from './chart-colors.mjs';
import {withHeavyWork} from './heavy-work.mjs';
import {measureSpan,setTraceOperation} from './telemetry.mjs';

const P={bg:'#f4f6f3',ink:'#142a32',muted:'#566960',border:'#e0e8e3',teal:'#24766f',white:'#fff',grey:'#858585'};
const number=(v,d=1)=>Number.isFinite(v)?v.toFixed(d).replace(/\.0$/,'').replace('-','−'):'缺测';
const unit=(v,u,d=1)=>Number.isFinite(v)?number(v,d)+u:'缺测';
const partial=(day,key)=>Number.isFinite(day.stats[key])&&Number.isInteger(day.coverage?.[key])&&day.coverage[key]<24;
const dayUnit=(day,key,u,d=1)=>unit(day.stats[key],u,d)+(partial(day,key)?'*':'');
const dayTemperature=day=>day.stats.min===null?'缺测':`${number(day.stats.min)}～${number(day.stats.max)}°C${partial(day,'min')?'*':''}`;
const safe=s=>typeof s==='string'&&s.length<=800&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(s);
export function validateHikingCard(v){
  if(!v||v.schema!=='hiking.card.v1'||!safe(v.topic)||v.topic.length>24||!Array.isArray(v.days)||v.days.length>14||Buffer.byteLength(JSON.stringify(v))>58000)throw Error('HIKING_CARD_INVALID');
  const plan=p=>{
    if(!Array.isArray(p.days)||p.days.length>14||!Array.isArray(p.nights)||p.nights.length>14)throw Error('HIKING_CARD_INVALID');
    for(const d of p.days){
      if(!/^\d{4}-\d\d-\d\d$/.test(d.date)||!Array.isArray(d.route)||!d.route.length||d.route.length>8||d.route.some(n=>!safe(n)||n.length>40))throw Error('HIKING_CARD_INVALID');
      if(!d.stats||Object.values(d.stats).some(n=>n!==null&&(!Number.isFinite(n)||Math.abs(n)>50000)))throw Error('HIKING_CARD_INVALID');
      if(d.coverage!==undefined&&(!d.coverage||Array.isArray(d.coverage)||Object.keys(d.coverage).length!==7||Object.entries(d.coverage).some(([k,n])=>!['min','max','cloud','precip','rain','snow','gust'].includes(k)||!Number.isInteger(n)||n<0||n>24)))throw Error('HIKING_CARD_INVALID');
      if(d.series&&(!Array.isArray(d.series)||d.series.length!==24||d.series.some(r=>!Array.isArray(r)||r.length!==7||!Number.isSafeInteger(r[6])||r[6]<0||r[6]>128||r.slice(0,6).some(n=>n!==null&&(!Number.isFinite(n)||Math.abs(n)>5000)))))throw Error('HIKING_CARD_INVALID');
    }
    for(const n of p.nights)if(!safe(n.name)||!['tent','inn','camp'].includes(n.kind)||[n.low,n.comfort].some(x=>x!==null&&(!Number.isFinite(x)||Math.abs(x)>200)))throw Error('HIKING_CARD_INVALID');
  };
  plan(v);if(v.alternate)plan(v.alternate);
  return v;
}

export function parseHikingCommand(text){
  if(typeof text!=='string'||text.length>130)return null;
  const m=/^(?:发\s+|\/)?徒步\s+([\p{Script=Han}A-Za-z·-]{2,24})(?:\s+(\d{4}-\d{2}-\d{2}))?(?:\s+(不露营|住店|露营))?\s*$/u.exec(text.trim());
  return m?{destination:m[1],...(m[2]?{start_date:m[2]}:{}),overnight:['不露营','住店'].includes(m[3])?'inn':m[3]==='露营'?'tent':'auto'}:null;
}

export async function renderHikingCard(value){
  const v=validateHikingCard(value);setTraceOperation('hiking.trip');
  const buffer=await withHeavyWork(()=>measureSpan('hiking_render',()=>draw(v)));
  // Same media contract as weather/help images; the QQ boundary rejects a raw
  // Buffer before upload, even when it contains a perfectly valid PNG.
  return {buffer,mimeType:'image/png'};
}

async function draw(v){
  const N=v.days.length||1,W=Math.max(992,152+280*N),CW=(W-152)/N,left=100,right=W-52;
  // Measure wrapping before allocating the output; long routes grow in width.
  const probe=createCanvas(4,4).getContext('2d');
  function wrapped(str,width,size){
    probe.font=`${size}px ${CHINESE_FONT}`;let current='',lines=[];
    for(const ch of String(str||'')){if(ch==='\n'){lines.push(current);current='';continue;}if(current&&probe.measureText(current+ch).width>width){lines.push(current);current='';}current+=ch;}
    if(current)lines.push(current);return lines;
  }
  const routeLines=v.days.map(d=>wrapped(d.route.join(' → '),CW-28,17));
  const routeH=Math.max(148,92+Math.max(0,...routeLines.map(a=>a.length))*24);
  const start=292+routeH+16,split=(W-72)/2,rx=44+split;
  const altLines=v.alternate?.days.map(d=>wrapped(d.route.join(' → '),split-44,18))||[];
  const altHeads=v.alternate?.days.map((d,i)=>wrapped(`D${i+1}  ${d.date.slice(5).replace('-','/')} · ${d.sleep?'住 '+d.sleep.name:'离山 / 返程'}`,split-44,20))||[];
  const altHeight=altLines.reduce((sum,lines,i)=>sum+37+lines.length*23+altHeads[i].length*27,0);
  const nightNames=v.nights.map(n=>wrapped(`第 ${n.day} 晚  ${n.name}`,split-44,20));
  const bottomH=Math.max(330,190+nightNames.reduce((sum,l)=>sum+52+l.length*24,0),170+altHeight),bottomY=start+888;
  const partialDays=[...v.days,...(v.alternate?.days||[])].some(d=>Object.keys(d.stats).some(key=>partial(d,key)));
  const footerLines=[partialDays?'* 仅统计有数据时段；缺测时段未计入，雨雪为已获取时段累计。':'',v.climate,v.season,v.notice,
    v.missing?.length?'缺少可靠坐标：'+v.missing.join('、')+'；对应时段留空。':'',
    v.error?'预报暂缺：'+({'HIKING_FORECAST_TIMEOUT':'数据源超时','FORECAST_OUTSIDE_HORIZON':'日期超出当前可用预报范围','HIKING_COORDINATES_MISSING':'沿途坐标待核'}[v.error]||'上游数据未能获取')+'。':'',
    v.reviewed===false?'行程为自动提取的来源参考，尚未人工核验。':'',
    '沿途 / 营地区域预报；08—18时按参考进度切换地点，虚线表示切换。非导航或营地实测。',
    'ECMWF / Open-Meteo · '+(v.retrieved?'获取 '+v.retrieved.slice(0,16).replace('T',' ')+' 北京时间':'未取得本次预报')+' · 阴影为 20:00—08:00',
    '路书及住宿：'+[...(v.sources||[]),...(v.alternate?.sources||[])].filter((s,i,a)=>a.findIndex(x=>x.url===s.url)===i).map(s=>s.title+'（'+s.date+'）').join('；')
  ].filter(Boolean).flatMap(s=>wrapped(s,W-100,17));
  const H=v.days.length?bottomY+bottomH+40+footerLines.length*27+28:400+wrapped(v.message,W-100,25).length*38;
  const scale=Math.min(2.4,6000/W,Math.sqrt(18_000_000/(W*H)));
  const canvas=createCanvas(Math.ceil(W*scale),Math.ceil(H*scale)),c=canvas.getContext('2d');c.scale(scale,scale);c.fillStyle=P.bg;c.fillRect(0,0,W,H);
  const finish=()=>{const buffer=canvas.toBuffer('image/png');canvas.width=1;canvas.height=1;return buffer;};
  function text(s,x,y,size=20,color=P.ink,weight=400,width=W-56,align='left'){
    c.font=`${weight} ${size}px ${CHINESE_FONT}`;c.fillStyle=color;c.textAlign=align;
    if(c.measureText(String(s)).width>width+.6)throw Error('HIKING_TEXT_OVERFLOW');c.fillText(String(s),x,y);
  }
  function rect(x,y,w,h,fill=P.white,r=24,stroke){if(h<=0)return;c.beginPath();c.roundRect(x,y,w,h,Math.min(r,h/2));c.fillStyle=fill;c.fill();if(stroke){c.strokeStyle=stroke;c.lineWidth=1.2;c.stroke();}}
  function line(x1,y1,x2,y2,color=P.border,width=1,dash=[]){c.save();c.beginPath();c.moveTo(x1,y1);c.lineTo(x2,y2);c.strokeStyle=color;c.lineWidth=width;c.setLineDash(dash);c.stroke();c.restore();}
  const lines=(ss,x,y,size=18,color=P.muted,gap=25,width=W-100)=>ss.forEach((s,i)=>text(s,x,y+i*gap,size,color,400,width));
  text('亚历克斯 · 徒步简报',28,42,18,P.muted,500);
  const heading=v.topic+(v.variant?' · '+v.variant:'');
  const titleSize=wrapped(heading,W-160,44).length>1?24:44;
  const title=wrapped(heading,W-160,titleSize);lines(title,28,title.length>1?80:105,titleSize,P.ink,30,W-160);
  const logo=await loadImage(fileURLToPath(new URL('../public/logo.png',import.meta.url)));c.drawImage(logo,W-110,65,70,70);
  if(!v.days.length){rect(28,166,W-56,H-206);lines(wrapped(v.message||'路线资料待补充',W-110,25),55,218,25,P.ink,38,W-110);return finish();}
  text(`${N} 个徒步日 · ${v.start} 起 · 往返交通另计`,30,137,20,P.muted);
  const g=c.createLinearGradient(28,164,W-28,272);g.addColorStop(0,'#0d2130');g.addColorStop(1,'#145257');rect(28,160,W-56,116,g,27);
  const wet=v.days.filter(d=>Number.isFinite(d.stats.precip)).sort((a,b)=>b.stats.precip-a.stats.precip)[0];
  const tents=v.nights.filter(n=>n.kind==='tent'),low=tents.every(n=>n.low!==null)&&tents.length?Math.min(...tents.map(n=>n.low)):null;
  const innOnly=!tents.length&&v.nights.length>=N-1&&v.nights.every(n=>n.kind==='inn');
  const summary=v.status==='partial'?(v.days.some(d=>Object.values(d.stats).some(Number.isFinite))?'每日天气与沿途住宿':'暂未取得天气数据'):wet&&wet.stats.precip>0?`第 ${v.days.indexOf(wet)+1} 天雨雪较多`:'沿途天气与住宿，一起看';
  text(summary,52,206,32,'#f7fbf9',700);
  const detail=low!==null?`露营夜间最低约 ${number(low)}°C；睡袋建议见下方。`:tents.length?'营地夜间预报不完整，暂不推算全程睡袋温标。':innOnly?'住店方案已列出，出发前确认房态与接驳。':'住宿方式待核；不把营地名称当作已确认的床位。';
  text(detail,52,247,20,'#d9e8e3',450,W-104);
  rect(28,292,W-56,routeH,'#e8efeb',22);
  v.days.forEach((d,i)=>{const x=left+i*CW;if(i)line(x-18,309,x-18,292+routeH-16,'#cad9d0');text(`D${i+1}  ${d.date.slice(5).replace('-','/')}`,x,324,22,P.teal,650,CW-20);lines(routeLines[i],x,359,17,P.muted,24,CW-28);text((d.distance?'约 '+number(d.distance)+' km · ':'')+'阵风 '+dayUnit(d,'gust',' m/s'),x,292+routeH-18,17,P.muted,500,CW-20);});
  function card(y,h,title,index,subtitle){rect(28,y,W-56,h,P.white,24,P.border);text(index,50,y+42,16,P.teal,600,32);text(title,88,y+44,25,P.ink,650,410);text(subtitle,W-52,y+42,16,P.muted,400,W/2,'right');}
  const tx=i=>left+i*(right-left)/(24*N);
  function frame(y,h,ticks,lo,hi){const bot=y+h,toY=v=>bot-(v-lo)/(hi-lo)*h;
    for(let d=0;d<N;d++){c.fillStyle='#f0f2f1';c.fillRect(tx(d*24),y,tx(d*24+8)-tx(d*24),h);c.fillRect(tx(d*24+20),y,tx((d+1)*24)-tx(d*24+20),h);}
    for(const t of ticks){line(left,toY(t),right,toY(t),'#e3e9e5');text(number(t),left-16,toY(t)+5,15,P.muted,400,56,'right');}
    for(let d=0;d<N;d++){if(d)line(tx(d*24),y-8,tx(d*24),bot,'#bdcbc6',1.2,[4,5]);for(const hour of [0,6,12,18])text(String(hour).padStart(2,'0'),tx(d*24+hour)+3,bot+25,14,P.muted,400,36);}
    text('24',right,bot+25,14,P.muted,400,36,'right');return {top:y,bot,toY};}
  const samples=v.days.flatMap(d=>d.series||Array.from({length:24},()=>[null,null,null,null,null,null,'']));
  function plot(field,f,color){c.save();c.beginPath();c.rect(left,f.top-2,right-left,f.bot-f.top+4);c.clip();for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i];if(a[field]===null||b[field]===null)continue;const changed=a[6]!==b[6];line(tx(i-1),f.toY(a[field]),tx(i),f.toY(b[field]),color||temperatureColor((a[field]+b[field])/2),changed?1.7:3.3,changed?[2,4]:[]);}c.restore();}
  card(start,288,'温度','01','°C · 当日沿途范围');
  v.days.forEach((d,i)=>text(dayTemperature(d),left+i*CW+CW/2,start+83,27,d.stats.min===null?P.muted:temperatureTextColor(d.stats.min),600,CW-28,'center'));
  const ts=samples.map(r=>r[0]).filter(Number.isFinite),lo=Math.floor((Math.min(...ts,0)-2)/5)*5,hi=Math.ceil((Math.max(...ts,5)+2)/5)*5;
  plot(0,frame(start+107,137,Array.from({length:5},(_,i)=>lo+(hi-lo)*i/4),lo,hi));
  card(start+304,264,'云量','02','% · 当日平均');
  v.days.forEach((d,i)=>text(dayUnit(d,'cloud','%',0),left+i*CW+CW/2,start+387,27,'#596260',600,CW-28,'center'));
  plot(1,frame(start+413,112,[0,50,100],0,100),P.grey);
  card(start+584,288,'降水','03','柱状：每小时雨雪折合水量 · mm');
  v.days.forEach((d,i)=>{text(dayUnit(d,'precip',' mm'),left+i*CW+CW/2,start+665,27,P.teal,650,CW-28,'center');text(`雨 ${dayUnit(d,'rain',' mm')} · 雪 ${dayUnit(d,'snow',' cm')}`,left+i*CW+CW/2,start+692,16,P.muted,450,CW-20,'center');});
  const peak=Math.max(.3,...samples.map(r=>r[2]||0)),limit=Math.ceil(peak*2)/2;const pf=frame(start+714,112,[0,limit/2,limit],0,limit);
  samples.forEach((r,i)=>{if(r[2]!==null)rect(tx(i)+1.2,pf.toY(r[2]),(right-left)/(24*N)*.7,pf.bot-pf.toY(r[2]),'#247b72',2);});
  rect(28,bottomY,split,bottomH,P.white,24,P.border);rect(rx,bottomY,split,bottomH,P.white,24,P.border);
  text(tents.length?'露营 · 营地与睡袋':'过夜 · 沿线住宿',50,bottomY+45,25,P.ink,650,split-44);
  let nightY=bottomY+85;
  v.nights.forEach((n,i)=>{lines(nightNames[i],50,nightY,20,P.ink,24,split-44);nightY+=nightNames[i].length*24;text(n.kind==='tent'?`夜间 ${unit(n.low,'°C')} · 舒适温标 ${n.comfort===null?'待补齐':'≤ '+number(n.comfort)+'°C'}`:`${n.kind==='inn'?'住店':'方式待核'} · 夜间 ${unit(n.low,'°C')}`,50,nightY+5,18,P.teal,550,split-44);nightY+=52;});
  const footer=bottomY+bottomH-102;
  if(tents.length){text('全程舒适温标：'+(tents.every(n=>n.comfort!==null)?'≤ '+number(Math.min(...tents.map(n=>n.comfort)))+'°C':'营地夜温待补齐'),50,footer,22,P.teal,650,split-44);lines(wrapped('区域夜温留 5°C 余量；配保暖睡垫，怕冷者另加。温标为预估，不是保暖保证。',split-44,17),50,footer+32,17,P.muted,25,split-44);}
  else lines(wrapped(innOnly?'住店方案无需露营睡袋；床品、供暖及接驳需另确认。':'营地住宿方式未明确，暂不给睡袋温标；请补齐营地与住宿信息。',split-44,19),50,footer,19,P.muted,28,split-44);
  text('不露营 · '+(v.alternate?'可选走法':innOnly?'当前走法':'资料待补'),rx+22,bottomY+45,25,P.ink,650,split-44);
  if(v.alternate){let y=bottomY+85;v.alternate.days.forEach((d,i)=>{lines(altHeads[i],rx+22,y,20,P.ink,27,split-44);y+=altHeads[i].length*27;lines(altLines[i],rx+22,y,18,P.muted,23,split-44);y+=altLines[i].length*23+3;text(`${dayTemperature(d)} · 云 ${dayUnit(d,'cloud','%',0)} · 雨雪 ${dayUnit(d,'precip',' mm')}`,rx+22,y,17,P.teal,500,split-44);y+=34;});lines(wrapped('以上为来源记载的住店行程，房态与开放情况需另核。',split-44,17),rx+22,bottomY+bottomH-48,17,P.muted,24,split-44);}
  else lines(wrapped(innOnly?'逐日住处见左栏；客栈可能存在季节性停业，订房时一并确认。':'尚无可核对的住店替代行程。后台补查结果将在后续查询复用。',split-44,20),rx+22,bottomY+90,20,P.muted,30,split-44);
  lines(footerLines,50,bottomY+bottomH+38,17,P.muted,27,W-100);
  return finish();
}
