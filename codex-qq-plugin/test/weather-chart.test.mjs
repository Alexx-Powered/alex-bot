import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Chart } from 'chart.js';
import { prepareWeatherChart, renderWeatherChart } from '../src/weather-chart.mjs';

const NOW = Date.parse('2026-10-28T10:00:00Z');
const HOUR = 3_600_000;
const START = Date.parse('2026-10-28T00:00:00+08:00');
test('tomorrow chart date labels and both curves follow the shifted two-day window',()=>{
  const weather=forecast(),air=airForecast();weather.date='2026-10-29';
  for(const result of [weather,air])for(const row of result.hourly)row.time=new Date(Date.parse(row.time)+24*HOUR).toISOString();
  const model=prepareWeatherChart({date:'2026-10-29',weather:[weather],air,now:NOW});
  assert.deepEqual(model.dayLabels,['明天','后天']);assert.equal(model.nextDate,'2026-10-30');
  assert.equal(model.start,START+24*HOUR);assert.equal(model.airSeries.start,model.start);
  assert.equal(model.weatherSeries[0].temperatureC[0],10);assert.equal(model.airSeries.values[47],92);
});
const SHANGHAI = { id: 'geonames-1796236', name: '上海', latitude: 31.2304, longitude: 121.4737 };
const SHENZHEN = { id: 'geonames-1795565', name: '深圳', latitude: 22.5431, longitude: 114.0579 };
const CHAOYANG = { id: 'geonames-2038154', name: '辽宁省朝阳市', latitude: 41.5739, longitude: 120.4506 };
const LONG_PLACE = { id: 'geonames-1529565', name: '新疆维吾尔自治区伊犁哈萨克自治州察布查尔锡伯自治县', latitude: 43.8381, longitude: 81.1497 };
function forecast(city = 'beijing') {
  return { city: { id: city }, date: '2026-10-28', timezone: 'Asia/Shanghai', fetchedAt: new Date(NOW).toISOString(),
    hourly: Array.from({ length: 48 }, (_, i) => ({ time: new Date(START + i * HOUR).toISOString(),
      temperatureC: 10 + Math.sin(i / 4) * 5, humidityPct: 60, cloudCoverPct: i % 24 * 4,
      precipitationMm: i === 12 ? 2 : 0, precipitationProbabilityPct: i >= 10 && i <= 14 ? 65 : 0 })) };
}
function airForecast(city = 'beijing') {
  const base = { beijing: 45, tianjin: 30, guangzhou: 16 }[city] ?? 20;
  return { city: { id: city }, timezone: 'Asia/Shanghai', fetchedAt: new Date(NOW).toISOString(),
    hourly: Array.from({ length: 48 }, (_, i) => ({ time: new Date(START + i * HOUR).toISOString(), pm25: base + i })) };
}

test('two-city normalization preserves hourly weather, daily boundaries and separate Beijing air', () => {
  const beijing = forecast(), tianjin = forecast('tianjin');
  tianjin.hourly.forEach(point => { point.temperatureC += 3; });
  const result = prepareWeatherChart({ date: '2026-10-28', cities: ['beijing', 'tianjin'], weather: [beijing, tianjin], air: airForecast(), now: NOW });
  assert.equal(result.weatherSeries.length, 2);
  assert.equal(result.weatherSeries[0].temperatureC[0], 10);
  assert.equal(result.weatherSeries[1].temperatureC[0], 13);
  assert.deepEqual(result.hours, Array.from({ length: 48 }, (_, i) => String(i % 24).padStart(2, '0')));
  assert.equal(result.airSeries.values.length, 48);
  assert.equal(result.airSeries.start, START);
  assert.equal(result.airSeries.values[47], 92);
  assert.equal(result.airSeries.id, 'beijing');
  assert.equal(result.airSeries.name, '北京');
});

