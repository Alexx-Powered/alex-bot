import test from 'node:test';
import assert from 'node:assert/strict';
import { getAirQuality, getBeijingAirQuality } from '../src/air-quality.mjs';
import { HOUR_MS, localTime } from '../src/weather.mjs';

const NOW = Date.parse('2026-10-28T10:15:00Z');
const START = Math.floor(NOW / HOUR_MS) * HOUR_MS;
test('scheduled CAMS applies its longer bounded timeout to data and metadata only',async t=>{
  const timeouts=[],original=AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return original(ms);});
  await getAirQuality({now:NOW,fetchImpl:fakeFetch(),fetchTimeoutMs:45000});
  assert.deepEqual(timeouts,[15000,15000]);timeouts.length=0;
  await getAirQuality({now:NOW,fetchImpl:fakeFetch(),scheduledMorning:true,fetchTimeoutMs:41000});
  assert.deepEqual(timeouts,[41000,41000]);
});
test('tomorrow calendar PM2.5 shifts dates without shifting source freshness clock',async()=>{
  const start=Date.parse('2026-10-29T00:00:00+08:00'),data=dataset(),calls=[];
  data.hourly.time=Array.from({length:48},(_,i)=>localTime(start+i*HOUR_MS));
  const result=await getAirQuality({now:NOW,window:'calendar',day:'tomorrow',fetchImpl:fakeFetch(data,undefined,calls)});
  assert.equal(result.hourly[0].time,'2026-10-29T00:00:00+08:00');
  assert.equal(result.hourly.at(-1).time,'2026-10-30T23:00:00+08:00');
  assert.equal(result.fetchedAt,new Date(NOW).toISOString());
  const url=new URL(calls.find(c=>c.url.includes('/v1/')).url);
  assert.equal(url.searchParams.get('start_date'),'2026-10-29');assert.equal(url.searchParams.get('end_date'),'2026-10-30');
  await assert.rejects(getAirQuality({now:NOW,day:'tomorrow',fetchImpl:fakeFetch()}),{code:'AIR_DAY_UNSUPPORTED'});
});
function dataset() {
  return { timezone: 'Asia/Shanghai', utc_offset_seconds: 28800, hourly_units: { pm2_5: 'μg/m³' },
    hourly: { time: Array.from({ length: 48 }, (_, i) => localTime(START + i * HOUR_MS)), pm2_5: Array.from({ length: 48 }, (_, i) => 20 + i) } };
}
function metadata() {
  return { last_run_initialisation_time: Math.floor((NOW - 12 * HOUR_MS) / 1000),
    last_run_availability_time: Math.floor((NOW - 4 * HOUR_MS) / 1000), data_end_time: Math.floor((NOW + 5 * 24 * HOUR_MS) / 1000) };
}
function fakeFetch(data = dataset(), meta = metadata(), calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('/static/meta.json') ? meta : data), { headers: { 'content-type': 'application/json', date: new Date(NOW).toUTCString() } });
  };
}

test('Beijing curve explicitly selects CAMS Global, spans 48 hourly points and labels predictions', async () => {
  const calls = [];
  const result = await getBeijingAirQuality({ now: NOW, fetchImpl: fakeFetch(undefined, undefined, calls) });
  assert.equal(result.hourly.length, 48);
  assert.equal(result.hourly[0].time, '2026-10-28T18:00:00+08:00');
  assert.equal(result.hourly.at(-1).time, '2026-10-30T17:00:00+08:00');
  assert.equal(result.summary.maxPm25, 67);
  assert.equal(result.summary.meanPm25, 43.5);
  assert.equal(result.summary.validHours, 48);
  assert.equal(result.summary.missingHours, 0);
  assert.equal(result.unit, 'μg/m³');
  assert.match(result.title, /模型预报（非实测）/);
  assert.match(result.text, /CAMS \/ ECMWF，经 Open-Meteo/);
  assert.doesNotMatch(result.text, /公里|分辨率/);
  assert.match(result.text, /不能单凭此判断是否有雾/);
  assert.equal(result.source.nativeTemporalResolutionHours, 3);
  assert.equal(result.modelRunAt, null);
  assert.equal(calls.length, 2);
  const url = new URL(calls.find((call) => call.url.includes('/v1/')).url);
  assert.equal(url.searchParams.get('domains'), 'cams_global');
  assert.equal(url.searchParams.get('forecast_hours'), '48');
  assert.equal(url.hostname, 'air-quality-api.open-meteo.com');
});

