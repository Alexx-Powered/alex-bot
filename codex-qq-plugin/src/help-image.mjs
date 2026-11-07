import {createCanvas, GlobalFonts, loadImage} from '@napi-rs/canvas';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CHINESE_FONT} from './render-fonts.mjs';
import {GROUP_FEATURES} from './group-features.mjs';
import {WEATHER_TOOLS} from './weather-catalog.mjs';

// The console mascot keeps its original colors and proportions.
const logo = await loadImage(fileURLToPath(new URL('../public/logo.png', import.meta.url)));
const boldPath = process.env.QQ_FONT_BOLD || [
  'C:/Windows/Fonts/msyhbd.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
].find(existsSync);
const boldFamily = boldPath && existsSync(boldPath) && GlobalFonts.registerFromPath(boldPath, 'Alex Help Bold')
  ? 'Alex Help Bold, ' + CHINESE_FONT : CHINESE_FONT;

const tools = [
  {feature:'status', group:'服务与账户', command:'查 OpenAI 状态', tag:'服务状态', example:'ChatGPT 现在正常吗？'},
  {feature:'status', group:'服务与账户', command:'查 DeepSeek 状态', tag:'服务状态', example:'DeepSeek 现在正常吗？'},
  {feature:'status', group:'服务与账户', command:'查 Gemini 状态', tag:'服务状态', example:'Gemini API 现在正常吗？'},
  {feature:'status', group:'服务与账户', command:'查 Claude 状态', tag:'服务状态', example:'Claude 恢复了吗？'},
  {feature:'status', group:'服务与账户', command:'查 Kimi 状态', tag:'服务状态', example:'Kimi 服务有故障吗？'},
  {feature:'balance', group:'服务与账户', command:'查 DeepSeek 余额', tag:'API 余额', example:'DeepSeek 账户还剩多少钱？'},
  {feature:'campus', group:'校园与生活', command:'发 三号楼空教室情况', tag:'空教室', example:'今晚三号楼哪里能自习？'},
  {feature:'conversion', group:'校园与生活', command:'换算 1 马里 公里', tag:'固定换算', example:'1 马里是多少公里？'},
  {feature:'status', group:'校园与生活', command:'查滑动变祖器状态', tag:'梁系评分', example:'滑动变祖器现在几级了？'},
  {feature:'images', group:'图片、语音与记忆', command:'/识图', tag:'先发图片', example:'这张图里写了什么？'},
  {feature:'memory', group:'图片、语音与记忆', command:'/记忆 查看', tag:'成员记忆'},
];
const daily = [
  {feature:'morningWeather', command:'早间天气', tag:'天气与运动'},
  {feature:'morningCampus', command:'三号楼自习简报', tag:'空教室'},
];
const known = new Set(['chat','voice',...tools.map(t=>t.feature),...daily.map(t=>t.feature),...WEATHER_TOOLS.map(t=>t.feature)]);
const weatherLabels = {
  radar_image: {command:'发 雷达 地点', tag:'支持全球'},
  weather_image: {command:'发 天气 城市', tag:'2 日简报'},
  air_quality_image: {command:'发 空气 城市', tag:'PM2.5'},
  radar_catalog: {command:'雷达目录 [省份]', tag:'国内站点'},
};