test('all panels stay on the same two calendar days at morning, evening and month/year boundaries', () => {
  for (const date of ['2026-10-31', '2026-12-31']) {
    const start = Date.parse(`${date}T00:00:00+08:00`);
    for (const hour of [0, 7.5, 18, 23.99]) {
      const weather = forecast(), air = airForecast();
      weather.date = date;
      weather.hourly.forEach((row, i) => { row.time = new Date(start + i * HOUR).toISOString(); });
      air.hourly.forEach((row, i) => { row.time = new Date(start + i * HOUR).toISOString(); });
      const model = prepareWeatherChart({ weather: [weather], air, now: start + Math.floor(hour * HOUR) });
      assert.equal(model.date, date); assert.equal(model.start, start); assert.equal(model.airSeries.start, start);
      assert.equal(model.end, start + 48 * HOUR);
      assert.equal(model.weatherSeries[0].temperatureC.length, 48);
      assert.equal(model.weatherSeries[0].temperatureC[47], weather.hourly[47].temperatureC);
      assert.equal(model.airSeries.values[0], 45); assert.equal(model.airSeries.values[47], 92);
    }
  }
});

test('real chart draws a dashed midnight separator aligned inside all four plots', async () => {
  const image = await loadImage(renderWeatherChart({ date: '2026-10-28', weather: [forecast()], air: airForecast(), now: NOW }).buffer);
  const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const isSeparator = ([r, g, b]) => r >= 170 && r <= 220 && g - r >= 6 && g - r <= 28 && b - g >= 6 && b - g <= 28;
  const separators = [299, 803, 1250, 1720].map(top => {
    const { data: pixels } = ctx.getImageData(550, top + 45, 160, 55);
    const columns = Array.from({ length: 160 }, (_, x) => Array.from({ length: 55 }, (_, y) => {
      const offset = (y * 160 + x) * 4;
      return isSeparator(pixels.subarray(offset, offset + 3));
    }));
    const xs = columns.flatMap((column, x) => column.filter(Boolean).length >= 8 ? [x] : []);
    assert.ok(xs.length >= 1 && xs.length <= 3);
    const pattern = columns[xs[0]];
    assert.ok(pattern.some(Boolean) && pattern.some(value => !value), 'Dashed line has visible gaps');
    const header = ctx.getImageData(550 + xs[0], top + 3, 1, 15).data;
    assert.ok(Array.from({ length: 15 }, (_, y) => header.subarray(y * 4, y * 4 + 3)).every(color => !isSeparator(color)), 'Separator stays out of the header');
    return xs.map(x => 550 + x);
  });
  // A translucent area can soften one edge pixel differently across native font/canvas builds.
  const centers = separators.map(xs => (xs[0] + xs.at(-1)) / 2);
  assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, 'All midnight dividers align within one raster pixel');
});

test('100% cloud and exact-axis PM2.5 peaks retain full strokes above and below the data', () => {
  const weather = forecast(), air = airForecast(), measured = [];
  weather.hourly.forEach((row, hour) => { row.cloudCoverPct = hour < 24 ? 100 : 0; row.precipitationProbabilityPct = hour < 24 ? 100 : 0; });
  air.hourly.forEach((row, hour) => { row.pm25 = hour === 0 ? 0 : hour >= 15 && hour <= 23 ? 220 : 25; });
  const probe = { id: 'weatherStrokeBoundaryProbe', afterDatasetsDraw(chart) {
    chart.data.datasets.forEach((dataset, index) => {
      if (!/总云量|PM2\.5/.test(dataset.label)) return;
      const points = chart.getDatasetMeta(index).data, ys = points.map(point => point.y);
      const controls = points.flatMap(point => [point.cp1y, point.cp2y]).filter(Number.isFinite);
      const halfStroke = dataset.borderWidth / 2;
      measured.push({ label: dataset.label, min: chart.scales.y.min, max: chart.scales.y.max,
        topGap: Math.min(...ys) - halfStroke - chart.chartArea.top,
        bottomGap: chart.chartArea.bottom - Math.max(...ys) - halfStroke,
        controlCount: controls.length,
        boundedControls: controls.every(value => value >= Math.min(...ys) - 0.01 && value <= Math.max(...ys) + 0.01) });
    });
  } };
  Chart.register(probe);
  try { renderWeatherChart({ date: '2026-10-28', weather: [weather], air, now: NOW }); }
  finally { Chart.unregister(probe); }
  assert.equal(measured.length, 2);
  for (const bounds of measured) {
    assert.ok(bounds.topGap >= 4, `${bounds.label}: top stroke needs breathing room, got ${bounds.topGap}`);
    assert.ok(bounds.bottomGap >= 4, `${bounds.label}: zero stroke needs breathing room, got ${bounds.bottomGap}`);
  }
  const cloud = measured.find(bounds => bounds.label.includes('总云量'));
  assert.equal(cloud.min, 0); assert.equal(cloud.max, 100, 'Percent labels retain their true physical domain');
  assert.ok(cloud.controlCount > 0, 'Inspect the actual rendered Bezier controls');
  assert.ok(cloud.boundedControls, 'Smoothing must not invent cloud values outside 0–100%');
});