test('calendar window includes both complete local days while rolling remains the default', async () => {
  const data = dataset(), calls = [];
  const midnight = Date.parse('2026-10-28T00:00:00+08:00');
  data.hourly.time = Array.from({ length: 48 }, (_, i) => localTime(midnight + i * HOUR_MS));
  const result = await getAirQuality({ window: 'calendar', now: NOW, fetchImpl: fakeFetch(data, undefined, calls) });
  assert.equal(result.hourly[0].time, '2026-10-28T00:00:00+08:00');
  assert.equal(result.hourly.at(-1).time, '2026-10-29T23:00:00+08:00');
  assert.match(result.text, /今明两天/);
  const url = new URL(calls.find(call => call.url.includes('/v1/')).url);
  assert.equal(url.searchParams.get('start_date'), '2026-10-28');
  assert.equal(url.searchParams.get('end_date'), '2026-10-29');
  assert.equal(url.searchParams.has('forecast_hours'), false);
  await assert.rejects(getAirQuality({ window: 'anything', now: NOW, fetchImpl: async () => assert.fail('No request') }), { code: 'AIR_WINDOW_UNSUPPORTED' });
});

test('generalized CAMS requests and labels use the selected Guangzhou or Tianjin coordinates', async (t) => {
  for (const [city, name, latitude, longitude] of [
    ['guangzhou', '广州', 23.1291, 113.2644],
    ['tianjin', '天津', 39.0842, 117.2009],
  ]) await t.test(city, async () => {
    const calls = [];
    const result = await getAirQuality({ city, now: NOW, fetchImpl: fakeFetch(undefined, undefined, calls) });
    assert.deepEqual(result.city, { id: city, name, latitude, longitude });
    assert.equal(result.title, `${name} PM2.5 模型预报（非实测）`);
    assert.ok(result.text.startsWith(`${name} PM2.5 模型预报（非实测）`));
    assert.doesNotMatch(result.text + result.title, /北京/);
    assert.equal(result.hourly.length, 48);
    assert.equal(calls.length, 2);
    const url = new URL(calls.find((call) => call.url.includes('/v1/')).url);
    assert.equal(url.href, result.source.url);
    assert.equal(url.hostname, 'air-quality-api.open-meteo.com');
    assert.equal(url.searchParams.get('latitude'), String(latitude));
    assert.equal(url.searchParams.get('longitude'), String(longitude));
    assert.equal(url.searchParams.get('domains'), 'cams_global');
    assert.equal(url.searchParams.get('forecast_hours'), '48');
  });
});

test('generic CAMS defaults to Beijing and legacy wrapper remains pinned to Beijing', async () => {
  const defaultResult = await getAirQuality({ now: NOW, fetchImpl: fakeFetch() });
  const calls = [];
  const legacyResult = await getBeijingAirQuality({ city: 'guangzhou', now: NOW,
    fetchImpl: fakeFetch(undefined, undefined, calls) });
  assert.equal(defaultResult.city.id, 'beijing');
  assert.deepEqual(legacyResult.city, defaultResult.city);
  assert.equal(legacyResult.title, '北京 PM2.5 模型预报（非实测）');
  const url = new URL(calls.find((call) => call.url.includes('/v1/')).url);
  assert.equal(url.searchParams.get('latitude'), '39.9042');
  assert.equal(url.searchParams.get('longitude'), '116.4074');
});

test('invalid or inherited city names cannot start any CAMS network request', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('must not request'); };
  for (const city of ['shanghai', '__proto__', 'toString', 'constructor', null, new String('guangzhou'),
    'https://example.invalid/guangzhou']) {
    await assert.rejects(getAirQuality({ city, now: NOW, fetchImpl }), { code: 'AIR_CITY_UNSUPPORTED' });
  }
  assert.equal(requests, 0);
});

test('missing and out-of-range PM2.5 values remain gaps, while true zero remains zero', async () => {
  const data = dataset();
  data.hourly.pm2_5[0] = 0;
  data.hourly.pm2_5[1] = null;
  data.hourly.pm2_5[2] = '35';
  data.hourly.pm2_5[3] = -2;
  const result = await getBeijingAirQuality({ now: NOW, fetchImpl: fakeFetch(data) });
  assert.equal(result.hourly[0].pm25, 0);
  assert.deepEqual(result.hourly.slice(1, 4).map((p) => p.pm25), [null, null, null]);
  assert.equal(result.summary.minPm25, 0);
  assert.equal(result.summary.meanPm25, null);
  assert.equal(result.summary.missingHours, 3);
  assert.ok(result.warnings.includes('MISSING_VALUES'));
  assert.match(result.text, /缺失不能画成零/);
});

