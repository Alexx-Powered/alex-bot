// Production weather report, following 北京天气日报_改进版.pptx.
import { createCanvas, GlobalFonts, Image } from '@napi-rs/canvas';
import { Chart, registerables } from 'chart.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prepareWeatherChart } from './weather-chart.mjs';
import { localTime } from './weather.mjs';
import { unavailableOutdoorIndex, validOutdoorIndex } from './outdoor-summary.mjs';
import { encodePngTiles } from './png-strips.mjs';
import { CHINESE_FONT } from './render-fonts.mjs';
import { TEMPERATURE_STOPS, PM25_BANDS, temperatureColor, temperatureTextColor, pm25Band } from './chart-colors.mjs';

Chart.register(...registerables);
const assets = name => fileURLToPath(new URL(`../public/weather-report/${name}`, import.meta.url));
const noto = ['C:/Windows/Fonts/NotoSansSC-VF.ttf', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].find(existsSync);
if (noto) GlobalFonts.registerFromPath(noto, 'Weather Noto');
GlobalFonts.registerFromPath(assets('GeistMono.ttf'), 'Weather Mono');
const FONT = noto ? 'Weather Noto' : CHINESE_FONT, MONO = `Weather Mono, ${FONT}`;
export const WEATHER_REPORT_STYLE = Object.freeze({
  width: 440, scale: 3 * Math.SQRT2, background: '#f4f6f3', ink: '#142a32', muted: '#66766f',
  border: '#e0e8e3', cloud: '#b8b8b8', cloudFill: '#e8e8e8', rain: '#3986c8',
});
const S = WEATHER_REPORT_STYLE;
const emptyGlyph = createCanvas(1, 1).toBuffer('image/png');
async function releaseOutdoorGlyph(glyph) {
  if (!glyph) return;
  if ('getContext' in glyph) { glyph.width = 1; glyph.height = 1; }
  else { glyph.src = emptyGlyph; await glyph.decode(); }
}
// Decode only the selected brush, within the existing image-render queue.
async function loadOutdoorGlyph(index) {
  if (index?.status !== 'complete') return null;
  const key = { '夯': 'excellent', '可': 'fair', '拉': 'poor' }[index.character];
  if (!key) return null;
  const glyph = new Image(); glyph.src = readFileSync(assets(`outdoor/${key}.png`));
  await glyph.decode();
  if (!index.gold&&!index.dailyDanger) return glyph;
  const gold = createCanvas(glyph.width, glyph.height), c = gold.getContext('2d');
  c.drawImage(glyph, 0, 0); c.globalCompositeOperation = 'source-in';
  const color = c.createLinearGradient(0, 0, glyph.width, glyph.height);
  color.addColorStop(0, '#b67c12'); color.addColorStop(0.48, '#e6bf58'); color.addColorStop(1, '#9c6810');
  c.fillStyle = index.dailyDanger?'#c42336':color; c.fillRect(0, 0, glyph.width, glyph.height);
  await releaseOutdoorGlyph(glyph);
  return gold;
}
const conditionIcons=Object.fromEntries(await Promise.all(
  ['sunny','partly-cloudy','overcast','light-rain','heavy-rain','thunderstorm','snow','fog'].map(async key=>{
    let svg=readFileSync(assets(`conditions/${key}.svg`),'utf8');
    // One supplied SVG lacks a viewBox. Add its original 84x84 viewport before high-DPI rasterization.
    if(!/<svg\b[^>]*\bviewBox=/u.test(svg))svg=svg.replace('<svg ','<svg viewBox="0 0 84 84" ');
    const icon=new Image(Math.ceil(76*S.scale),Math.ceil(76*S.scale));icon.src=Buffer.from(svg);await icon.decode();
    return [key,icon];
  })
));
/** Rendering accepts only the already-classified summary for this report's first calendar day. */
export function weatherReportCondition(weather,date) {
  const value=weather?.weatherSummary;
  return value?.date===date&&Object.hasOwn(conditionIcons,value.icon)&&Number.isInteger(value.code)&&
    typeof value.label==='string'&&/^[\p{Script=Han}]{1,16}$/u.test(value.label)?value:null;
}
const number = v => typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '—';
const valid = values => values.filter(v => typeof v === 'number' && Number.isFinite(v));
const limits = values => { const v = valid(values); return v.length ? [Math.min(...v), Math.max(...v)] : [null, null]; };
const total = values => values.length && values.every(v => typeof v === 'number' && Number.isFinite(v)) ? values.reduce((a, b) => a + b, 0) : null;
const range = (values, unit = '') => { const [lo, hi] = limits(values); return lo === null ? '缺数据' : `${number(lo)}–${number(hi)}${unit}`; };
const timeSpan = row => `${String(row.start).slice(11, 16)}–${String(row.end).slice(11, 16)}`;
const dayDate = date => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
const levels = { suitable: ['较适宜', '#256c64', '#eff6f2'], caution: ['注意条件', '#8a6539', '#f6f1e8'], avoid: ['建议室内', '#9b4155', '#fbf3f0'], expired: ['已结束', '#7b8983', '#f3f5f3'], unknown: ['数据不足', '#66766f', '#f3f5f3'] };

