// Exhaustive local catalog verification. No QQ transport or network client is loaded.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

let blockedNetworkAttempts = 0;
const denyNetwork = async () => { blockedNetworkAttempts++; throw new Error('OFFLINE_NETWORK_BLOCKED'); };
globalThis.fetch = denyNetwork;
const { CITIES, LocationService, getLocationCatalog, LOCATION_METADATA } = await import('../src/locations.mjs');
const { getWeatherBrief, HOUR_MS, localDate, localTime } = await import('../src/weather.mjs');
const { getAirQuality } = await import('../src/air-quality.mjs');
const { prepareWeatherChart, renderWeatherChart } = await import('../src/weather-chart.mjs');
const { prepareAirChart, renderAirChart } = await import('../src/air-chart.mjs');
const { WeatherCommands } = await import('../src/weather-commands.mjs');

const now = Date.parse('2026-10-28T10:15:00Z'), date = localDate(now);
const midnight = Date.parse(`${date}T00:00:00+08:00`), airStart = Math.floor(now / HOUR_MS) * HOUR_MS;
const outputDir = fileURLToPath(new URL('../test-output/', import.meta.url));
await mkdir(outputDir, { recursive: true });
const recheckChangedNames = process.argv.includes('--recheck-changed-names');
const initialReportPath = join(outputDir, 'weather-catalog-offline.json');
const outputPath = recheckChangedNames ? join(outputDir, 'weather-catalog-offline-recheck.json') : initialReportPath;
assert.notEqual(LOCATION_METADATA?.status, 'BUILDING', 'CATALOG_BUILDING');
const catalog = await getLocationCatalog();
assert.ok(Array.isArray(catalog) && catalog.length > 0, 'CATALOG_EMPTY');
assert.equal(new Set(catalog.map(place => place.id)).size, catalog.length, 'CATALOG_DUPLICATE_IDS');
const allPlaces = [...new Map([...catalog, ...Object.values(CITIES)].map(place => [place.id, place])).values()];
const identityHash = items => createHash('sha256').update(JSON.stringify(items.map(({ id, name }) => ({ id, name })))).digest('hex');
let initialReport = null;
if (recheckChangedNames) {
  initialReport = JSON.parse(await readFile(initialReportPath, 'utf8'));
  assert.ok(initialReport.completedAt && initialReport.failures.length === 0 && initialReport.blockedNetworkAttempts === 0, 'INITIAL_RUN_NOT_COMPLETE');
  assert.deepEqual(initialReport.items.map(item => item.id), allPlaces.map(place => place.id), 'CATALOG_IDS_CHANGED_REQUIRES_FULL_RUN');
  for (const counts of Object.values(initialReport.counts)) assert.equal(counts.passed, allPlaces.length, 'INITIAL_RUN_NOT_COMPLETE');
}
const oldNames = new Map((initialReport?.items ?? []).map(item => [item.id, item.name]));
const places = recheckChangedNames ? allPlaces.filter(place => oldNames.get(place.id) !== place.name) : allPlaces;
if (recheckChangedNames) await writeFile(join(outputDir, 'weather-catalog-changed-ids.json'), JSON.stringify(places.map(place => place.id), null, 2) + '\n');
assert.ok(places.length > 0, 'NO_CHANGED_NAMES_TO_RECHECK');
const longest = places.reduce((a, b) => [...a.name].length >= [...b.name].length ? a : b);
const previewIds = new Map([[places[0].id, 'first'], [longest.id, 'longest-name']]);
const locations = new LocationService({ fetchImpl: denyNetwork });
const metadata = {
  last_run_initialisation_time: Math.floor((now - 12 * HOUR_MS) / 1000),
  last_run_availability_time: Math.floor((now - 4 * HOUR_MS) / 1000),
  data_end_time: Math.floor((now + 6 * 24 * HOUR_MS) / 1000),
};
// Weather needs 25 samples to produce 24 forward-labelled intervals.
const weatherFixture = {
  timezone: 'Asia/Shanghai', utc_offset_seconds: 28800,
  hourly_units: { temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm', precipitation_probability: '%', rain: 'mm', snowfall: 'cm', cloud_cover: '%' },
  hourly: {
    time: Array.from({ length: 25 }, (_, i) => localTime(midnight + i * HOUR_MS)),
    temperature_2m: Array.from({ length: 25 }, (_, i) => Math.round((-4 + Math.sin(i / 6) * 31) * 10) / 10),
    relative_humidity_2m: Array.from({ length: 25 }, (_, i) => 40 + i * 2),
    precipitation: Array.from({ length: 25 }, (_, i) => i > 10 && i < 17 ? 1.2 : 0),
    precipitation_probability: Array.from({ length: 25 }, (_, i) => i > 10 && i < 17 ? 75 : 0),
    rain: Array.from({ length: 25 }, (_, i) => i > 10 && i < 17 ? 1.2 : 0),
    snowfall: Array(25).fill(0),
    cloud_cover: Array(25).fill(35),
  },
};
const airFixture = {
  timezone: 'Asia/Shanghai', utc_offset_seconds: 28800, hourly_units: { pm2_5: 'μg/m³' },
  hourly: { time: Array.from({ length: 48 }, (_, i) => localTime(airStart + i * HOUR_MS)), pm2_5: Array.from({ length: 48 }, (_, i) => i * 7) },
};
const payloads = { metadata: JSON.stringify(metadata), weather: JSON.stringify(weatherFixture), air: JSON.stringify(airFixture) };
let stubRequests = 0;
function forecastFetch(place) {
  return async input => {
    stubRequests++;
    const url = new URL(input);
    let body;
    if (url.href === 'https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json' ||
        url.href === 'https://air-quality-api.open-meteo.com/data/cams_global/static/meta.json') body = payloads.metadata;
    else {
      assert.equal(url.protocol, 'https:', 'UNEXPECTED_STUB_URL');
      assert.equal(Number(url.searchParams.get('latitude')), place.latitude, 'PROVIDER_LATITUDE_MISMATCH');
      assert.equal(Number(url.searchParams.get('longitude')), place.longitude, 'PROVIDER_LONGITUDE_MISMATCH');
      if (url.hostname === 'api.open-meteo.com' && url.pathname === '/v1/ecmwf') {
        assert.equal(url.searchParams.get('models'), 'ecmwf_ifs025'); body = payloads.weather;
      } else if (url.hostname === 'air-quality-api.open-meteo.com' && url.pathname === '/v1/air-quality') {
        assert.equal(url.searchParams.get('domains'), 'cams_global'); body = payloads.air;
      } else throw new Error('UNEXPECTED_STUB_URL');
    }
    return new Response(body, { headers: { 'content-type': 'application/json', date: new Date(now).toUTCString() } });
  };
}
function samePlace(actual, expected) {
  for (const key of ['id', 'name', 'latitude', 'longitude']) assert.equal(actual?.[key], expected[key], `PLACE_${key.toUpperCase()}_MISMATCH`);
}
function checkPng(image, width, height) {
  assert.equal(image?.mimeType, 'image/png'); assert.ok(Buffer.isBuffer(image.buffer));
  assert.deepEqual([...image.buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.buffer.readUInt32BE(16), width); assert.equal(image.buffer.readUInt32BE(20), height);
  assert.ok(image.buffer.length < 5 * 1024 * 1024);
}
const stages = ['resolve', 'provider', 'render', 'router'];
const report = {
  startedAt: new Date().toISOString(), completedAt: null, mode: recheckChangedNames ? 'offline-fixtures-changed-names' : 'offline-fixtures',
  scope: 'All local catalog records plus three compatibility cities; real provider parsing and real chart rendering; QQ modules never imported.',
  fixtureTime: new Date(now).toISOString(), metadata: LOCATION_METADATA,
  catalogCount: catalog.length, total: places.length, processed: 0,
  identityHashScope: 'SHA-256 of UTF-8 JSON ordered [{id,name}] including compatibility cities',
  finalCatalogIdentityHash: identityHash(allPlaces),
  ...(initialReport ? { initialAttempt: { reportPath: initialReportPath, startedAt: initialReport.startedAt, completedAt: initialReport.completedAt,
    total: initialReport.total, counts: initialReport.counts, metadata: initialReport.metadata, identityHash: identityHash(initialReport.items) },
    changedItems: places.map(place => ({ id: place.id, initialName: oldNames.get(place.id), finalName: place.name })), mergedSummary: null } : {}),
  counts: Object.fromEntries(stages.map(stage => [stage, { passed: 0, failed: 0, skipped: 0 }])),
  blockedNetworkAttempts: 0, stubRequests: 0, peakRssBytes: 0, previews: [], items: [], failures: [],
};
async function checkpoint(completed = false) {
  report.blockedNetworkAttempts = blockedNetworkAttempts; report.stubRequests = stubRequests;
  report.peakRssBytes = Math.max(report.peakRssBytes, process.memoryUsage().rss);
  if (completed) {
    report.completedAt = new Date().toISOString();
    if (initialReport) report.mergedSummary = {
      finalCatalogCount: catalog.length, compatibilityCities: allPlaces.length - catalog.length, finalTotal: allPlaces.length,
      unchangedFromInitialPassingRun: allPlaces.length - places.length, recheckedAfterNameFix: places.length,
      finalPassed: allPlaces.length - report.failures.length, finalFailed: report.failures.length,
      complete: report.processed === places.length && report.failures.length === 0 && blockedNetworkAttempts === 0,
      finalCatalogIdentityHash: identityHash(allPlaces),
    };
  }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ processed: report.processed, total: report.total, failures: report.failures.length, blockedNetworkAttempts, rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024), complete: completed }));
}
for (const place of places) {
  const item = { id: place.id, name: place.name, ...Object.fromEntries(stages.map(stage => [stage, 'skipped'])) };
  let stage = 'resolve';
  try {
    const resolved = await locations.resolve(place.id); samePlace(resolved, place);
    item.resolve = 'passed';
    stage = 'provider';
    const fetchImpl = forecastFetch(resolved);
    const weather = await getWeatherBrief({ city: resolved.id, place: resolved, now, fetchImpl });
    const air = await getAirQuality({ city: resolved.id, place: resolved, now, fetchImpl });
    samePlace(weather.city, resolved); samePlace(air.city, resolved);
    assert.equal(weather.hourly.length, 24); assert.equal(air.hourly.length, 48);
    item.provider = 'passed';
    stage = 'render';
    const weatherInput = { date, cities: [resolved.id], places: [resolved], weather: [weather], air, now };
    const weatherModel = prepareWeatherChart(weatherInput), airModel = prepareAirChart(air);
    assert.equal(weatherModel.weatherSeries[0].name, place.name); assert.equal(weatherModel.airSeries.id, place.id);
    samePlace(airModel.city, resolved);
    const weatherImage = renderWeatherChart(weatherInput), airImage = renderAirChart(air);
    checkPng(weatherImage, 1200, 2250); checkPng(airImage, 1200, 640);
    item.render = 'passed';
    if (previewIds.has(place.id)) {
      const label = previewIds.get(place.id);
      const prefix = recheckChangedNames ? 'catalog-recheck' : 'catalog';
      const weatherPath = join(outputDir, `weather-${prefix}-${label}.png`), airPath = join(outputDir, `air-${prefix}-${label}.png`);
      await writeFile(weatherPath, weatherImage.buffer); await writeFile(airPath, airImage.buffer);
      report.previews.push({ id: place.id, name: place.name, weatherPath, airPath });
    }
    stage = 'router';
    let weatherCalls = 0, airCalls = 0, weatherChartCalls = 0, airChartCalls = 0;
    const commands = new WeatherCommands({ locations, now: () => now,
      radar: { get: denyNetwork, list: denyNetwork },
      weather: async options => { samePlace(options.place, resolved); assert.equal(options.city, place.id); weatherCalls++; return weather; },
      air: async options => { samePlace(options.place, resolved); assert.equal(options.city, place.id); airCalls++; return air; },
      weatherChart: input => { samePlace(input.places[0], resolved); assert.deepEqual(input.cities, [place.id]); weatherChartCalls++; return weatherImage; },
      chart: input => { samePlace(input.city, resolved); airChartCalls++; return airImage; },
    });
    const routedWeather = await commands.handle(`发 天气 ${place.id}`), routedAir = await commands.handle(`发 雾霾 ${place.id}`);
    assert.equal(routedWeather?.text, ''); assert.equal(routedAir?.text, '');
    assert.equal(routedWeather?.image, weatherImage); assert.equal(routedAir?.image, airImage);
    assert.deepEqual([weatherCalls, airCalls, weatherChartCalls, airChartCalls], [1, 2, 1, 1]);
    item.router = 'passed';
  } catch (error) {
    item[stage] = 'failed';
    item.failure = { stage, code: String(error?.code ?? error?.message ?? 'UNKNOWN_FAILURE').slice(0, 300) };
    report.failures.push({ id: place.id, name: place.name, ...item.failure });
  }
  for (const stage of stages) report.counts[stage][item[stage]]++;
  report.items.push(item); report.processed++;
  if (report.processed % 25 === 0) { globalThis.gc?.(); await new Promise(resolve => setImmediate(resolve)); }
  if (report.processed % 50 === 0) await checkpoint();
}
await checkpoint(true);
if (report.failures.length || blockedNetworkAttempts) process.exitCode = 1;