/** Permission-driven copy. This catalogue describes capabilities; it never enables them. */
export function prepareHelpContent({features = {}, words = [], privateChat = false} = {}) {
  const enabled = key => features[key] === true;
  const preferred = ['梁圣','大肥鱼','小瘦鱼'];
  const actualWords = privateChat ? [] : [...new Set(words)];
  const displayWords = [...preferred.filter(w=>actualWords.includes(w)),...actualWords.filter(w=>!preferred.includes(w))];
  const prefix = favorite => {
    if (privateChat) return '';
    const word = actualWords.includes(favorite) ? favorite : actualWords.find(w=>[...w].length<=4);
    return (word || '@机器人') + ' ';
  };
  const weather = WEATHER_TOOLS.filter(t=>enabled(t.feature)).flatMap(t=>{
    const command=weatherLabels[t.tool]?.command || t.command;
    const rows=[{command:prefix('梁圣')+command,tag:weatherLabels[t.tool]?.tag || t.title}];
    if(t.tool==='cloud_video') rows.push({command:prefix('梁圣')+'发 历史云图 南京',tag:'近 6 小时观测'});
    return rows;
  });
  if(enabled('weather'))weather.push({command:prefix('梁圣')+'发 徒步 党岭',tag:'沿线天气与住宿'});
  const activeTools = tools.filter(t=>enabled(t.feature));
  const utilities = activeTools.map(t=>({...t,command:prefix('大肥鱼')+t.command}));
  if (enabled('voice')) utilities.push({group:'图片、语音与记忆',command:'发语音，说出问题',tag:'语音理解'});
  const scheduled = privateChat ? [] : daily.filter(t=>enabled(t.feature));
  const extra = GROUP_FEATURES.filter(t=>!t.hidden&&enabled(t.key)&&!known.has(t.key)).map(t=>({command:t.label,tag:'已开启'}));
  const examples = [];
  if (enabled('weather')) examples.push(prefix('小瘦鱼')+'北京天气如何？');
  if (enabled('radar')) examples.push(prefix('小难梁')+'外面打雷了，看看成都的雷达图');
  for (const item of activeTools) {
    if (examples.length >= 2) break;
    if (item.example) examples.push(prefix('小瘦鱼')+item.example);
  }
  return {privateChat, words:displayWords, weather, utilities, scheduled, extra, examples,
    chat:enabled('chat'), chatOff:!privateChat && features.chat === false,
    helpCommand:prefix('小瘦鱼')+'/help'};
}

// Match the weather report's export width and page background without loading its chart renderer.
const width = 440, scale = 3 * Math.SQRT2, gutter = 20, contentX = 36, contentWidth = 368;
const color = {
  background:'#f4f6f3', ink:'#173638', secondary:'#61716b', accent:'#96622f',
  border:'#dfe4dd', card:'#fdfdf9', row:'#f2f5f1', daily:'#eaf2ed',
  heroTop:'#103338', heroBottom:'#174c4b', heroInk:'#f8f6ef', heroMuted:'#c8d5d0',
  wake:'#285858', wakeBorder:'#47706c', gold:'#efe4cd', example:'#f3efe6',
  warning:'#a64036', warningFill:'#f9eae4', warningBorder:'#e9b8a7',
};
const font = (size, bold = false) => `${bold ? 'bold ' : ''}${size}px ${bold ? boldFamily : CHINESE_FONT}`;