function text(c, value, x, y, size = 11, color = S.ink, weight = 400, { mono = false, align = 'left', maxWidth } = {}) {
  c.save(); c.font = `${weight} ${size}px ${mono ? MONO : FONT}`; c.fillStyle = color; c.textAlign = align;
  c.fillText(String(value), x, y, maxWidth); c.restore();
}
function wrap(c, value, x, y, width, size = 11, color = S.muted, lineHeight = 17, maxLines = 2) {
  c.save(); c.font = `400 ${size}px ${FONT}`;
  const lines = []; let line = '';
  for (const ch of String(value)) {
    if (c.measureText(line + ch).width > width && line) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((row, i) => text(c, row, x, y + i * lineHeight, size, color)); c.restore();
  return Math.min(lines.length, maxLines) * lineHeight;
}
function rect(c, x, y, w, h, color, radius = 17, stroke) {
  c.save(); c.beginPath(); c.roundRect(x, y, w, h, radius); c.fillStyle = color; c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1; c.stroke(); } c.restore();
}
function card(c, y, h, index, title, source, color = '#2b7a78') {
  rect(c, 20, y, 400, h, '#ffffff', 18, S.border);
  text(c, index, 36, y + 30, 11, color, 500, { mono: true });
  text(c, title, 58, y + 32, 17, S.ink, 700);
  text(c, source, 404, y + 30, 8.5, '#7b8983', 400, { mono: true, align: 'right', maxWidth: 140 });
}
function gradient(chart, stops) {
  const y = chart.scales.y;
  if (!y) return stops[0].color;
  const lo = stops[0].value, hi = stops.at(-1).value;
  const g = chart.ctx.createLinearGradient(0, y.getPixelForValue(lo), 0, y.getPixelForValue(hi));
  for (const s of stops) g.addColorStop((s.value - lo) / (hi - lo), s.color);
  return g;
}
function airGradient(chart) {
  const y = chart.scales.y;
  if (!y) return PM25_BANDS[0].lineColor;
  // Soften only a 3 CSS-pixel-high strip around each concentration boundary.
  // All band interiors, thresholds, numeric labels and legend swatches stay fixed.
  const pixels = Math.abs(y.getPixelForValue(y.max) - y.getPixelForValue(y.min));
  const halfTransition = pixels > 0 ? (y.max - y.min) * 1.5 / pixels : 0;
  const stops = [{ value: 0, color: PM25_BANDS[0].lineColor }];
  PM25_BANDS.slice(0, -1).forEach((s, i) => {
    const lower = i ? PM25_BANDS[i - 1].upper : 0;
    const half = Math.min(halfTransition, (s.upper - lower) / 4, (PM25_BANDS[i + 1].upper - s.upper) / 4);
    stops.push({ value: s.upper - half, color: s.lineColor }, { value: s.upper + half, color: PM25_BANDS[i + 1].lineColor });
  });
  stops.push({ value: 500, color: PM25_BANDS.at(-1).lineColor });
  return gradient(chart, stops);
}
function tempLegend(c) {
  const left = 239, width = 165, top = 505;
  text(c, '固定温标 °C', left, top - 10, 9, S.muted);
  const g = c.createLinearGradient(left, 0, left + width, 0);
  TEMPERATURE_STOPS.forEach((s, i) => g.addColorStop(i / (TEMPERATURE_STOPS.length - 1), s.color));
  rect(c, left, top, width, 4, g, 2);
  TEMPERATURE_STOPS.forEach((s, i) => text(c, s.value, left + i * width / 5, top + 18, 8.5, S.muted, 400, { mono: true, align: 'center' }));
}
function airLegend(c, y) {
  const labels = ['0–35', '35–60', '60–115', '115–150', '150–250', '>250'], width = 368 / 6;
  PM25_BANDS.forEach((s, i) => {
    rect(c, 36 + i * width, y, width - 3, 4, s.lineColor, 1.5);
    text(c, labels[i], 36 + (i + 0.5) * width - 1.5, y + 18, 8.1, S.muted, 400, { mono: true, align: 'center' });
  });
}
function boundary() {
  return { id: 'reportMidnight', beforeDatasetsDraw(chart) {
    const { ctx: c, chartArea: a, scales: { x } } = chart;
    c.save(); c.strokeStyle = '#cbd7d0'; c.lineWidth = 0.8; c.setLineDash([3, 4]);
    c.beginPath(); c.moveTo(x.getPixelForValue(24), a.top); c.lineTo(x.getPixelForValue(24), a.bottom); c.stroke(); c.restore();
  } };
}
function extrema(kind) {
  return { id: `reportExtrema-${kind}`, afterDatasetsDraw(chart) {
    const dataset = chart.data.datasets[0], points = chart.getDatasetMeta(0).data;
    const chosen = [];
    for (let day = 0; day < 2; day++) {
      const series = dataset.data.map((p, i) => ({ value: p.y, i })).slice(day * 24, (day + 1) * 24).filter(p => p.value !== null);
      if (!series.length) continue;
      if (kind === 'temperature') chosen.push(series.reduce((a, b) => a.value <= b.value ? a : b));
      chosen.push(series.reduce((a, b) => a.value >= b.value ? a : b));
    }
    const seen = new Set(), placed = [];
    for (const { value, i } of chosen) {
      if (seen.has(i)) continue; seen.add(i);
      const p = points[i], c = chart.ctx, a = chart.chartArea;
      const color = kind === 'temperature' ? temperatureTextColor(value) : pm25Band(value)?.lineColor || S.muted;
      const label = number(value) + (kind === 'temperature' ? '°' : '');
      c.save(); c.font = `500 9px ${MONO}`;
      const width = c.measureText(label).width + 6;
      const x = Math.max(a.left, Math.min(p.x - width / 2, a.right - width));
      let y = Math.max(a.top + 2, p.y - 18);
      if (placed.some(b => x < b.x + b.w && x + width > b.x && Math.abs(y - b.y) < 15)) y = Math.min(a.bottom - 14, p.y + 7);
      if (placed.some(b => x < b.x + b.w && x + width > b.x && Math.abs(y - b.y) < 15)) { c.restore(); continue; }
      placed.push({ x, y, w: width });
      c.strokeStyle = '#ffffff'; c.lineWidth = 3; c.lineJoin = 'round'; c.strokeText(label, x + 3, y + 10);
      c.fillStyle = color; c.fillText(label, x + 3, y + 10);
      c.beginPath(); c.arc(p.x, p.y, 2.8, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = color; c.lineWidth = 1.5; c.stroke(); c.restore();
    }
  } };
}
function plot(c, { top, height = 147, min, max, percent = false, dual = false, datasets, plugins = [] }) {
  const transform=c.getTransform(),pixelTop=top*transform.d+transform.f;
  if(pixelTop+height*transform.d<0||pixelTop>c.canvas.height)return;
  const width = dual ? 344 : 368, surface = createCanvas(width, height);
  const axes = { min, max, offset: true, afterFit: s => { s.width = 31; },
    border: { display: false }, grid: { color: '#e6ece8', drawTicks: false },
    ticks: { color: '#728078', font: { family: MONO, size: 9 }, padding: 5, maxTicksLimit: 5,
      ...(percent ? { stepSize: 25, callback: v => `${v}%` } : {}) } };
  const chart = new Chart(surface.getContext('2d'), { type: 'line', data: { datasets: datasets.map(d => ({
    type: 'line', pointRadius: 0, borderWidth: 2.5, spanGaps: false, cubicInterpolationMode: 'monotone', tension: 0.25, clip: 3, ...d,
  })) }, options: { responsive: false, animation: false, devicePixelRatio: S.scale,
    layout: { padding: { top: 11, bottom: 0 } }, plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { type: 'linear', min: 0, max: 48, offset: false, grid: { display: false }, border: { display: false },
        ticks: { stepSize: 12, autoSkip: false, maxRotation: 0, padding: 10, color: '#728078', font: { family: MONO, size: 8.7 },
          callback: value => value === 48 ? '24:00' : `${String(value % 24).padStart(2, '0')}:00` } },
      y: { ...axes },
      yRight: { ...axes, position: 'right', afterFit: s => { s.width = dual ? 43 : 31; }, grid: { display: false },
        ticks: { ...axes.ticks, color: dual ? '#8b8b8b' : '#ffffff', callback: value => dual ? `${value}%` : '' } },
    } }, plugins: [boundary(), ...plugins] });
  try {
    c.drawImage(surface, dual ? 48 : 36, top, width, height);
    if (!datasets.some(d => d.data.some(p => p.y !== null))) text(c, '暂无有效数据', 220, top + height / 2, 12, S.muted, 400, { align: 'center' });
  } finally { chart.destroy(); surface.width = 1; surface.height = 1; }
}
function dates(c, model, y) {
  text(c, `${dayDate(model.date)} ${model.dayLabels[0]}`, 145, y, 9, S.muted, 400, { align: 'center' });
  text(c, `${dayDate(model.nextDate)} ${model.dayLabels[1]}`, 297, y, 9, S.muted, 400, { align: 'center' });
}
const points = (values, offset = 0) => values.map((y, i) => ({ x: i + offset, y }));
function dailyAdvice(c, analysis, firstDay) {
  if(analysis.dailyDanger){
    rect(c,40,357,360,42,'#fff0f0',12);
    text(c,'0 分 · 拉',52,384,17,'#af1930',700);
    text(c,'全天应当避免外出',143,383,15,'#922036',650);
    return;
  }
  const { word, suffix } = analysis.recommendation;
  c.save(); c.font = '600 12px ' + FONT;
  const width = Math.max(42, c.measureText(word).width + 16); c.restore();
  // Leave the rounded highlight opening unpainted so the existing hero gradient shows through.
  c.save(); c.fillStyle = '#f5e7d9'; c.beginPath();
  c.roundRect(40, 357, 360, 42, 12);
  c.roundRect(94, 365, width, 27, 8);
  c.fill('evenodd'); c.restore();
  text(c, firstDay + '：', 52, 383, 12, '#7f4a3d', 500);
  text(c, word, 94 + width / 2, 383, 12, '#ffffff', 650, { align: 'center' });
  text(c, suffix, 94 + width + 10, 383, 12, '#7f4a3d', 500);
}