test('missing, invalid and absent hours remain null while genuine zero probability is retained', () => {
  const weather = forecast();
  weather.hourly[0].cloudCoverPct = 0;
  weather.hourly[1].cloudCoverPct = null;
  weather.hourly[2].cloudCoverPct = -1;
  weather.hourly[3].cloudCoverPct = '0';
  weather.hourly[0].precipitationProbabilityPct = 0;
  weather.hourly[1].precipitationProbabilityPct = null;
  weather.hourly[2].precipitationProbabilityPct = -1;
  weather.hourly[3].precipitationProbabilityPct = '0';
  weather.hourly.splice(4, 1);
  const air = airForecast(); air.hourly[3].pm25 = null; air.hourly[4].pm25 = -1;
  const result = prepareWeatherChart({ date: '2026-10-28', weather: [weather], air, now: NOW });
  assert.deepEqual(result.weatherSeries[0].precipitationProbabilityPct.slice(0, 5), [0, null, null, null, null]);
  assert.deepEqual(result.weatherSeries[0].cloudCoverPct.slice(0, 5), [0, null, null, null, null]);
  assert.equal(result.weatherSeries[0].temperatureC[4], null);
  assert.equal(result.airSeries.values[3], null);
  assert.equal(result.airSeries.values[4], null);
});

test('Tianjin and Guangzhou use their own CAMS forecast and reject substituted city data', () => {
  for (const [city, name, firstPm25] of [['tianjin', '天津', 30], ['guangzhou', '广州', 16]]) {
    const input = { date: '2026-10-28', cities: [city], weather: [forecast(city)], air: airForecast(city), now: NOW };
    const result = prepareWeatherChart(input);
    assert.equal(result.weatherSeries[0].id, city);
    assert.equal(result.weatherSeries[0].name, name);
    assert.equal(result.airSeries.enabled, true);
    assert.equal(result.airSeries.id, city); assert.equal(result.airSeries.name, name);
    assert.equal(result.airSeries.values[0], firstPm25);
    assert.equal(result.airSeries.values[47], firstPm25 + 47);
    for (const otherCity of ['beijing', 'tianjin', 'guangzhou'].filter(id => id !== city)) {
      assert.throws(() => prepareWeatherChart({ ...input, air: airForecast(otherCity) }), /WEATHER_CHART_AIR_CITY_MISMATCH/);
      assert.throws(() => prepareWeatherChart({ ...input, weather: [forecast(otherCity)] }), /WEATHER_CHART_CITY_MISMATCH/);
    }
  }
});

test('dual-city air selection prefers Beijing, otherwise the first city; temperature line styles stay distinct', () => {
  for (const cities of [['beijing', 'guangzhou'], ['guangzhou', 'beijing'], ['tianjin', 'guangzhou'], ['guangzhou', 'tianjin']]) {
    const airCity = cities.includes('beijing') ? 'beijing' : cities[0];
    const otherCity = cities.find(city => city !== airCity);
    const input = { date: '2026-10-28', cities, weather: cities.map(city => forecast(city)), now: NOW };
    const model = prepareWeatherChart({ ...input, air: airForecast(airCity) });
    assert.equal(model.airSeries.id, airCity);
    assert.deepEqual(model.weatherSeries.map(series => series.id), cities);
    assert.deepEqual(model.weatherSeries[0].lineDash, []);
    assert.ok(model.weatherSeries[1].lineDash.length > 0);
    assert.notEqual(model.weatherSeries[0].color, model.weatherSeries[1].color);
    assert.throws(() => prepareWeatherChart({ ...input, air: airForecast(otherCity) }), /WEATHER_CHART_AIR_CITY_MISMATCH/);
  }
});

