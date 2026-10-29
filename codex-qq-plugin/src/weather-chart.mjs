import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { Chart, registerables } from 'chart.js';
import { HOUR_MS, localDate, localTime, forecastNow } from './weather.mjs';
import { TEMPERATURE_STOPS, PM25_BANDS, temperatureColor, temperatureTextColor } from './chart-colors.mjs';
import { CITIES, validatePlace } from './locations.mjs';
import {CHINESE_FONT} from './render-fonts.mjs';

Chart.register(...registerables);

const FONT = CHINESE_FONT;
const WIDTH = 1200, HEIGHT = 1800;
const COLORS = { ink: '#17263c', muted: '#596b82', faint: '#e6edf5' };
const SERIES_COLORS = ['#2563eb', '#db721e'];
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const number = value => value === null ? '缺数据' : String(Math.round(value * 10) / 10);
const fail = code => { throw new Error(code); };

function valuesByHour(rows, start, count, fields) {
  if (!Array.isArray(rows) || rows.length > 240) fail('WEATHER_CHART_DATA_INVALID');
  const byTime = new Map();
  for (const row of rows) {
    const time = typeof row?.time === 'string' ? Date.parse(row.time) : NaN;
    if (!Number.isFinite(time) || time % HOUR_MS !== 0 || byTime.has(time)) fail('WEATHER_CHART_TIME_INVALID');
    byTime.set(time, row);
  }
  return Object.fromEntries(Object.entries(fields).map(([field, bounds]) => [field,
    Array.from({ length: count }, (_, hour) => finite(byTime.get(start + hour * HOUR_MS)?.[field], ...bounds))]));
}

/** Pure normalization keeps missing values distinct from zero and prevents city substitution. */
export function prepareWeatherChart({ date, cities = ['beijing'], places, weather, air = null, now: inputNow = Date.now() } = {}) {
  const now = forecastNow(inputNow);
  date ??= localDate(now);
  const midnight = Date.parse(`${date}T00:00:00+08:00`);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight) || localDate(midnight) !== date) fail('WEATHER_CHART_DATE_INVALID');
  if (!Array.isArray(cities) || ![1, 2].includes(cities.length) || new Set(cities).size !== cities.length) fail('WEATHER_CHART_CITY_INVALID');
  if (places === undefined) places = cities.map(city => Object.hasOwn(CITIES, city) ? CITIES[city] : null);
  if (!Array.isArray(places) || places.length !== cities.length) fail('WEATHER_CHART_CITY_INVALID');
  try { places = places.map(place => validatePlace(place)); } catch { fail('WEATHER_CHART_CITY_INVALID'); }
  if (places.some((place, i) => place.id !== cities[i])) fail('WEATHER_CHART_CITY_MISMATCH');
  if (!Array.isArray(weather) || weather.length !== cities.length) fail('WEATHER_CHART_DATA_INVALID');
  const weatherSeries = cities.map((city, i) => {
    const result = weather[i];
    if (result !== null && result !== undefined && (result.city?.id !== city || result.date !== date || result.timezone !== 'Asia/Shanghai')) fail('WEATHER_CHART_CITY_MISMATCH');
    const values = valuesByHour(result?.hourly ?? [], midnight, 24, {
      temperatureC: [-90, 65], humidityPct: [0, 100], precipitationMm: [0, 1000], precipitationProbabilityPct: [0, 100],
    });
    return { id: city, name: places[i].name, color: SERIES_COLORS[i], lineDash: i === 1 ? [12, 7] : [], ...values, fetchedAt: result?.fetchedAt ?? null };
  });
  const airStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  // Dual-city reports display one explicitly identified city's PM2.5 forecast.
  const airCity = cities.includes('beijing') ? 'beijing' : cities[0];
  const airPlace = places[cities.indexOf(airCity)];
  if (air !== null && (air?.city?.id !== airCity || air?.timezone !== 'Asia/Shanghai')) fail('WEATHER_CHART_AIR_CITY_MISMATCH');
  const airValues = valuesByHour(air?.hourly ?? [], airStart, 48, { pm25: [0, 5000] }).pm25;
  return { date, now, cities: [...cities], places, weatherSeries,
    airSeries: { id: airCity, name: airPlace.name, enabled: true, values: airValues, start: airStart, fetchedAt: air?.fetchedAt ?? null },
    hours: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')) };
}