test('overage CAMS initialization, outdated availability and insufficient forecast horizon are refused', async () => {
  const oldRun = metadata(); oldRun.last_run_initialisation_time = (NOW - 37 * HOUR_MS) / 1000;
  const oldAvailability = metadata(); oldAvailability.last_run_initialisation_time = (NOW - 30 * HOUR_MS) / 1000; oldAvailability.last_run_availability_time = (NOW - 25 * HOUR_MS) / 1000;
  const shortRun = metadata(); shortRun.data_end_time = (START + 20 * HOUR_MS) / 1000;
  for (const meta of [oldRun, oldAvailability, shortRun]) {
    await assert.rejects(getBeijingAirQuality({ now: NOW, fetchImpl: fakeFetch(undefined, meta) }), { code: 'FORECAST_MODEL_STALE' });
  }
});

test('too little valid PM2.5, wrong units, stale coverage and duplicate timestamps do not render fake curves', async () => {
  const cases = [
    ['FORECAST_DATA_MISSING', (d) => { d.hourly.pm2_5.fill(null, 20); }],
    ['FORECAST_UNITS_INVALID', (d) => { d.hourly_units.pm2_5 = 'AQI'; }],
    ['FORECAST_COVERAGE_INCOMPLETE', (d) => { d.hourly.time = d.hourly.time.map((_, i) => localTime(START - HOUR_MS + i * HOUR_MS)); }],
    ['FORECAST_TIME_INVALID', (d) => { d.hourly.time[3] = d.hourly.time[2]; }],
  ];
  for (const [code, edit] of cases) {
    const data = dataset(); edit(data);
    await assert.rejects(getBeijingAirQuality({ now: NOW, fetchImpl: fakeFetch(data) }), { code });
  }
});

test('metadata publication in last ten minutes is explicitly identified as possibly propagating', async () => {
  const meta = metadata(); meta.last_run_availability_time = (NOW - 5 * 60_000) / 1000;
  const result = await getBeijingAirQuality({ now: NOW, fetchImpl: fakeFetch(undefined, meta) });
  assert.ok(result.warnings.includes('MODEL_UPDATE_PROPAGATING'));
  assert.equal(result.freshness.recentUpdate, true);
  assert.equal(result.freshness.latestModelRunAt, new Date(meta.last_run_initialisation_time * 1000).toISOString());
});

test('arbitrary resolved locations query local CAMS; legacy Beijing wrapper cannot be redirected',async()=>{
  const place={id:'geonames-1796236',name:'上海',latitude:31.2304,longitude:121.4737},calls=[];
  const result=await getAirQuality({place,now:NOW,fetchImpl:fakeFetch(undefined,undefined,calls)});
  assert.equal(result.city.id,place.id);assert.match(result.title,/上海/);
  const query=new URL(calls.find(call=>call.url.includes('/v1/')).url);
  assert.equal(query.searchParams.get('latitude'),String(place.latitude));assert.equal(query.searchParams.get('longitude'),String(place.longitude));
  const legacy=await getBeijingAirQuality({place,now:NOW,fetchImpl:fakeFetch()});assert.equal(legacy.city.id,'beijing');
  let fetched=0;const fetchImpl=async()=>{fetched++;throw Error();};
  await assert.rejects(getAirQuality({place,city:'beijing',now:NOW,fetchImpl}),{code:'AIR_CITY_MISMATCH'});
  await assert.rejects(getAirQuality({place:{...place,latitude:NaN},now:NOW,fetchImpl}));assert.equal(fetched,0);
});

test('a single CAMS hour remains valid in a dated panel',async()=>{
  const day='2026-11-01',start=Date.parse(day+'T00:00:00+08:00');
  const data=dataset();data.hourly.time=data.hourly.time.map((_,i)=>localTime(start+i*HOUR_MS));
  const meta={...metadata(),data_end_time:(start+HOUR_MS)/1000};
  const args={window:'calendar',day,partialWindow:true,now:NOW,fetchImpl:fakeFetch(data,meta)};
  const result=await getAirQuality(args);
  assert.equal(result.summary.validHours,1);
  assert.deepEqual(result.hourly.slice(0,2).map(r=>r.pm25),[20,null]);
  await assert.rejects(getAirQuality({...args,day:'2026-11-02'}),{code:'FORECAST_OUTSIDE_WINDOW'});
});