test('explicit places support dynamic locations and supply the authoritative names and ordered styles', () => {
  for (const places of [[SHANGHAI], [SHENZHEN], [CHAOYANG], [SHANGHAI, SHENZHEN]]) {
    const cities = places.map(place => place.id), weather = cities.map(city => forecast(city));
    weather[0].city.name = 'Untrusted forecast display name';
    const result = prepareWeatherChart({ date: '2026-10-28', cities, places, weather, air: airForecast(cities[0]), now: NOW });
    assert.deepEqual(result.weatherSeries.map(series => series.name), places.map(place => place.name));
    assert.equal(result.airSeries.id, places[0].id); assert.equal(result.airSeries.name, places[0].name);
    assert.equal(result.airSeries.values[0], 20);
    assert.equal(result.weatherSeries[0].color, '#2563eb'); assert.deepEqual(result.weatherSeries[0].lineDash, []);
    if (places.length === 2) {
      assert.notEqual(result.weatherSeries[1].color, result.weatherSeries[0].color);
      assert.ok(result.weatherSeries[1].lineDash.length > 0);
    }
  }
});

test('dynamic places reject mismatched order, invalid coordinates, wrong weather and wrong air cities', () => {
  const input = { date: '2026-10-28', cities: [SHANGHAI.id], places: [SHANGHAI], weather: [forecast(SHANGHAI.id)], air: airForecast(SHANGHAI.id), now: NOW };
  assert.throws(() => prepareWeatherChart({ ...input, places: [SHENZHEN] }), /WEATHER_CHART_CITY_MISMATCH/);
  assert.throws(() => prepareWeatherChart({ ...input, places: [{ ...SHANGHAI, latitude: 200 }] }), /WEATHER_CHART_CITY_INVALID/);
  assert.throws(() => prepareWeatherChart({ ...input, places: [] }), /WEATHER_CHART_CITY_INVALID/);
  assert.throws(() => prepareWeatherChart({ ...input, places: undefined }), /WEATHER_CHART_CITY_INVALID/);
  assert.throws(() => prepareWeatherChart({ ...input, weather: [forecast(CHAOYANG.id)] }), /WEATHER_CHART_CITY_MISMATCH/);
  assert.throws(() => prepareWeatherChart({ ...input, air: airForecast(SHENZHEN.id) }), /WEATHER_CHART_AIR_CITY_MISMATCH/);
  const missing = prepareWeatherChart({ ...input, weather: [null], air: null });
  assert.equal(missing.weatherSeries[0].name, '上海'); assert.equal(missing.airSeries.name, '上海');
  assert.ok(missing.weatherSeries[0].temperatureC.every(value => value === null));
  assert.ok(missing.airSeries.values.every(value => value === null));
});

test('date/city mismatches and duplicate hours fail instead of producing misleading charts', () => {
  assert.throws(() => prepareWeatherChart({ date: '2026-02-31', weather: [forecast()], now: NOW }), /WEATHER_CHART_DATE_INVALID/);
  assert.throws(() => prepareWeatherChart({ date: '2026-10-28', cities: ['beijing', 'beijing'], weather: [forecast(), forecast()], now: NOW }), /WEATHER_CHART_CITY_INVALID/);
  const wrongDay = forecast(); wrongDay.date = '2026-10-27';
  assert.throws(() => prepareWeatherChart({ date: '2026-10-28', weather: [wrongDay], now: NOW }), /WEATHER_CHART_CITY_MISMATCH/);
  const duplicate = forecast(); duplicate.hourly[2].time = duplicate.hourly[1].time;
  assert.throws(() => prepareWeatherChart({ date: '2026-10-28', weather: [duplicate], now: NOW }), /WEATHER_CHART_TIME_INVALID/);
});