function write(ctx, text, x, y, size = 24, color = COLORS.ink, weight = 'normal', align = 'left') {
  ctx.save(); ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(text, x, y); ctx.restore();
}
function fitText(ctx, text, x, y, width, size = 22, color = COLORS.muted, weight = 'normal', align = 'left') {
  let fontSize = size;
  while (fontSize > 18) { ctx.font = `${weight} ${fontSize}px ${FONT}`; if (ctx.measureText(text).width <= width) break; --fontSize; }
  // maxWidth also bounds unusually long administrative names at the minimum size.
  ctx.save(); ctx.font = `${weight} ${fontSize}px ${FONT}`; ctx.fillStyle = color;
  ctx.textAlign = align; ctx.fillText(text, x, y, width); ctx.restore();
}
function shortLabel(ctx, text, width, size = 20, weight = 'normal') {
  ctx.save(); ctx.font = `${weight} ${size}px ${FONT}`;
  let chars = [...text], result = text;
  while (ctx.measureText(result).width > width && chars.length > 4) {
    chars.splice(Math.floor(chars.length / 2), 1);
    const midpoint = Math.ceil(chars.length / 2);
    result = `${chars.slice(0, midpoint).join('')}…${chars.slice(midpoint).join('')}`;
  }
  ctx.restore(); return result;
}
function panel(ctx, top, height, title, right) {
  ctx.save(); ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(40, top, 1120, height, 24); ctx.fill(); ctx.restore();
  fitText(ctx, title, 68, top + 48, right ? 680 : 1064, 31, COLORS.ink, 'bold');
  if (right) write(ctx, right, 1132, top + 46, 22, COLORS.muted, 'normal', 'right');
}
function placeholder(ctx, centerY, title, subtitle) {
  write(ctx, '—', WIDTH / 2, centerY - 48, 52, '#b5c0cf', 'bold', 'center');
  fitText(ctx, title, WIDTH / 2, centerY, 1064, 29, COLORS.muted, 'bold', 'center');
  write(ctx, subtitle, WIDTH / 2, centerY + 42, 22, COLORS.muted, 'normal', 'center');
}
function rangeLabel(values, unit) {
  const valid = values.filter(value => value !== null);
  if (!valid.length) return '缺数据';
  return `${number(Math.min(...valid))}–${number(Math.max(...valid))}${unit}${valid.length < values.length ? '（部分）' : ''}`;
}

function temperatureGradient({ chart }) {
  const scale = chart.scales.y;
  if (!scale || !chart.chartArea) return temperatureColor(10);
  const low = TEMPERATURE_STOPS[0].value, high = TEMPERATURE_STOPS.at(-1).value;
  const gradient = chart.ctx.createLinearGradient(0, scale.getPixelForValue(low), 0, scale.getPixelForValue(high));
  for (const stop of TEMPERATURE_STOPS) gradient.addColorStop((stop.value - low) / (high - low), stop.color);
  return gradient;
}
function pm25Gradient({ chart }) {
  const scale = chart.scales.y;
  if (!scale || !chart.chartArea) return PM25_BANDS[0].lineColor;
  const gradient = chart.ctx.createLinearGradient(0, scale.getPixelForValue(0), 0, scale.getPixelForValue(500));
  gradient.addColorStop(0, PM25_BANDS[0].lineColor);
  PM25_BANDS.slice(0, -1).forEach((band, i) => {
    const stop = band.upper / 500;
    gradient.addColorStop(stop, band.lineColor);
    gradient.addColorStop(stop, PM25_BANDS[i + 1].lineColor);
  });
  gradient.addColorStop(1, PM25_BANDS.at(-1).lineColor);
  return gradient;
}
function pm25Background() {
  return { id: 'pm25ConcentrationBands', beforeDraw(chart) {
    const { ctx: c, chartArea: area, scales: { y } } = chart;
    if (!area || !y) return;
    let lower = 0;
    c.save(); c.beginPath(); c.rect(area.left, area.top, area.width, area.height); c.clip(); c.globalAlpha = 0.055;
    for (const band of PM25_BANDS) {
      const top = y.getPixelForValue(Math.min(y.max, band.upper));
      const bottom = y.getPixelForValue(Math.max(y.min, lower));
      if (bottom > top) { c.fillStyle = band.color; c.fillRect(area.left, top, area.width, bottom - top); }
      lower = band.upper;
    }
    c.restore();
  } };
}
function temperatureLegend(ctx, series) {
  series.forEach((item, i) => {
    const x = 68 + i * 185;
    ctx.save(); ctx.strokeStyle = COLORS.muted; ctx.lineWidth = 3; ctx.setLineDash(item.lineDash);
    ctx.beginPath(); ctx.moveTo(x, 270); ctx.lineTo(x + 40, 270); ctx.stroke(); ctx.restore();
    write(ctx, shortLabel(ctx, item.name, 125, 22), x + 50, 278, 22, COLORS.muted);
  });
  write(ctx, '固定温标 °C', 453, 272, 20, COLORS.muted);
  const left = 620, width = 500, top = 254;
  const bar = ctx.createLinearGradient(left, 0, left + width, 0);
  TEMPERATURE_STOPS.forEach((stop, i) => bar.addColorStop(i / (TEMPERATURE_STOPS.length - 1), stop.color));
  ctx.fillStyle = bar; ctx.fillRect(left, top, width, 11);
  TEMPERATURE_STOPS.forEach((stop, i) => write(ctx, String(stop.value), left + i * width / (TEMPERATURE_STOPS.length - 1), 290, 19, COLORS.muted, 'normal', 'center'));
}
function airLegend(ctx) {
  const left = 68, width = 1064 / PM25_BANDS.length;
  PM25_BANDS.forEach((band, i) => {
    const x = left + i * width;
    ctx.fillStyle = band.color; ctx.fillRect(x + 2, 753, width - 4, 11);
    ctx.fillStyle = band.lineColor; ctx.fillRect(x + 2, 753, width - 4, 3);
    write(ctx, band.label, x + width / 2, 790, 20, COLORS.muted, 'normal', 'center');
  });
}
function precipitationLegend(ctx, series) {
  series.forEach((item, i) => {
    const x = 68 + i * 530;
    ctx.fillStyle = item.color; ctx.fillRect(x, 1223, 20, 11);
    fitText(ctx, item.name, x + 30, 1236, 490, 21, COLORS.muted);
  });
}