function exercise(c, analysis, city, y) {
  card(c, y, 244, '04', '户外时段', city);
  const styles = {
    poor: { ink: '#9b4155', background: '#fbf3f0' },
    fair: { ink: '#8a6539', background: '#f6f1e8' },
    excellent: { ink: '#256c64', background: '#eff6f2' },
    gold: { ink: '#9b701a', background: '#faf3df' },
    unknown: { ink: S.muted, background: '#f3f5f3' },
  };
  analysis.periods.forEach((row, i) => {
    const yy = y + 56 + i * 92, style = styles[row.grade], d = row.conditions;
    const selected = row.name === analysis.bestPeriod;
    rect(c, 36, yy, 368, 80, style.background, 13, selected ? '#c8baa5' : undefined);
    text(c, row.name, 48, yy + 24, 13, S.ink, 650);
    text(c, String(row.startHour).padStart(2, '0') + ':00–' + String(row.endHour).padStart(2, '0') + ':00', 88, yy + 23, 10, S.muted, 400, { mono: true });
    text(c, row.status === 'complete' ? number(row.displayScore) + ' 分 · ' + (row.gold ? '夯中夯' : row.character) : '暂不评级', 392, yy + 24, 12, style.ink, 650, { mono: true, align: 'right' });
    text(c, d ? '云量 ' + Math.round(d.cloudMean) + '% · PM2.5 ' + number(d.pm25Peak) + ' μg/m³ · 雨量 ' + d.rainTotal.toFixed(1) + ' mm' : '不以缺测值推算户外指数', 48, yy + 46, 9.7, '#6f625d', 400, { maxWidth: 344 });
    text(c, row.reason, 48, yy + 66, 10.5, analysis.dailyDanger?'#b51d31':style.ink, 500, { maxWidth: 344 });
  });
  return y + 244;
}

