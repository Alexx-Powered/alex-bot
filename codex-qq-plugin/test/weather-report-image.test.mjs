import test from 'node:test';
import assert from 'node:assert/strict';
import { Chart } from 'chart.js';
import { loadImage } from '@napi-rs/canvas';
import { renderWeatherReportImage, WEATHER_REPORT_STYLE, weatherReportCondition } from '../src/weather-report-image.mjs';

function sample() {
  const now = Date.parse('2026-11-03T13:30:00+08:00'), date = '2026-11-03';
  const start = Date.parse(date + 'T00:00:00+08:00');
  const weather = { city: { id: 'guangzhou' }, date, timezone: 'Asia/Shanghai', fetchedAt: new Date(now).toISOString(),
    windBrief: ['东南风 1–2级', '南风 1–3级'], hourly: Array.from({ length: 48 }, (_, i) => ({
      time: new Date(start + i * 3600000).toISOString(), temperatureC: 22 + i / 10,
      cloudCoverPct: i === 5 ? null : i < 24 ? 100 : 0,
      precipitationProbabilityPct: i === 5 ? null : i < 24 ? 100 : 0,
      precipitationMm: 0, humidityPct: 65,
    })) };
  const air = { city: { id: 'guangzhou' }, timezone: 'Asia/Shanghai', fetchedAt: weather.fetchedAt,
    hourly: weather.hourly.map((r, i) => ({ time: r.time, pm25: i === 5 ? null : 20 + i * 2 })) };
  return { date, cities: ['guangzhou'], weather: [weather], air, now };
}
async function capture(input) {
  const charts = [];
  const probe = { id: 'reportAudit', afterDatasetsDraw(chart) {
    if(charts.some(item=>item.datasets[0].label===chart.data.datasets[0].label))return;
    charts.push({ x: [chart.scales.x.min, chart.scales.x.max],
      y: [chart.scales.y.min, chart.scales.y.max], right: [chart.scales.yRight.min, chart.scales.yRight.max],
      labels: chart.scales.y.ticks.map(t => t.label), rightLabels: chart.scales.yRight.ticks.map(t => t.label),
      rightWidth: chart.scales.yRight.width,
      datasets: chart.data.datasets.map((d, i) => ({ label: d.label, samples: d.data, color: d.borderColor,
        fill: d.backgroundColor, spanGaps: d.spanGaps, axis: d.yAxisID,
        ys: chart.getDatasetMeta(i).data.map(p => p.y),
        top: chart.chartArea.top, bottom: chart.chartArea.bottom, borderWidth: d.borderWidth,
      })) });
  } };
  Chart.register(probe);
  try { return { image: await renderWeatherReportImage(input), charts }; }
  finally { Chart.unregister(probe); }
}

test('report keeps real samples, missing gaps, units and matching percentage axes', async () => {
  const inputs = sample(), { image, charts } = await capture({ inputs });
  assert.equal(charts.length, 3);
  for (const chart of charts) assert.deepEqual(chart.x, [0, 48]);
  assert.deepEqual(charts[0].datasets[0].samples.map(p => p.y), inputs.weather[0].hourly.map(p => p.temperatureC));
  assert.deepEqual(charts[1].datasets[0].samples.map(p => p.y), inputs.air.hourly.map(p => p.pm25));
  const combined = charts[2];
  assert.deepEqual(combined.y, [0, 100]); assert.deepEqual(combined.right, [0, 100]);
  assert.deepEqual(combined.labels, ['0%', '25%', '50%', '75%', '100%']);
  assert.deepEqual(combined.rightLabels, combined.labels);
  assert.ok(combined.rightWidth >= 40, 'right 100% label has room for all four characters and padding');
  const cloud = combined.datasets.find(d => d.label === '云量'), rain = combined.datasets.find(d => d.label === '降水概率');
  assert.equal(cloud.axis, 'yRight'); assert.equal(rain.axis, 'y');
  assert.equal(cloud.samples[0].x, 0); assert.equal(rain.samples[0].x, 0.5);
  assert.equal(cloud.samples[5].y, null); assert.equal(rain.samples[5].y, null);
  assert.equal(cloud.samples[24].y, 0); assert.equal(rain.samples[24].y, 0);
  assert.equal(cloud.spanGaps, false); assert.equal(charts[1].datasets[0].spanGaps, false);
  for (const color of [cloud.color, cloud.fill]) assert.match(color, /^#([a-f\d]{2})\1\1$/i, 'cloud is neutral gray');
  const ys = cloud.ys.filter(Number.isFinite);
  assert.ok(Math.min(...ys) - cloud.borderWidth / 2 > cloud.top, '100% cloud is not clipped');
  assert.ok(Math.max(...ys) + cloud.borderWidth / 2 < cloud.bottom, '0% cloud is not clipped');
  const decoded = await loadImage(image.buffer);
  assert.equal(decoded.width, Math.round(WEATHER_REPORT_STYLE.width * WEATHER_REPORT_STYLE.scale));
  assert.ok(image.buffer.length < 5 * 1024 * 1024);
});

test('legacy analysis still validates city and date; outdoor card is shared by weather and morning', async () => {
  const inputs = sample(), analysis = { city: 'guangzhou', date: inputs.date, windows: [], recommendation: null, summary: '暂无推荐时段' };
  const plain = await loadImage((await renderWeatherReportImage({ inputs })).buffer);
  const full = await loadImage((await renderWeatherReportImage({ inputs, analysis })).buffer);
  assert.equal(full.height,plain.height);
  await assert.rejects(() => renderWeatherReportImage({ inputs, analysis: { ...analysis, city: 'beijing' } }), /ANALYSIS_MISMATCH/);
  await assert.rejects(() => renderWeatherReportImage({ inputs, analysis: { ...analysis, date: '2026-11-04' } }), /ANALYSIS_MISMATCH/);
  await assert.rejects(() => renderWeatherReportImage({ inputs: { ...inputs, air: { ...inputs.air, city: { id: 'beijing' } } } }), /AIR_CITY_MISMATCH/);
});

test('unavailable weather and air render without inventing zero measurements', async () => {
  const inputs = { ...sample(), weather: [null], air: null }, { image, charts } = await capture({ inputs });
  assert.ok(image.buffer.length > 10000);
  for (const chart of charts) for (const series of chart.datasets) assert.ok(series.samples.every(p => p.y === null));
});

test('weather artwork accepts only the first-day fixed summary, never other dates or arbitrary asset paths',()=>{
  const inputs=sample(),weather=inputs.weather[0];
  assert.equal(weatherReportCondition(weather,inputs.date),null);
  weather.weatherSummary={date:inputs.date,code:95,icon:'thunderstorm',label:'雷阵雨'};
  assert.equal(weatherReportCondition(weather,inputs.date).icon,'thunderstorm');
  assert.equal(weatherReportCondition(weather,'2026-11-04'),null);
  weather.weatherSummary.icon='../sunny';assert.equal(weatherReportCondition(weather,inputs.date),null);
  assert.equal(weatherReportCondition(null,inputs.date),null);
});