function standardOptions({ yMin, yMax, maxTicks = 6, paddingTop = 18 } = {}) {
  return { responsive: false, animation: false, devicePixelRatio: 1,
    layout: { padding: { left: 4, right: 16, top: paddingTop, bottom: 4 } },
    plugins: { legend: { display: false }, tooltip: { enabled: false } },
    scales: {
      x: { grid: { display: false }, border: { color: '#dbe5ee' }, ticks: { color: COLORS.muted, font: { family: FONT, size: 21 }, maxRotation: 0, autoSkip: true, maxTicksLimit: maxTicks, padding: 9 } },
      y: { ...(yMin === undefined ? {} : { min: yMin }), ...(yMax === undefined ? {} : { max: yMax }),
        grid: { color: COLORS.faint }, border: { display: false }, ticks: { color: COLORS.muted, font: { family: FONT, size: 22 }, maxTicksLimit: 5, padding: 9 } },
    },
  };
}
function drawChart(ctx, { x = 64, y, width = 1072, height = 280, type, data, options, plugins = [] }) {
  const plot = createCanvas(width, height);
  const chart = new Chart(plot.getContext('2d'), { type, data, options, plugins });
  try { ctx.drawImage(plot, x, y); } finally { chart.destroy(); }
}

function extremaPlugin() {
  return { id: 'weatherExtrema', afterDatasetsDraw(chart) {
    const placed = [];
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      const valid = dataset.data.map((value, index) => ({ value, index })).filter(point => point.value !== null);
      if (!valid.length) return;
      const low = valid.reduce((a, b) => a.value <= b.value ? a : b);
      const high = valid.reduce((a, b) => a.value >= b.value ? a : b);
      const labels = low.value === high.value ? [{ point: high, prefix: '恒', direction: -1 }] : [
        { point: high, prefix: '高', direction: -1 }, { point: low, prefix: '低', direction: 1 },
      ];
      for (const { point, prefix, direction } of labels) {
        const element = chart.getDatasetMeta(datasetIndex).data[point.index];
        if (!element || !Number.isFinite(element.x) || !Number.isFinite(element.y)) continue;
        const c = chart.ctx;
        const label = `${shortLabel(c, dataset.label, 235, 20, 'bold')} ${prefix}${number(point.value)}°`;
        c.save(); c.font = `bold 20px ${FONT}`;
        const boxWidth = c.measureText(label).width + 16;
        const rawX = element.x - boxWidth / 2;
        const rawY = element.y + (direction < 0 ? -32 : 10);
        const candidates = [0, -34, 34, -68, 68].flatMap(dy => [0, -boxWidth - 12, boxWidth + 12].map(dx => ({
          x: Math.max(chart.chartArea.left, Math.min(rawX + dx, chart.width - boxWidth - 4)),
          y: Math.max(0, Math.min(rawY + dy, chart.chartArea.bottom - 28)), w: boxWidth, h: 27,
        })));
        const position = candidates.find(a => placed.every(b => a.x + a.w + 4 <= b.x || b.x + b.w + 4 <= a.x || a.y + a.h + 4 <= b.y || b.y + b.h + 4 <= a.y)) ?? candidates[0];
        placed.push(position);
        const boxX = position.x, boxY = position.y;
        c.fillStyle = 'rgba(255,255,255,0.96)'; c.fillRect(boxX, boxY, boxWidth, 27);
        c.fillStyle = temperatureTextColor(point.value); c.fillText(label, boxX + 8, boxY + 21);
        c.fillStyle = temperatureColor(point.value);
        c.beginPath();
        if (dataset.borderDash?.length) c.rect(element.x - 4.5, element.y - 4.5, 9, 9);
        else c.arc(element.x, element.y, 4.5, 0, Math.PI * 2);
        c.fill(); c.restore();
      }
    });
  } };
}
function missingProbabilityPlugin() {
  return { id: 'missingProbability', afterDatasetsDraw(chart) {
    chart.data.datasets.forEach((dataset, datasetIndex) => {
      dataset.data.forEach((value, index) => {
        if (value !== null) return;
        const element = chart.getDatasetMeta(datasetIndex).data[index];
        const x = element?.x;
        if (!Number.isFinite(x)) return;
        const y = chart.chartArea.bottom - 9 - datasetIndex * 13;
        const c = chart.ctx; c.save(); c.strokeStyle = '#8a98aa'; c.lineWidth = 2;
        c.beginPath(); c.moveTo(x - 4, y - 4); c.lineTo(x + 4, y + 4); c.moveTo(x + 4, y - 4); c.lineTo(x - 4, y + 4); c.stroke(); c.restore();
      });
    });
  } };
}

