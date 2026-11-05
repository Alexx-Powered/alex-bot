import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CITIES, LOCATION_METADATA, getLocationCatalog, LocationService, validatePlace } from '../src/locations.mjs';

const makeService = options => new LocationService({outdoorLookup:async()=>[],...options});
const NOW = Date.parse('2026-10-28T12:00:00Z');
const response = (body, options = {}) => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json; charset=utf-8' }, ...options,
});
const foreign = (overrides = {}) => ({ id: 2988507, name: 'Paris', latitude: 48.8534,
  longitude: 2.3488, feature_code: 'PPLC', country: 'France', country_code: 'FR',
  admin1: 'Île-de-France', admin2: 'Paris', ...overrides });
function noNetwork() { throw new Error('LOCAL_PLACE_MUST_NOT_FETCH'); }

test('published catalog retains every official CSV location, provenance, and all 34 admin1 regions', () => {
  const rows = getLocationCatalog();
  assert.equal(LOCATION_METADATA.status, 'READY');
  assert.equal(LOCATION_METADATA.sourceVersion, 'China-City-List v202506200');
  assert.equal(LOCATION_METADATA.sourceDate, '2025-06-20');
  assert.equal(rows.length, 3577);
  assert.equal(LOCATION_METADATA.placeCount, rows.length);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(new Set(rows.map((row) => row.admin1)).size, 34);
  assert.deepEqual(LOCATION_METADATA.countryCodeCounts, { CN: 3183, HK: 20, MO: 11, TW: 363 });
  assert.match(LOCATION_METADATA.sourceUrl, /^https:\/\/raw\.githubusercontent\.com\/qwd\/LocationList\//);
  assert.match(LOCATION_METADATA.sourceSha256, /^[a-f0-9]{64}$/);
  for (const place of rows) assert.deepEqual(validatePlace(place), place);
});

test('all 3577 stable catalog IDs resolve locally, including nonnumeric QWeather IDs', async () => {
  const service = makeService({ fetchImpl: noNetwork });
  let alphanumeric = 0;
  for (const place of getLocationCatalog()) {
    assert.deepEqual(await service.resolve(place.id), place);
    assert.deepEqual(await service.resolve(`${place.name}（${place.id}）`), place);
    if (/[A-Za-z]/.test(place.id.slice('qweather-'.length))) alphanumeric++;
  }
  assert.equal(alphanumeric, 338);
});

test('legacy coordinates are exact and copied, while other cities and counties resolve from the catalog', async () => {
  const service = makeService({ fetchImpl: noNetwork });
  assert.deepEqual(CITIES.beijing, { id: 'beijing', name: '北京', latitude: 39.9042, longitude: 116.4074 });
  assert.deepEqual(CITIES.tianjin, { id: 'tianjin', name: '天津', latitude: 39.0842, longitude: 117.2009 });
  assert.deepEqual(CITIES.guangzhou, { id: 'guangzhou', name: '广州', latitude: 23.1291, longitude: 113.2644 });
  for (const place of Object.values(CITIES)) {
    assert.deepEqual(await service.resolve(place.id), place);
    assert.deepEqual(await service.resolve(place.name + '市'), place);
  }
  assert.equal((await service.resolve('广州天河')).id, 'qweather-101280109');
  assert.equal((await service.resolve('北京 朝阳区')).id, 'qweather-101010300');
  assert.equal((await service.resolve('海淀区')).id, 'qweather-101010200');
  assert.equal((await service.resolve('陕西 西安 长安')).id, 'qweather-101110102');
  assert.equal((await service.resolve('新屋区')).id, 'qweather-F69B');
  const changed = await service.resolve('beijing'); changed.latitude = 0;
  assert.equal((await service.resolve('beijing')).latitude, 39.9042);
  const all = getLocationCatalog(); all[0].name = 'modified';
  assert.notEqual(getLocationCatalog()[0].name, 'modified');
});

test('same-name cities/counties are ambiguous and copied suggestions select the exact record', async () => {
  const service = makeService({ fetchImpl: noNetwork });
  let ambiguous;
  await assert.rejects(service.resolve('朝阳'), (error) => {
    ambiguous = error; return error.code === 'LOCATION_AMBIGUOUS' && error.suggestions.length >= 3;
  });
  for (const suggestion of ambiguous.suggestions) {
    const selected = await service.resolve(suggestion);
    assert.ok(suggestion.includes(selected.id));
  }
  assert.equal((await service.resolve('北京朝阳')).id, 'qweather-101010300');
  await assert.rejects(service.resolve('朝阳区'), { code: 'LOCATION_AMBIGUOUS' });
  await assert.rejects(service.resolve('qweather-NotARealId'), { code: 'LOCATION_NOT_FOUND' });
  const city = await service.resolve('qweather-101071201');
  const county = await service.resolve('qweather-101071208');
  assert.notEqual(city.name, county.name, 'do not erase a county suffix when its parent city has the same stem');
  assert.match(county.name, /朝阳县$/);
});

test('validatePlace rejects malformed coordinates, IDs, labels, prototypes and strips unneeded payload', () => {
  const safe = validatePlace({ ...CITIES.beijing, raw: { secret: 'hidden' }, url: 'https://bad.invalid' });
  assert.deepEqual(safe, CITIES.beijing);
  for (const value of [null, [], new Date(), Object.create(CITIES.beijing),
    { ...CITIES.beijing, id: '../secret' }, { ...CITIES.beijing, name: 'A\nB' },
    { ...CITIES.beijing, latitude: '39' }, { ...CITIES.beijing, latitude: Infinity },
    { ...CITIES.beijing, latitude: 91 }, { ...CITIES.beijing, longitude: -181 },
    { ...CITIES.beijing, admin1: 'https://example.test' }, { ...CITIES.beijing, countryCode: 'cn' }]) {
    assert.throws(() => validatePlace(value), { code: 'LOCATION_INPUT_INVALID' });
  }
});

test('invalid user input cannot make any network request', async () => {
  let calls = 0;
  const service = makeService({ fetchImpl: async () => { calls++; throw new Error(); } });
  for (const value of ['', '   ', null, {}, 1, 'https://example.test', '../北京', '北京\n上海',
    'a'.repeat(61), '<@abc>', '北京?x=y', '北京\u0000']) {
    await assert.rejects(service.resolve(value), { code: 'LOCATION_INPUT_INVALID' });
  }
  assert.equal(calls, 0);
});

test('dynamic fallback uses only official HTTPS geocoding with bounded response and request settings', async () => {
  const calls = [];
  const service = makeService({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return response({ results: [foreign()] });
  } });
  const place = await service.resolve('Paris, France');
  assert.equal(place.id, 'geonames-2988507');
  assert.equal(place.latitude, 48.8534);
  assert.match(place.name, /France.*Paris/);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(url.pathname, '/v1/search');
  assert.equal(url.searchParams.get('name'), 'Paris, France');
  assert.equal(url.searchParams.get('language'), 'zh');
  assert.equal(url.searchParams.get('count'), '100');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'GET');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual(await service.resolve(place.id), place);
});