/** Receives verified forecasts and existing Python rule results. */
export async function renderWeatherReportImage({ inputs, analysis: legacyAnalysis = null, morning = false } = {}) {
  const model = prepareWeatherChart(inputs);
  if (model.cities.length !== 1) throw new Error('WEATHER_REPORT_SINGLE_CITY_REQUIRED');
  if (legacyAnalysis && (legacyAnalysis.date !== model.date || legacyAnalysis.city !== model.cities[0])) throw new Error('WEATHER_REPORT_ANALYSIS_MISMATCH');
  const analysis = inputs.outdoorIndex || unavailableOutdoorIndex(model.date, model.cities[0]);
  if (!validOutdoorIndex(analysis, model.date, model.cities[0])) throw new Error('WEATHER_REPORT_ANALYSIS_MISMATCH');
  const outdoorGlyph = await loadOutdoorGlyph(analysis);
  const s = model.weatherSeries[0], air = model.airSeries, today = s.temperatureC.slice(0, 24);
  const weather = inputs.weather[0];
  const visualCrossing = weather?.source?.model==='ecmwf_2'&&weather.source.provider==='Visual Crossing';
  const airSource = inputs.air?.source?.model==='gefs_aerosols'?'NOAA GEFS-Aerosols':'CAMS / ECMWF';
  const archiveTime = Date.parse(weather?.archiveFetchedAt);
  const firstDay=model.dayLabels[0]==='今天'?'今日':model.dayLabels[0];
  const condition=weatherReportCondition(inputs.weather[0],model.date);
  const [low, high] = limits(today), todayRain = total(s.precipitationMm.slice(0, 24)), tomorrowRain = total(s.precipitationMm.slice(24));
  const todayAir = air.values.slice(0, 24), todayPeak = limits(todayAir)[1];
  const extraHeight = 244;
  const footer = analysis ? 1410 + extraHeight + 24 : 1420;
  const reasons=analysis.dailyDanger?.reasons||[];
  const noticeHeight=reasons.length?57+20*reasons.length:0;
  const height = footer + 87 + 31+noticeHeight;
  const widthPx=Math.round(S.width*S.scale),heightPx=Math.round(height*S.scale);
  function drawReport(c) {
  c.fillStyle = S.background; c.fillRect(0, 0, S.width, height);
  // Oversized brush lettering is below every report element and clips at the canvas edge.
  if (outdoorGlyph) c.drawImage(outdoorGlyph, 224, -29, 280, 280);
  text(c, morning || legacyAnalysis ? '亚历克斯 · 早安日报' : '亚历克斯 · 天气日报', 20, 31, 10.5, S.muted);

  text(c, `${s.name}天气`, 20, 76, 30, S.ink, 750, { maxWidth: 210 });
  text(c, `${model.date.slice(5).replace('-', '.')} — ${model.nextDate.slice(5).replace('-', '.')}`, 20, 102, 10.5, S.muted, 500, { mono: true });
  text(c, `${model.dayLabels[0]} 00:00 — ${model.dayLabels[1]} 24:00`, 20, 125, 10, '#7a8982');
  text(c, '模型预报 · UTC+8', 20, 141, 9.5, '#7a8982');

  c.translate(0, 31);

  const hero = c.createLinearGradient(20, 127, 420, 419); hero.addColorStop(0, '#0d2130'); hero.addColorStop(1, '#145257');
  c.save(); c.shadowColor = '#0d2e3320'; c.shadowBlur = 24; c.shadowOffsetY = 9; rect(c, 20, 127, 400, 292, hero, 24); c.restore();
  // Continue the same brush strokes through the card, below the opaque caption and all content.
  c.save();
  c.beginPath(); c.roundRect(20, 127, 400, 292, 24); c.clip();
  c.globalAlpha = 0.18;
  if (outdoorGlyph) c.drawImage(outdoorGlyph, 224, -29 - 31, 280, 280);
  c.restore();
  rect(c, 324, 141, 76, 25, S.background, 6);
  text(c, '户外指数', 362, 157, 10, S.muted, 500, { align: 'center' });
  text(c, `${firstDay}温度区间`, 40, 171, 12, '#b7ccc8');
  text(c, `${number(low)}° — ${number(high)}°`, 40, 211, 30, '#f7fbf9', 650, { mono: true, maxWidth: 278 });
  if(condition)c.drawImage(conditionIcons[condition.icon],324,177,76,76);
  if(!condition)text(c,'天气类型缺数据',362,220,10,'#dcebe6',500,{align:'center',maxWidth:84});
  const rainNote = todayRain === null ? `${firstDay}降水数据不完整` : todayRain > 0 ? `${firstDay}有降水，出门记得带伞` : `${firstDay}暂无明显降水`;
  const airNote = todayPeak === null ? 'PM2.5 数据暂缺' : `PM2.5 峰值 ${number(todayPeak)} μg/m³`;
  wrap(c, `${rainNote}；${airNote}。`, 40, 263, 360, 12.5, '#e7f1ee', 18, 2);
  const wind = inputs.weather[0]?.windBrief?.[0]?.split('·')[0]?.trim() || '缺数据';
  [['降水', `${number(todayRain)} mm`], ['风', wind], ['湿度', range(s.humidityPct.slice(0, 24), '%')]].forEach(([label, value], i) => {
    const x = 40 + i * 122;
    rect(c, x, 284, 114, 57, '#1c4651', 13); text(c, label, x + 10, 305, 10, '#a9c3c0');
    text(c, value, x + 10, 326, label === '风' ? 10.5 : 13, '#f7fbf9', 500, { mono: label !== '风', maxWidth: 96 });
  });
  // The advice helper paints the plate around a transparent opening.
  dailyAdvice(c, analysis, firstDay);
  if(noticeHeight){
    rect(c,20,435,400,noticeHeight-12,'#fff1f1',16,'#ecc0c5');
    text(c,'全天清零原因',36,459,13,'#9e1e32',650);
    reasons.forEach((reason,i)=>text(c,reason,36,481+20*i,12,'#922036',500,{maxWidth:368}));
    c.translate(0,noticeHeight);
  }

  card(c, 435, 308, '01', '温度趋势', visualCrossing?'ECMWF / Visual Crossing':'ECMWF IFS / Open-Meteo');
  text(c, `${firstDay}最低`, 36, 497, 10, '#7b8983'); text(c, `${firstDay}最高`, 128, 497, 10, '#7b8983');
  text(c, `${number(low)}°C`, 36, 523, 20, low === null ? S.muted : temperatureTextColor(low), 650, { mono: true });
  text(c, `${number(high)}°C`, 128, 523, 20, high === null ? S.muted : temperatureTextColor(high), 650, { mono: true });
  tempLegend(c); text(c, '气温 °C', 36, 553, 9.5, S.muted);
  const [minT, maxT] = limits(s.temperatureC), margin = Math.max(2, ((maxT ?? 0) - (minT ?? 0)) * 0.16);
  plot(c, { top: 557, height: 138, min: Math.floor(((minT ?? 0) - margin) / 5) * 5, max: Math.ceil(((maxT ?? 20) + margin) / 5) * 5,
    datasets: [{ label: '气温', data: points(s.temperatureC), borderColor: ({ chart }) => gradient(chart, TEMPERATURE_STOPS), backgroundColor: '#247b7210', fill: 'origin' }], plugins: [extrema('temperature')] });
  dates(c, model, 707);
  text(c, `${model.dayLabels[0]} ${range(today, '°C')}  /  ${model.dayLabels[1]} ${range(s.temperatureC.slice(24), '°C')}${s.temperatureC.includes(null) ? ' · 有数据缺失' : ''}`, 36, 729, 10, S.muted, 400, { maxWidth: 368 });

  card(c, 759, 311, '02', '空气质量', airSource, '#9b4155');
  text(c, `PM2.5 · ${firstDay}峰值`, 36, 830, 12, S.muted);
  text(c, `${number(todayPeak)} μg/m³`, 404, 830, 20, pm25Band(todayPeak)?.lineColor || S.muted, 650, { mono: true, align: 'right' });
  airLegend(c, 847); text(c, 'PM2.5 μg/m³', 36, 891, 9.5, S.muted);
  const maxAir = limits(air.values)[1] || 20;
  plot(c, { top: 896, height: 129, min: 0, max: Math.max(20, Math.ceil(maxAir / 20) * 20),
    datasets: [{ label: 'PM2.5', data: points(air.values), borderColor: ({ chart }) => airGradient(chart), backgroundColor: '#9b41550b', fill: 'origin' }], plugins: [extrema('air')] });
  dates(c, model, 1036);
  text(c, `48 小时浓度 ${range(air.values, ' μg/m³')} · 浓度色阶，非综合 AQI${air.values.includes(null) ? ' · 有缺失' : ''}`, 36, 1056, 9.6, S.muted, 400, { maxWidth: 368 });

  card(c, 1086, 311, '03', '降水与云量', visualCrossing?'ECMWF / Visual Crossing':'ECMWF IFS');
  rect(c, 36, 1138, 368, 211, '#ffffff', 14, S.border);
  rect(c, 51, 1156, 15, 3, S.cloud, 1); text(c, '云量', 74, 1162, 11, '#6b6b6b');
  rect(c, 155, 1152, 6, 10, S.rain, 2); text(c, '降水概率', 169, 1162, 11, '#356f9f');
  text(c, '降水概率 %', 50, 1187, 9, '#356f9f'); text(c, '云量 %', 390, 1187, 9, '#707070', 400, { align: 'right' });
  plot(c, { top: 1191, height: 137, min: 0, max: 100, percent: true, dual: true,
    datasets: [
      { label: '云量', data: points(s.cloudCoverPct), yAxisID: 'yRight', borderColor: S.cloud, backgroundColor: S.cloudFill, fill: 'origin', borderWidth: 1.6, order: 2 },
      { type: 'bar', label: '降水概率', data: points(s.precipitationProbabilityPct, 0.5), yAxisID: 'y', backgroundColor: S.rain, borderWidth: 0, borderRadius: 1.3, barPercentage: 0.72, categoryPercentage: 1, order: 1 },
    ] });
  dates(c, model, 1341);
  text(c, `${model.dayLabels[0]}降水 ${number(todayRain)} mm  /  ${model.dayLabels[1]} ${number(tomorrowRain)} mm`, 36, 1371, 10, S.muted);
  text(c, `最高小时降水概率 ${number(limits(s.precipitationProbabilityPct)[1])}%${s.cloudCoverPct.includes(null) || s.precipitationProbabilityPct.includes(null) ? ' · 部分数据缺失' : ''}`, 36, 1387, 9.5, S.muted);

  if (analysis) exercise(c, analysis, s.name, 1410);
  c.strokeStyle = S.border; c.lineWidth = 1; c.beginPath(); c.moveTo(20, footer); c.lineTo(420, footer); c.stroke();
  text(c, visualCrossing?`天气 ECMWF / Visual Crossing Weather · PM2.5 ${airSource}`:
    `温度 / 降水 / 云量：ECMWF IFS · PM2.5：${airSource}`, 20, footer + 19, 9, '#7b8983');
  const fetched = Date.parse(s.fetchedAt), airFetched = Date.parse(air.fetchedAt);
  text(c, `数据获取：${s.name}${Number.isFinite(inputs.places?.[0]?.latitude) && Number.isFinite(inputs.places[0].longitude) ? '（'+inputs.places[0].latitude.toFixed(3)+', '+inputs.places[0].longitude.toFixed(3)+'）' : ''} ${Number.isFinite(fetched) ? localTime(fetched).slice(5).replace('T', ' ') : '未获取'} · 空气 ${Number.isFinite(airFetched) ? localTime(airFetched).slice(11) : '未获取'}`, 20, footer + 39, 9, '#7b8983');
  if(visualCrossing){
    const archived=Number.isFinite(archiveTime)?' · 凌晨预报存于昨晚 '+localTime(archiveTime).slice(11):'';
    text(c, '降水概率 ECMWF ENS / Open-Meteo'+archived, 20, footer + 58, 9, '#7b8983');
  }else{
    text(c, inputs.places?.some(p=>/^(osm-|landmark-)/.test(p.id)) ? '代表坐标 · 地名 © OpenStreetMap contributors / Wikimedia' : '模型预报，非实测 · 北京时间 · open-meteo.com', 20, footer + 58, 9, '#7b8983', {maxWidth:400});
  }
  if (analysis) text(c, (analysis.dailyDanger?'户外指数 · 全天清零':'户外指数为自定义评分 · 采用上午、下午中较高分')+
    (analysis.warningPartial?' · 官方红色预警覆盖不完整':''), 20, footer + 76, 9, '#7b8983');
  }
  // Draw into bounded pixel tiles; never allocate a full-height canvas or its
  // second encoding snapshot. Pixel offsets keep the approved layout unchanged.
  try {
    const buffer=await encodePngTiles({width:widthPx,height:heightPx,renderTile:(top,tileHeight)=>{
      const tile=createCanvas(widthPx,tileHeight),context=tile.getContext('2d');
      try {
        context.setTransform(S.scale,0,0,S.scale,0,-top);drawReport(context);
        return context.getImageData(0,0,widthPx,tileHeight).data;
      } finally {tile.width=1;tile.height=1;}
    }});
    return {buffer,mimeType:'image/png'};
  } finally {await releaseOutdoorGlyph(outdoorGlyph);}
}
