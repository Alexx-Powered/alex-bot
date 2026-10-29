import {createCanvas,loadImage} from '@napi-rs/canvas';
import {renderWeatherChart} from './weather-chart.mjs';
const colors={suitable:'#23805a',caution:'#a86b00',avoid:'#bb4545',unknown:'#66758a',expired:'#8792a0'};
const labels={suitable:'较适宜',caution:'注意条件',avoid:'建议室内',unknown:'数据不足',expired:'已过时段'};
function line(ctx,text,x,y,size=24,color='#263b52',width=1064){ctx.font=`${size}px Microsoft YaHei,sans-serif`;ctx.fillStyle=color;ctx.fillText(String(text??''),x,y,width);}
function wrap(ctx,text,x,y,width,size=24,maxLines=2){
  ctx.font=`${size}px Microsoft YaHei,sans-serif`;let row='',n=0;
  for(const ch of String(text??'')){if(ctx.measureText(row+ch).width>width){line(ctx,row,x,y+n*(size+8),size);row='';if(++n>=maxLines)return;}row+=ch;}
  if(row)line(ctx,row,x,y+n*(size+8),size);
}
const shown=(value,unit='')=>typeof value==='number'&&Number.isFinite(value)?`${Math.round(value*10)/10}${unit}`:'缺数据';
const range=(value,unit)=>value&&typeof value==='object'?`${shown(value.min)}–${shown(value.max,unit)}`:'缺数据';

/** Morning report stays one image; no model-generated weather numbers. */
export async function renderMorningChart({inputs,analysis,plan}){
  if(!Array.isArray(analysis.windows)||analysis.windows.length>3)throw new Error('MORNING_CHART_INVALID');
  const base=renderWeatherChart(inputs),rows=analysis.windows;
  const height=2250+rows.length*170;
  const canvas=createCanvas(1200,height),ctx=canvas.getContext('2d');
  ctx.fillStyle='#f1f5fa';ctx.fillRect(0,0,1200,height);ctx.drawImage(await loadImage(base.buffer),0,0);
  ctx.fillStyle='#f1f5fa';ctx.fillRect(35,18,650,48);line(ctx,'亚历克斯 · 早安日报',48,49,24,'#38627a');
  if(inputs.weather.some(item=>item?.simulated===true)){
    ctx.fillStyle='#fff0dd';ctx.fillRect(40,125,620,44);line(ctx,'本地模拟预览 · 非真实天气',48,154,24,'#a65b00');
  }
  let y=1810;
  line(ctx,'04  今日运动建议',48,y+35,32);
  line(ctx,`${plan.calendar.holiday?plan.calendar.holidayName+'假期 · 天津':'日常 · 北京'}  |  本地天气适宜度，非官方运动指数`,48,y+76,23,'#596b82');
  y+=108;
  ctx.fillStyle='#ffffff';ctx.fillRect(48,y,1104,130);
  const best=analysis.recommendation;
  line(ctx,best?`优先时段  ${String(best.start).slice(11,16)||best.start}–${String(best.end).slice(11,16)||best.end}`:'暂无可靠的户外运动推荐时段',68,y+40,30,best?colors[best.level]||colors.suitable:colors.unknown);
  wrap(ctx,best?best.advice:analysis.summary,68,y+79,1064,23,2);y+=155;
  for(const row of rows){
    ctx.fillStyle='#ffffff';ctx.fillRect(48,y,1104,154);
    ctx.fillStyle=colors[row.level]||colors.unknown;ctx.fillRect(48,y,7,154);
    const start=String(row.start).includes('T')?row.start.slice(11,16):row.start;
    const end=String(row.end).includes('T')?row.end.slice(11,16):row.end;
    line(ctx,`${start}–${end}   ${labels[row.level]||'待评估'}${row.score===null||row.score===undefined?'':` · ${Math.round(row.score)}/100`}`,68,y+33,27,colors[row.level]||colors.unknown);
    if(row.level==='expired'){
      line(ctx,'该时段已结束，不再评估；请参考后续时段。',68,y+82,24,colors.expired);y+=170;continue;
    }
    const c=row.conditions||{};
    line(ctx,`温度 ${range(c.temperatureC,'°C')}  湿度 ${range(c.humidityPct,'%')}  PM2.5峰值 ${shown(c.pm25Max,' μg/m³')}`,68,y+69,23);
    line(ctx,`降水概率 ${shown(c.precipitationProbabilityMax,'%')}  日晒辐照 ${shown(c.solarRadiationMax,' W/m²')}  风 ${shown(c.windSpeedMax,' m/s')}`,68,y+101,23);
    line(ctx,row.advice,68,y+134,22);y+=170;
  }
  const notes=[...(plan.notes||[]),...(analysis.notes||[]).filter(note=>note.includes('未确认')||note.includes('单位不符'))];
  wrap(ctx,notes.slice(0,3).join('；'),48,y+25,1104,21,3);
  line(ctx,'按小时模型保守评估，非医学结论；太阳辐照不是UV，PM2.5单项不是综合AQI。',48,height-45,21,'#596b82');
  return {buffer:canvas.toBuffer('image/png'),mimeType:'image/png'};
}