test('dynamic ambiguity never picks the first result and allows cached stable-ID selection', async () => {
  let calls = 0;
  const service = makeService({ now: () => NOW, fetchImpl: async () => {
    calls++; return response({ results: [foreign(), foreign({ id: 4717560, country: 'United States', country_code: 'US', admin1: 'Texas' })] });
  } });
  let suggestions;
  await assert.rejects(service.resolve('Paris'), (error) => {
    suggestions = error.suggestions; return error.code === 'LOCATION_AMBIGUOUS' && suggestions.length === 2;
  });
  const second = await service.resolve(suggestions.find((entry) => entry.includes('4717560')));
  assert.equal(second.id, 'geonames-4717560');
  assert.equal(calls, 1);
});

test('concurrent identical fallback requests coalesce and positive cache expires after 24 hours', async () => {
  let now = NOW, calls = 0;
  const service = makeService({ now: () => now, fetchImpl: async () => {
    calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return response({ results: [foreign()] });
  } });
  const places = await Promise.all(Array.from({ length: 12 }, () => service.resolve('Paris France')));
  assert.equal(calls, 1); assert.equal(places.length, 12);
  await service.resolve('Paris France'); assert.equal(calls, 1);
  now += 24 * 3600_000 + 1;
  await service.resolve('Paris France'); assert.equal(calls, 2);
});

test('distinct dynamic requests use at most two simultaneous downloads', async () => {
  let active = 0, peak = 0, calls = 0;
  const service = makeService({ fetchImpl: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    return response({ results: [foreign()] });
  } });
  await Promise.all(Array.from({ length: 12 }, (_, index) => service.resolve(`ForeignPlace${index}`)));
  assert.equal(calls, 12); assert.equal(peak, 2);
});

test('missing locations and ADM1-only responses are not converted into city-center forecasts', async () => {
  let calls = 0, now = NOW;
  const service = makeService({ now: () => now, fetchImpl: async () => {
    calls++; return response({ results: [foreign({ feature_code: 'ADM1' })] });
  } });
  await assert.rejects(service.resolve('ProvinceOnly'), { code: 'LOCATION_NOT_FOUND' });
  await assert.rejects(service.resolve('ProvinceOnly'), { code: 'LOCATION_NOT_FOUND' });
  assert.equal(calls, 1);
  now += 10 * 60_000 + 1;
  await assert.rejects(service.resolve('ProvinceOnly'), { code: 'LOCATION_NOT_FOUND' });
  assert.equal(calls, 2);
});

test('failed or malformed sources return fixed errors without automatic retries or raw content', async () => {
  const cases = [
    async () => { throw new Error('private-url-or-credential'); },
    async () => response({ error: true, reason: 'private-url-or-credential' }),
    async () => response({}, { status: 429 }),
    async () => new Response('<html>private-error</html>', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
    async () => response({ results: [foreign({ latitude: 999 })] }),
    async () => response({ results: [foreign({ id: '../escape' })] }),
    async () => response({ results: Array(101).fill(foreign()) }),
    async () => new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    async () => response({}, { headers: { 'content-type': 'application/json', 'content-length': '9999999' } }),
  ];
  for (const fetchImpl of cases) {
    let calls = 0;
    const service = makeService({ fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } });
    await assert.rejects(service.resolve('UncataloguedPlace'), (error) =>
      error.code === 'LOCATION_SOURCE_UNAVAILABLE' && error.message === 'LOCATION_SOURCE_UNAVAILABLE');
    assert.equal(calls, 1);
  }
});

test('JSON catalog keeps source IDs, aliases and administrative provenance outside safe runtime places', () => {
  const data = JSON.parse(readFileSync(new URL('../data/weather-locations.json', import.meta.url), 'utf8'));
  assert.equal(data.places.length, getLocationCatalog().length);
  for (const row of data.places) {
    assert.equal(row.id, `qweather-${row.sourceLocationId}`);
    assert.ok(Array.isArray(row.aliases) && row.aliases.includes(row.sourceName));
    assert.equal('aliases' in validatePlace(row), false);
    assert.equal('administrativeCode' in validatePlace(row), false);
  }
});