test('real renderer produces a bounded 1200x2250 PNG for single and dual-city reports', async () => {
  for (const cities of [['beijing'], ['tianjin'], ['guangzhou'], ['beijing', 'tianjin'], ['beijing', 'guangzhou'], ['guangzhou', 'tianjin']]) {
    const airCity = cities.includes('beijing') ? 'beijing' : cities[0];
    const image = renderWeatherChart({ date: '2026-10-28', cities, weather: cities.map(city => forecast(city)), air: airForecast(airCity), now: NOW });
    assert.equal(image.mimeType, 'image/png');
    assert.ok(Buffer.isBuffer(image.buffer));
    assert.deepEqual([...image.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(image.buffer.length < 5 * 1024 * 1024);
    const decoded = await loadImage(image.buffer);
    assert.equal(decoded.width, 1200); assert.equal(decoded.height, 2250);
  }
});

test('dynamic and long administrative names render bounded single and dual-city PNGs', async () => {
  for (const places of [[SHANGHAI], [SHENZHEN], [CHAOYANG], [LONG_PLACE], [LONG_PLACE, CHAOYANG]]) {
    const cities = places.map(place => place.id), weather = cities.map(city => forecast(city));
    if (places.length === 2) weather[1] = null;
    const input = { date: '2026-10-28', cities, places, weather, air: places.length === 2 ? null : airForecast(cities[0]), now: NOW };
    const rendered = renderWeatherChart(input), image = await loadImage(rendered.buffer);
    assert.equal(rendered.mimeType, 'image/png'); assert.ok(rendered.buffer.length < 5 * 1024 * 1024);
    assert.equal(image.width, 1200); assert.equal(image.height, 2250);
  }
});

test('renderer supports unavailable and partly missing panels without fabricating zeros', async () => {
  const beijing = forecast(); beijing.hourly[8].temperatureC = null; beijing.hourly[8].precipitationProbabilityPct = null;
  const input = { date: '2026-10-28', cities: ['beijing', 'tianjin'], weather: [beijing, null], air: null, now: NOW };
  const model = prepareWeatherChart(input);
  assert.ok(model.weatherSeries[1].temperatureC.every(value => value === null));
  assert.ok(model.weatherSeries[1].precipitationProbabilityPct.every(value => value === null));
  const image = await loadImage(renderWeatherChart(input).buffer);
  assert.equal(image.height, 2250);
  const tianjinImage = await loadImage(renderWeatherChart({ date: '2026-10-28', cities: ['tianjin'], weather: [forecast('tianjin')], air: null, now: NOW }).buffer);
  assert.equal(tianjinImage.width, 1200);
  const guangzhou = forecast('guangzhou');
  guangzhou.hourly[0].temperatureC = null; guangzhou.hourly[0].precipitationProbabilityPct = null;
  guangzhou.hourly[1].temperatureC = 0; guangzhou.hourly[1].precipitationProbabilityPct = 0;
  const missingAir = prepareWeatherChart({ date: '2026-10-28', cities: ['guangzhou'], weather: [guangzhou], air: null, now: NOW });
  assert.equal(missingAir.airSeries.id, 'guangzhou'); assert.equal(missingAir.airSeries.name, '广州');
  assert.ok(missingAir.airSeries.values.every(value => value === null));
  assert.equal(missingAir.airSeries.fetchedAt, null);
  assert.deepEqual(missingAir.weatherSeries[0].temperatureC.slice(0, 2), [null, 0]);
  assert.deepEqual(missingAir.weatherSeries[0].precipitationProbabilityPct.slice(0, 2), [null, 0]);
  const guangzhouImage = await loadImage(renderWeatherChart({ date: '2026-10-28', cities: ['guangzhou'], weather: [guangzhou], air: null, now: NOW }).buffer);
  assert.equal(guangzhouImage.width, 1200); assert.equal(guangzhouImage.height, 2250);
});