function linesFor(ctx, value, maxWidth) {
  // Keep Latin words together when possible; never drop long custom wake words.
  const tokens = String(value).match(/(?:[A-Za-z0-9./]+|.)[，。！？、」：]*/gu) || [];
  const lines = []; let line = '';
  for (const token of tokens) {
    if (line && ctx.measureText(line + token).width > maxWidth) { lines.push(line.trimEnd()); line = ''; }
    if (ctx.measureText(token).width > maxWidth) {
      for (const ch of token) {
        if (line && ctx.measureText(line + ch).width > maxWidth) { lines.push(line.trimEnd()); line = ''; }
        line += ch;
      }
    } else line += line ? token : token.trimStart();
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

export function renderHelpImage(input) {
  const model = prepareHelpContent(input);
  const measureCanvas = createCanvas(1,1), measure = measureCanvas.getContext('2d');
  const labels = [], shapes = [], rules = [];
  function label(value,x,top,maxWidth,size=14,leading=22,fill=color.ink,bold=false) {
    measure.font=font(size,bold);
    const rows=linesFor(measure,value,maxWidth);
    for (let i=0;i<rows.length;i++) labels.push({value:rows[i],x,baseline:top+size+i*leading,size,fill,bold});
    return rows.length*leading;
  }
  function right(value,x,top,size=11,fill=color.secondary) {
    measure.font=font(size); const w=measure.measureText(value).width;
    label(value,x-w,top,w+1,size,size+4,fill);
  }
  function box(x,y,w,h,fill,radius=14,stroke=null,shadow=false) { shapes.push({x,y,w,h,fill,radius,stroke,shadow}); }
  let y=22;
  label('小瘦鱼 · BOT MANUAL',gutter,y,230,10.5,15,color.secondary);
  right('HELP / 01',width-gutter,y,10.5);
  y=49;
  label('小瘦鱼 bot 指令合集',gutter,y,400,28,40,color.ink,true);
  label('支持自然语言提问，也支持指令查询',gutter,95,400,13,21,color.secondary);

  const heroTop=128;
  label('快速开始 · QUICK START',40,heroTop+20,258,10.5,16,'#d9b476');
  label(model.privateChat?'直接发送，随时提问':'先唤醒，再提问',40,heroTop+44,280,24,34,color.heroInk,true);
  label(model.privateChat?'主人私聊无需 @ 或唤醒词':'支持 @，或唤醒词 + 空格',40,heroTop+84,350,14,22,color.heroMuted);
  y=heroTop+122;
  const wakeTop=y;
  y+=12;
  if (model.privateChat) {
    label('当前会话',52,y,320,10.5,17,'#c0d4cd');y+=22;
    y+=label('主人私聊',52,y,320,16,25,color.heroInk,true);
  } else if (model.words.length) {
    label('本群可用唤醒词',52,y,320,10.5,17,'#c0d4cd');y+=22;
    for (let i=0;i<model.words.length;i+=3) y+=label(model.words.slice(i,i+3).join('　'),52,y,320,16,26,color.heroInk);
  } else {
    label('本群唤醒方式',52,y,320,10.5,17,'#c0d4cd');y+=22;
    y+=label('@ 机器人后发送问题',52,y,320,16,25,color.heroInk);
  }
  y+=12;
  box(40,wakeTop,360,y-wakeTop,color.wake,12,color.wakeBorder);
  y+=12;
  const stripTop=y;
  const stripText=model.examples.length?'查询与计算，直接说需求即可':'下方仅显示当前会话已开启的功能';
  y+=12+label(stripText,52,y+12,336,13,21,'#314541')+12;
  box(40,stripTop,360,y-stripTop,color.gold,11);
  y+=20;
  shapes.unshift({x:20,y:heroTop,w:400,h:y-heroTop,fill:'hero',radius:22,shadow:true});
  const logoRect={x:328,y:heroTop+26,w:68,h:68};

  let section=0;
  function sectionStart(title,detail) {
    const top=y+18;y=top+20;
    label(String(++section).padStart(2,'0'),contentX,y+4,27,11.5,18,color.accent,true);
    label(title,65,y,250,20,29,color.ink,true);
    if(detail) right(detail,404,y+6,10.5);
    y+=40;rules.push({x:contentX,y,w:contentWidth});y+=14;
    return top;
  }
  function sectionEnd(top) {
    y+=18;box(20,top,400,y-top,color.card,18,color.border);
    const card=shapes.pop(); const at=shapes.findIndex(s=>s.y>=top);
    shapes.splice(at<0?shapes.length:at,0,card);
  }
  function row(item,fill=color.row) {
    const start=y, bodyX=48, bodyWidth=344;
    measure.font=font(10.5);const tagWidth=item.tag?measure.measureText(item.tag).width:0;
    const commandWidth=bodyWidth-(tagWidth?tagWidth+15:0);
    measure.font=font(15);
    const commandLines=linesFor(measure,item.command,commandWidth);
    const h=Math.max(46,commandLines.length*23+22);
    const commandTop=start+(h-commandLines.length*23)/2;
    label(item.command,bodyX,commandTop,commandWidth,15,23,color.ink);
    if(item.tag)right(item.tag,392,start+(h-15)/2,10.5);
    box(36,start,368,h,fill,12);
    y+=h+10;
  }
  if(model.weather.length) {
    const top=sectionStart('天气预报',`${model.weather.length} 项`);
    model.weather.forEach(item=>row(item));
    const hasVideos=model.weather.some(item=>/预报$/.test(item.tag));
    y+=label(hasVideos?'预报视频默认 24 小时，加 48h 可看两天。地点可换成城市、省区或大区。':'将地点替换为你想查询的位置。',36,y+2,368,11,18,color.secondary);
    sectionEnd(top);
  }
  if(model.utilities.length) {
    const top=sectionStart('实用工具',`${model.utilities.length} 项`);
    let previous;
    for(const item of model.utilities) {
      if(item.group!==previous) {
        if(previous)y+=3;
        y+=label(item.group,36,y,368,11.5,20,color.accent);y+=6;
        previous=item.group;
      }
      row(item);
    }
    y-=10;sectionEnd(top);
  }
  if(model.scheduled.length) {
    const top=sectionStart('每天 07:30','本群已订阅');
    model.scheduled.forEach(item=>row(item,color.daily));
    y+=label('按本群订阅自动推送，无需发送指令',36,y+2,368,11,18,color.secondary);
    sectionEnd(top);
  }
  if(model.extra.length) {
    const top=sectionStart('其他功能',`${model.extra.length} 项`);
    model.extra.forEach(item=>row(item));y-=10;sectionEnd(top);
  }
  const noteTop=sectionStart('使用说明','自然语言提问');
  if(model.examples.length) {
    y+=label('不必照抄指令，也可以这样问：',36,y,368,13,22,color.secondary);y+=8;
    model.examples.forEach((value,i)=>{
      const start=y;y+=12;
      label(`示例 ${String(i+1).padStart(2,'0')}`,48,y,344,10.5,16,color.accent);y+=21;
      y+=label(value,48,y,344,15,24,color.ink);y+=13;
      box(36,start,368,y-start,color.example,12);y+=10;
    });
  }
  if(model.chat) y+=label('附加功能：日常聊天',36,y+4,368,12,22,color.secondary)+6;
  if(model.chatOff) {
    const top=y+4;y=top+12;
    y+=label('为避免打扰,本群仅启用自然语言理解,chat未启用',48,y,344,12.5,21,color.warning);
    y+=12;box(36,top,368,y-top,color.warningFill,11,color.warningBorder);
  }
  if(!model.examples.length&&!model.chat&&!model.chatOff) y+=label('当前仅显示已开启的功能。',36,y,368,13,22,color.secondary);
  sectionEnd(noteTop);
  y+=20;
  y+=label(model.helpCommand,24,y,260,10.5,18,color.secondary);
  right(model.privateChat?'主人私聊帮助':'按本群功能生成',416,y-18,10.5);
  y+=18;

  const canvas=createCanvas(Math.round(width*scale),Math.round(Math.ceil(y)*scale)),ctx=canvas.getContext('2d');
  ctx.fillStyle=color.background;ctx.fillRect(0,0,canvas.width,canvas.height);ctx.scale(scale,scale);
  for(const shape of shapes) {
    ctx.save();
    if(shape.shadow){ctx.shadowColor='#0d2e3326';ctx.shadowBlur=18;ctx.shadowOffsetY=7;}
    let fill=shape.fill;
    if(fill==='hero'){fill=ctx.createLinearGradient(shape.x,shape.y,shape.x+shape.w,shape.y+shape.h);fill.addColorStop(0,color.heroTop);fill.addColorStop(1,color.heroBottom);}
    ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(shape.x,shape.y,shape.w,shape.h,shape.radius);ctx.fill();
    if(shape.stroke){ctx.strokeStyle=shape.stroke;ctx.lineWidth=.8;ctx.stroke();}ctx.restore();
  }
  for(const line of rules){ctx.fillStyle=color.border;ctx.fillRect(line.x,line.y,line.w,.7);}
  for(const item of labels){ctx.font=font(item.size,item.bold);ctx.fillStyle=item.fill;ctx.fillText(item.value,item.x,item.baseline);}
  ctx.save();ctx.beginPath();ctx.roundRect(logoRect.x,logoRect.y,logoRect.w,logoRect.h,17);ctx.clip();
  ctx.drawImage(logo,logoRect.x,logoRect.y,logoRect.w,logoRect.h);ctx.restore();
  const buffer=canvas.toBuffer('image/png');canvas.width=1;canvas.height=1;
  return {buffer,mimeType:'image/png'};
}
