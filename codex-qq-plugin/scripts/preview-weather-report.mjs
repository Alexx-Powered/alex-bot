// Design review only: public forecasts, local LangChain rules, local PNG. No QQ.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getWeatherBrief } from '../src/weather.mjs';
import { getAirQuality } from '../src/air-quality.mjs';
import { PythonAgentWorker } from '../src/python-agent.mjs';
import { morningPlan } from '../src/morning-calendar.mjs';
import { renderWeatherReportImage } from '../src/weather-report-image.mjs';
import { summarizeOutdoor } from '../src/outdoor-summary.mjs';

const out = new URL('../test-output/weather-redesign/', import.meta.url);
await mkdir(out, { recursive: true });
const reuse = process.argv.includes('--reuse');
const read = async name => JSON.parse(await readFile(new URL(name, out), 'utf8'));
let weather, air, analysis;
if (reuse) [weather, air, analysis] = await Promise.all(['live-0.json', 'live-1.json', 'analysis.json'].map(read));
else {
  const now = Date.now();
  [weather, air] = await Promise.all([
    getWeatherBrief({ city: 'guangzhou', days: 2, exerciseFields: true, now }),
    getAirQuality({ city: 'guangzhou', window: 'calendar', now }),
  ]);
  const worker = new PythonAgentWorker({ home: fileURLToPath(new URL('../', import.meta.url)) });
  try {
    analysis = await worker.run({ type: 'morning', data: {
      ...morningPlan(now), city: 'guangzhou', cityName: '广州', now: new Date(now).toISOString(), weather, air,
    } }, async () => { throw new Error('PREVIEW_RPC_DENIED'); }, result => {
      assert.equal(result.kind, 'analysis'); return result.report;
    });
  } finally { worker.close(); }
  await writeFile(new URL('live-0.json', out), JSON.stringify(weather, null, 2));
  await writeFile(new URL('live-1.json', out), JSON.stringify(air, null, 2));
  await writeFile(new URL('analysis.json', out), JSON.stringify(analysis, null, 2));
}
assert.equal(weather.city.id, 'guangzhou'); assert.equal(air.city.id, 'guangzhou');
assert.equal(weather.hourly.length, 48); assert.equal(air.hourly.length, 48);
assert.ok(!weather.simulated && !air.simulated);
const inputs = { date: weather.date, cities: ['guangzhou'], places: [weather.city], weather: [weather], air, now: Date.parse(weather.fetchedAt) };
inputs.outdoorIndex = await summarizeOutdoor({date:weather.date,city:'guangzhou',weather,air});
const image = await renderWeatherReportImage({ inputs, analysis });
const file = new URL('广州天气日报_预览.png', out);
await writeFile(file, image.buffer);
const report = { previewOnly: true, sentToQQ: false, deployed: false, city: '广州',
  weatherFetchedAt: weather.fetchedAt, airFetchedAt: air.fetchedAt, date: weather.date,
  windowStart: weather.hourly[0].time, windowEnd: weather.hourly.at(-1).periodEnd,
  weatherHours: weather.hourly.length, airHours: air.hourly.length,
  weatherUrl: weather.source.url, airUrl: air.source.url,
  ruleVersion: inputs.outdoorIndex.version, bytes: image.buffer.length, file: fileURLToPath(file) };
await writeFile(new URL('preview-manifest.json', out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
