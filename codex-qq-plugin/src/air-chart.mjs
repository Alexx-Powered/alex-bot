import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { Chart, registerables } from 'chart.js';
import { validatePlace } from './locations.mjs';
import { HOUR_MS, localTime } from './weather.mjs';
import {CHINESE_FONT} from './render-fonts.mjs';
Chart.register(...registerables);
const font = CHINESE_FONT;

export function prepareAirChart(data) {
  let city;
  try { city = validatePlace(data?.city); } catch { throw new Error('CHART_CITY_INVALID'); }
  if (data?.timezone !== 'Asia/Shanghai') throw new Error('CHART_TIMEZONE_INVALID');
  const samples = data?.hourly;
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 240) throw new Error('CHART_DATA_INVALID');
  let previousTime = -Infinity;
  const points = samples.map(sample => {
    const time = typeof sample?.time === 'string' ? Date.parse(sample.time) : NaN;
    if (!Number.isFinite(time) || time % HOUR_MS !== 0 || time <= previousTime) throw new Error('CHART_TIME_INVALID');
    previousTime = time;
    return { time, pm25: typeof sample.pm25 === 'number' && Number.isFinite(sample.pm25) && sample.pm25 >= 0 && sample.pm25 <= 5000 ? sample.pm25 : null };
  });
  if (points.filter(point => point.pm25 !== null).length < 2) throw new Error('CHART_DATA_MISSING');
  const hourCount = (points.at(-1).time - points[0].time) / HOUR_MS + 1;
  if (hourCount > 240) throw new Error('CHART_TIME_INVALID');
  const byTime = new Map(points.map(point => [point.time, point.pm25]));
  const times = Array.from({ length: hourCount }, (_, i) => points[0].time + i * HOUR_MS);
  return { city, labels: times.map(time => localTime(time).slice(5, 16).replace('T', ' ')), values: times.map(time => byTime.get(time) ?? null) };
}

function titleLines(ctx, text) {
  ctx.save(); ctx.font = `bold 27px ${font}`;
  const lines = []; let line = '';
  for (const char of text) {
    if (line && ctx.measureText(line + char).width > 1100) { lines.push(line); line = ''; }
    line += char;
  }
  if (line) lines.push(line);
  ctx.restore(); return lines;
}

export function renderAirChart(data) {
  const model = prepareAirChart(data);
  const canvas=createCanvas(1200,640), ctx=canvas.getContext('2d');
  const background={id:'whiteBackground',beforeDraw(chart){const c=chart.ctx;c.save();c.globalCompositeOperation='destination-over';c.fillStyle='#f7fafc';c.fillRect(0,0,chart.width,chart.height);c.restore();}};
  const chart=new Chart(ctx,{
    type:'line',data:{labels:model.labels,datasets:[{label:`${model.city.name} PM2.5 预报`,data:model.values,borderColor:'#126b75',backgroundColor:'rgba(18,107,117,0.10)',fill:true,borderWidth:3,pointRadius:0,tension:0.15,spanGaps:false}]},
    options:{responsive:false,animation:false,devicePixelRatio:1,layout:{padding:{top:24,right:32,bottom:24,left:24}},
      font:{family:font},plugins:{legend:{display:false},title:{display:true,text:titleLines(ctx,`${model.city.name} PM2.5 模型预报（非实测）`),font:{family:font,size:27,weight:'bold'},color:'#18353c',padding:{bottom:12}},
      subtitle:{display:true,text:['CAMS Global / ECMWF · https://open-meteo.com/','北京时间 UTC+8 · 约45km网格 / 3小时数据插值 · 非AQI；缺失处断线'],font:{family:font,size:15},color:'#536b73',padding:{bottom:22}}},
      scales:{x:{grid:{display:false},ticks:{font:{family:font,size:12},maxTicksLimit:9,maxRotation:0},title:{display:true,text:'预报有效时间（北京时间）',font:{family:font,size:14}}},y:{beginAtZero:true,ticks:{font:{family:font,size:13}},title:{display:true,text:'PM2.5（μg/m³）',font:{family:font,size:14}},grid:{color:'#dde7e9'}}}},plugins:[background]});
  try { return {buffer:canvas.toBuffer('image/png'),mimeType:'image/png'}; }
  finally { chart.destroy(); }
}