/** Fixed, local rendering only; this module performs no fetching or sending. */
export function renderWeatherChart(input) {
  const model = prepareWeatherChart(input);
  const { weatherSeries, airSeries } = model;
  const canvas = createCanvas(WIDTH, HEIGHT), ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1f5fa'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  write(ctx, '亚历克斯 · 天气', 48, 49, 24, '#38627a', 'bold');
  fitText(ctx, `${model.places.map(place => place.name).join(' / ')}天气`, 48, 107, 850, 44, COLORS.ink, 'bold');
  write(ctx, model.date, 1152, 102, 32, COLORS.ink, 'bold', 'right');
  write(ctx, '温度 · 颗粒物 · 降水', 48, 154, 23, COLORS.muted);
  write(ctx, '模型预报 · 北京时间 UTC+8', 1152, 154, 23, COLORS.muted, 'normal', 'right');

  panel(ctx, 190, 460, '01  温度', '全天 00:00–23:00 · °C');
  temperatureLegend(ctx, weatherSeries);
  const temperatures = weatherSeries.flatMap(series => series.temperatureC).filter(value => value !== null);
  if (temperatures.length) {
    const minimum = Math.min(...temperatures), maximum = Math.max(...temperatures);
    const margin = Math.max(3, (maximum - minimum) * 0.28);
    const options = standardOptions({ yMin: Math.floor(minimum - margin), yMax: Math.ceil(maximum + margin), maxTicks: 9, paddingTop: 24 });
    drawChart(ctx, { y: 299, height: 254, type: 'line', data: { labels: model.hours,
      datasets: weatherSeries.map(series => ({ label: series.name, data: series.temperatureC, borderColor: temperatureGradient,
        borderDash: series.lineDash,
        borderWidth: 4.5, pointRadius: 0, tension: 0.2, spanGaps: false })) }, options, plugins: [extremaPlugin()] });
  } else placeholder(ctx, 420, '温度数据暂不可用', '保留缺失，不以 0°C 代替');
  weatherSeries.forEach((series, i) => {
    const total = series.precipitationMm.every(value => value !== null) ? series.precipitationMm.reduce((a, b) => a + b, 0) : null;
    const missing = series.temperatureC.filter(value => value === null).length;
    const line = `${series.name}  湿度 ${rangeLabel(series.humidityPct, '%')}   ·   全日降水 ${total === null ? '缺数据' : number(total) + ' mm'}（雨雪合计）${missing ? `   ·   温度缺 ${missing} 小时` : ''}`;
    fitText(ctx, line, 68, 592 + i * 33, 1064, 23, COLORS.muted);
  });

  panel(ctx, 680, 450, `02  PM2.5 · ${airSeries.name}`, '未来 48 小时 · μg/m³');
  airLegend(ctx);
  const validAir = airSeries.values.filter(value => value !== null);
  if (validAir.length) {
    const labels = Array.from({ length: 48 }, (_, i) => localTime(airSeries.start + i * HOUR_MS).slice(5).replace('T', ' '));
    const options = standardOptions({ yMin: 0, yMax: Math.max(20, Math.ceil(Math.max(...validAir) / 20) * 20), maxTicks: 5 });
    drawChart(ctx, { y: 803, height: 229, type: 'line', data: { labels, datasets: [{ label: `${airSeries.name} PM2.5`, data: airSeries.values,
      borderColor: pm25Gradient, fill: false, borderWidth: 4.5, pointRadius: 0,
      tension: 0.15, spanGaps: false }] }, options, plugins: [pm25Background()] });
  } else placeholder(ctx, 905, `${airSeries.name} PM2.5 暂无有效数据`, '没有生成浓度曲线，不以零值代替');
  const missingAir = airSeries.values.filter(value => value === null).length;
  fitText(ctx, '色阶按 HJ 633—2026 PM2.5 分界 · 非综合 AQI / 非实测', 68, 1072, 1064, 22);
  const airNote = `CAMS 约 45 km / 3 小时插值。${model.cities.length === 2 ? `仅显示${airSeries.name} PM2.5。` : ''}${missingAir ? `缺 ${missingAir} 小时。` : '不据此判断雾。'}`;
  fitText(ctx, airNote, 68, 1105, 1064, 22);

  panel(ctx, 1160, 440, '03  逐小时降水概率', '当天 00–23 时段 · %');
  precipitationLegend(ctx, weatherSeries);
  const probability = weatherSeries.flatMap(series => series.precipitationProbabilityPct).filter(value => value !== null);
  if (probability.length) {
    const options = standardOptions({ yMin: 0, yMax: 100, maxTicks: 12 });
    options.scales.x.ticks.autoSkip = false;
    options.scales.x.ticks.font.size = 20;
    options.scales.x.ticks.callback = function (value, index) { return model.hours[index]; };
    options.scales.y.ticks.stepSize = 25;
    drawChart(ctx, { y: 1250, height: 258, type: 'bar', data: { labels: model.hours,
      datasets: weatherSeries.map(series => ({ label: series.name, data: series.precipitationProbabilityPct,
        backgroundColor: series.color, borderRadius: 2, categoryPercentage: 0.8, barPercentage: 0.86 })) },
      options, plugins: [missingProbabilityPlugin()] });
  } else placeholder(ctx, 1372, '逐小时降水概率暂不可用', '缺失不表示 0%，不能据此判断全天无雨');
  const peaks = weatherSeries.map(series => {
    const values = series.precipitationProbabilityPct.filter(value => value !== null);
    return `${series.name} ${values.length ? number(Math.max(...values)) + '%' : '缺数据'}${values.length > 0 && values.length < 24 ? '（部分）' : ''}`;
  }).join(' / ');
  fitText(ctx, `最高小时概率：${peaks}（不是全天概率）`, 68, 1545, 1064, 23);
  if (weatherSeries.some(series => series.precipitationProbabilityPct.includes(null))) {
    fitText(ctx, '× 表示该小时数据缺失，不是 0%。', 68, 1578, 1064, 21);
  }

  const acquisition = [...weatherSeries.map(series => ({ name: shortLabel(ctx, series.name, 150, 22), value: series.fetchedAt })),
    { name: `CAMS（${shortLabel(ctx, airSeries.name, 110, 22)}）`, value: airSeries.fetchedAt }].map(item => {
    const stamp = typeof item.value === 'string' ? Date.parse(item.value) : NaN;
    return `${item.name} ${Number.isFinite(stamp) ? localTime(stamp).slice(5).replace('T', ' ') : '无有效数据'}`;
  }).join(' / ');
  fitText(ctx, `来源：ECMWF IFS（天气）· CAMS / ECMWF（${airSeries.name} PM2.5）· Open-Meteo`, 48, 1650, 1104, 23);
  write(ctx, 'https://open-meteo.com/', 48, 1689, 23, '#38627a');
  fitText(ctx, `数据获取：${acquisition}`, 48, 1728, 1104, 22);
  return { buffer: canvas.toBuffer('image/png'), mimeType: 'image/png' };
}
