import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWeatherBrief } from '../src/weather.mjs';
import { getAirQuality } from '../src/air-quality.mjs';
import { prepareWeatherChart } from '../src/weather-chart.mjs';
import { WeatherCommands } from '../src/weather-commands.mjs';
import { WeatherToolbox } from '../src/weather-tools.mjs';
import { PythonAgentWorker } from '../src/python-agent.mjs';

// Local preview only: no server, QQ adapter, credentials, scheduler or deployment.
const home = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(home, 'test-output', 'weather-preview');
const now = Date.now(), city = process.argv[2] ?? '北京';
const captured = { weather: [], air: null, failures: [] };
const commands = new WeatherCommands({ now: () => now,
  weather: async options => {
    try { const result = await getWeatherBrief(options); captured.weather.push(result); return result; }
    catch (error) { captured.failures.push({ source: 'weather', code: error.code ?? 'UNAVAILABLE' }); throw error; }
  },
  air: async options => {
    try { return captured.air = await getAirQuality(options); }
    catch (error) { captured.failures.push({ source: 'air', code: error.code ?? 'UNAVAILABLE' }); throw error; }
  },
});
const worker = new PythonAgentWorker({ home });
const toolbox = new WeatherToolbox(commands, worker);
let langchainCalled = false;
try {
  const imageResult = await worker.run({ type: 'execute', name: 'weather_image', args: { city } }, async (name, args) => {
    assert.equal(name, 'weather_image'); assert.deepEqual(args, { city });
    langchainCalled = true;
    return toolbox.execute(name, args);
  });
  assert.ok(langchainCalled, 'Real Python LangChain call required');
  assert.ok(imageResult.image?.buffer, 'Weather image unavailable');
  if (captured.failures.length) throw new Error(captured.failures.map(item => `${item.source}:${item.code}`).join(','));
  const weather = captured.weather[0], place = weather.city;
  const input = { date: weather.date, cities: [place.id], places: [place], weather: [weather], air: captured.air, now };
  const model = prepareWeatherChart(input);
  assert.equal(weather.hourly.length, 48); assert.equal(captured.air.hourly.length, 48);
  assert.equal(Date.parse(weather.hourly[0].time), model.start);
  assert.equal(Date.parse(weather.hourly.at(-1).periodEnd), model.end);
  assert.equal(Date.parse(captured.air.hourly[0].time), model.start);
  await mkdir(out, { recursive: true });
  const file = resolve(out, 'weather-48h.png');
  await writeFile(file, imageResult.image.buffer);
  const report = { previewOnly: true, sentToQQ: false, deployed: false, langchainCalled,
    city: place.name, generatedAt: new Date(now).toISOString(), start: weather.hourly[0].time,
    endExclusive: weather.hourly.at(-1).periodEnd, weatherHours: weather.hourly.length,
    airHours: captured.air.hourly.length, sources: [weather.source.url, captured.air.source.url], file };
  await writeFile(resolve(out, 'weather-48h.json'), JSON.stringify(report, null, 2));
  await writeFile(resolve(out, 'weather-48h-input.json'), JSON.stringify(input, null, 2));
  console.log(JSON.stringify(report));
} finally { worker.close(); }
