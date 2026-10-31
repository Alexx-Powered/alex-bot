import test from 'node:test';
import assert from 'node:assert/strict';
import { getWeatherBrief, ForecastDataError, HOUR_MS, localTime } from '../src/weather.mjs';

const NOW = Date.parse('2026-10-28T10:15:00Z');
function weatherFixture(date = '2026-10-28', hours = 48) {
  const midnight = Date.parse(date + 'T00:00:00+08:00');
  return { timezone: 'Asia/Shanghai', utc_offset_seconds: 28800,
    hourly_units: { temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm', precipitation_probability: '%', rain: 'mm', snowfall: 'cm', cloud_cover: '%' },
    hourly: { time: Array.from({ length: hours }, (_, i) => localTime(midnight + i * HOUR_MS)),
      temperature_2m: Array.from({ length: hours }, (_, i) => 10 + i % 12),
      cloud_cover: Array.from({ length: hours }, (_, i) => i % 101),
      relative_humidity_2m: Array(hours).fill(60), precipitation: Array(hours).fill(0),
      precipitation_probability: Array(hours).fill(0), rain: Array(hours).fill(0), snowfall: Array(hours).fill(0) } };
}
function metadata(now = NOW) {
  return { last_run_initialisation_time: Math.floor((now - 12 * HOUR_MS) / 1000),
    last_run_availability_time: Math.floor((now - 4 * HOUR_MS) / 1000), data_end_time: Math.floor((now + 6 * 24 * HOUR_MS) / 1000) };
}
function fixtureFetch(data = weatherFixture(), { meta = metadata(), date = NOW, status = 200, calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('/static/meta.json') ? meta : data), {
      status, headers: { 'content-type': 'application/json', date: new Date(date).toUTCString() },
    });
  };
}

test('Beijing weather requests only the fixed ECMWF model and returns 24 labelled forecast intervals', async () => {
  const calls = [];
  const result = await getWeatherBrief({ city: 'beijing', day: 'today', now: NOW, fetchImpl: fixtureFetch(undefined, { calls }) });
  assert.equal(result.hourly.length, 24);
  assert.equal(result.city.name, '北京');
  assert.equal(result.date, '2026-10-28');
  assert.equal(result.timezone, 'Asia/Shanghai');
  assert.equal(result.hourly[0].time, '2026-10-28T00:00:00+08:00');
  assert.equal(result.hourly.at(-1).periodEnd, '2026-10-29T00:00:00+08:00');
  assert.equal(result.summary.precipitationTotalMm, 0);
  assert.equal(result.summary.rain.category, 'low_signal');
  assert.match(result.text, /模型预报，非实测/);
  assert.match(result.text, /不是全日降水概率/);
  assert.equal(result.modelRunAt, null, 'provider metadata is not an exact response-run binding');
  assert.ok(result.warnings.includes('MODEL_RUN_NOT_BOUND_TO_RESPONSE'));
  assert.equal(calls.length, 2);
  const request = new URL(calls.find((c) => c.url.includes('/v1/')).url);
  assert.equal(request.hostname, 'api.open-meteo.com');
  assert.equal(request.searchParams.get('models'), 'ecmwf_ifs025');
  assert.equal(request.searchParams.get('start_date'), '2026-10-28');
  assert.equal(request.searchParams.get('end_date'), '2026-10-29');
  assert.ok(calls.every((c) => c.options.redirect === 'error'));
});

test('two-day charts include the next day final hour and request the following midnight for precipitation', async () => {
  const data = weatherFixture('2026-10-28', 72), calls = [];
  data.hourly.precipitation[0] = 99;
  data.hourly.precipitation[48] = 2.5;
  data.hourly.precipitation_probability[48] = 80;
  data.hourly.precipitation[49] = 99;
  const result = await getWeatherBrief({ days: 2, now: NOW, fetchImpl: fixtureFetch(data, { calls }) });
  assert.equal(result.hourly.length, 48);
  assert.equal(result.hourly[0].time, '2026-10-28T00:00:00+08:00');
  assert.equal(result.hourly.at(-1).periodEnd, '2026-10-30T00:00:00+08:00');
  assert.equal(result.hourly.at(-1).precipitationProbabilityPct, 80);
  assert.equal(result.hourly[0].cloudCoverPct, 0);
  assert.equal(result.hourly[1].cloudCoverPct, 1);
  assert.equal(result.hourly.at(-1).cloudCoverPct, 47, 'Cloud is instantaneous, not shifted with precipitation');
  assert.equal(result.summary.precipitationTotalMm, 2.5);
  assert.match(result.text, /两日天气预报/);
  const request = new URL(calls.find(call => call.url.includes('/v1/')).url);
  assert.equal(request.searchParams.get('start_date'), '2026-10-28');
  assert.equal(request.searchParams.get('end_date'), '2026-10-30');
  assert.ok(request.searchParams.get('hourly').split(',').includes('cloud_cover'));
  assert.equal(request.searchParams.get('models'), 'ecmwf_ifs025');
  for (const days of [0, 3, '2', null]) {
    await assert.rejects(getWeatherBrief({ days, now: NOW, fetchImpl: async () => assert.fail('No request') }), { code: 'WEATHER_DAYS_UNSUPPORTED' });
  }
});

test('cloud percentage validates its own units, shape and range without erasing other forecasts', async () => {
  const data = weatherFixture();
  data.hourly.cloud_cover.splice(0, 6, 0, 100, null, -1, 101, '50');
  const report = await getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(data) });
  assert.deepEqual(report.hourly.slice(0, 6).map(row => row.cloudCoverPct), [0, 100, null, null, null, null]);
  assert.equal(report.summary.cloudCover.max, 100);
  assert.equal(report.summary.temperature.validHours, 24);
  for (const edit of [d => { delete d.hourly.cloud_cover; }, d => { d.hourly.cloud_cover.pop(); }, d => { d.hourly_units.cloud_cover = 'fraction'; }]) {
    const missing = weatherFixture(); edit(missing);
    const result = await getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(missing) });
    assert.ok(result.hourly.every(row => row.cloudCoverPct === null));
    assert.equal(result.summary.temperature.validHours, 24);
  }
});

test('apparent temperature uses instantaneous Celsius samples and remains missing when unavailable', async () => {
  const data = weatherFixture();
  data.hourly_units.apparent_temperature = '°C';
  data.hourly.apparent_temperature = Array.from({length:48}, (_,i)=>i-10);
  const result = await getWeatherBrief({now:NOW,fetchImpl:fixtureFetch(data)});
  assert.equal(result.hourly[0].apparentTemperatureC,-10);
  assert.equal(result.hourly[1].apparentTemperatureC,-9);
  const missing = await getWeatherBrief({now:NOW,fetchImpl:fixtureFetch()});
  assert.ok(missing.hourly.every(row=>row.apparentTemperatureC===null));
});

test('exercise wind/code are instant but sunshine is shifted from preceding-hour mean',async()=>{
  const data=weatherFixture(),calls=[];
  Object.assign(data.hourly_units,{wind_speed_10m:'m/s',shortwave_radiation:'W/m²',weather_code:'wmo code'});
  Object.assign(data.hourly,{wind_speed_10m:Array(48).fill(2),shortwave_radiation:Array.from({length:48},(_,i)=>i*10),weather_code:Array(48).fill(0)});
  const report=await getWeatherBrief({city:'beijing',now:NOW,exerciseFields:true,fetchImpl:fixtureFetch(data,{calls})});
  assert.equal(report.hourly[0].solarRadiationWm2,10);assert.equal(report.hourly[23].solarRadiationWm2,240);assert.equal(report.hourly[0].windSpeedMs,2);
  assert.match(calls[0].url,/wind_speed_unit=ms/);assert.match(calls[0].url,/shortwave_radiation/);
  delete data.hourly.wind_speed_10m;data.hourly_units.shortwave_radiation='wrong';data.hourly.weather_code[0]=0.5;
  const missing=await getWeatherBrief({now:NOW,exerciseFields:true,fetchImpl:fixtureFetch(data)});
  assert.equal(missing.hourly[0].windSpeedMs,null);assert.equal(missing.hourly[0].solarRadiationWm2,null);assert.equal(missing.hourly[0].weatherCode,null);
});

test('tomorrow follows Shanghai calendar across UTC midnight and supports Tianjin', async () => {
  const now = Date.parse('2026-10-28T16:15:00Z'); // Shanghai is already Oct 29.
  const data = weatherFixture('2026-10-30');
  const result = await getWeatherBrief({ city: 'tianjin', day: 'tomorrow', now,
    fetchImpl: fixtureFetch(data, { meta: metadata(now), date: now }) });
  assert.equal(result.date, '2026-10-30');
  assert.equal(result.city.name, '天津');
  assert.equal(new URL(result.source.url).searchParams.get('latitude'), '39.0842');
});

test('Guangzhou weather uses its fixed coordinates and labels without substituting another city', async () => {
  const calls = [];
  const result = await getWeatherBrief({ city: 'guangzhou', now: NOW, fetchImpl: fixtureFetch(undefined, { calls }) });
  assert.deepEqual(result.city, { id: 'guangzhou', name: '广州', latitude: 23.1291, longitude: 113.2644 });
  assert.match(result.text, /^广州 今日天气预报｜2026-10-28/);
  assert.doesNotMatch(result.text, /北京|天津/);
  assert.equal(result.hourly.length, 24);
  assert.equal(calls.length, 2);
  const url = new URL(calls.find((call) => call.url.includes('/v1/')).url);
  assert.equal(url.href, result.source.url);
  assert.equal(url.searchParams.get('latitude'), '23.1291');
  assert.equal(url.searchParams.get('longitude'), '113.2644');
  assert.equal(url.searchParams.get('models'), 'ecmwf_ifs025');
  assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai');
});

test('preceding-hour precipitation is shifted correctly and includes the final hour of the requested day', async () => {
  const data = weatherFixture();
  data.hourly.precipitation[0] = 99; // belongs to previous day, must be excluded.
  data.hourly.rain[0] = 99;
  data.hourly.precipitation[24] = 2.5; // 23:00-24:00 of requested day.
  data.hourly.rain[24] = 2.5;
  data.hourly.precipitation_probability[24] = 80;
  const result = await getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(data) });
  assert.equal(result.hourly[0].precipitationMm, 0);
  assert.equal(result.hourly[23].precipitationMm, 2.5);
  assert.equal(result.summary.precipitationTotalMm, 2.5);
  assert.equal(result.summary.maxHourlyPrecipitationProbabilityPct, 80);
  assert.equal(result.summary.rain.category, 'rain_signal');
  assert.match(result.text, /23:00–24:00/);
});

test('snow alone is not described as rain; probability-only signals remain uncertain', async () => {
  const snow = weatherFixture();
  snow.hourly.precipitation[9] = 1;
  snow.hourly.snowfall[9] = 0.7;
  const snowResult = await getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(snow) });
  assert.equal(snowResult.summary.rain.category, 'snow_signal');
  const uncertain = weatherFixture();
  uncertain.hourly.precipitation_probability[9] = 70;
  const uncertainResult = await getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(uncertain) });
  assert.equal(uncertainResult.summary.rain.category, 'precipitation_possible');
});

test('null and invalid numeric fields remain missing and cannot manufacture a dry day or rainfall total', async () => {
  const data = weatherFixture();
  data.hourly.temperature_2m[3] = null;
  data.hourly.relative_humidity_2m[4] = '50';
  data.hourly.precipitation[7] = null;
  data.hourly.rain[7] = -1;
  data.hourly.precipitation_probability[7] = null;
  const result = await getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(data) });
  assert.equal(result.hourly[3].temperatureC, null);
  assert.equal(result.hourly[4].humidityPct, null);
  assert.equal(result.hourly[6].rainMm, null);
  assert.equal(result.summary.precipitationTotalMm, null);
  assert.equal(result.summary.rain.category, 'unknown');
  assert.equal(result.summary.temperature.complete, false);
  assert.ok(result.warnings.includes('MISSING_VALUES'));
  assert.match(result.text, /缺失值未计为零/);
});

test('expired model metadata and stale HTTP responses are refused without silently using old data', async () => {
  const stale = metadata(); stale.last_run_initialisation_time = (NOW - 25 * HOUR_MS) / 1000;
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(undefined, { meta: stale }) }), { code: 'FORECAST_MODEL_STALE' });
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(undefined, { date: NOW - HOUR_MS }) }), { code: 'FORECAST_RESPONSE_STALE' });
  const truncated = metadata(); truncated.data_end_time = Math.floor(NOW / 1000);
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(undefined, { meta: truncated }) }), { code: 'FORECAST_MODEL_STALE' });
});

test('wrong timezone, units, array shape and missing coverage fail closed', async () => {
  const cases = [
    ['FORECAST_TIMEZONE_INVALID', (d) => { d.utc_offset_seconds = 0; }],
    ['FORECAST_UNITS_INVALID', (d) => { d.hourly_units.precipitation = 'inch'; }],
    ['FORECAST_SCHEMA_INVALID', (d) => { d.hourly.rain.pop(); }],
    ['FORECAST_TIME_INVALID', (d) => { d.hourly.time[2] = d.hourly.time[1]; }],
    ['FORECAST_COVERAGE_INCOMPLETE', (d) => { for (const values of Object.values(d.hourly)) values.splice(24, 1); }],
    ['FORECAST_DATA_MISSING', (d) => { d.hourly.temperature_2m.fill(null); }],
  ];
  for (const [code, edit] of cases) {
    const data = weatherFixture(); edit(data);
    await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(data) }), { code });
  }
});

test('unsupported arguments make no request, and network failures expose only fixed codes', async () => {
  let count = 0;
  const fetchImpl = async () => { count++; throw new Error('private upstream diagnostic'); };
  for (const city of ['shanghai', '__proto__', 'toString', 'constructor', null, new String('guangzhou')]) {
    await assert.rejects(getWeatherBrief({ city, now: NOW, fetchImpl }), { code: 'WEATHER_CITY_UNSUPPORTED' });
  }
  await assert.rejects(getWeatherBrief({ day: 'yesterday', now: NOW, fetchImpl }), { code: 'WEATHER_DAY_UNSUPPORTED' });
  assert.equal(count, 0);
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl }), (error) => {
    assert.ok(error instanceof ForecastDataError); assert.equal(error.code, 'FORECAST_SOURCE_UNAVAILABLE');
    assert.doesNotMatch(error.message, /private/); return true;
  });
  assert.equal(count, 2, 'one request per source, no automatic retry');
});

test('HTTP failure, oversize data, and non-JSON responses produce fixed errors', async () => {
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: fixtureFetch(undefined, { status: 429 }) }), { code: 'FORECAST_SOURCE_RATE_LIMITED' });
  const invalid = async () => new Response('not JSON', { headers: { 'content-type': 'text/html', date: new Date(NOW).toUTCString() } });
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: invalid }), { code: 'FORECAST_RESPONSE_INVALID' });
  const oversize = async () => new Response('x'.repeat(600_000), { headers: { 'content-type': 'application/json', date: new Date(NOW).toUTCString() } });
  await assert.rejects(getWeatherBrief({ now: NOW, fetchImpl: oversize }), { code: 'FORECAST_RESPONSE_TOO_LARGE' });
});

test('resolved locations outside compatibility cities use their coordinates and reject inconsistent identities',async()=>{
  const place={id:'geonames-1796236',name:'上海',latitude:31.2304,longitude:121.4737},calls=[];
  const result=await getWeatherBrief({place,now:NOW,fetchImpl:fixtureFetch(undefined,{calls})});
  assert.equal(result.city.id,place.id); assert.match(result.text,/上海/);
  const query=new URL(calls.find(call=>call.url.includes('/v1/')).url);
  assert.equal(query.searchParams.get('latitude'),String(place.latitude));assert.equal(query.searchParams.get('longitude'),String(place.longitude));
  let fetched=0;const fetchImpl=async()=>{fetched++;throw Error();};
  await assert.rejects(getWeatherBrief({place,city:'beijing',now:NOW,fetchImpl}),{code:'WEATHER_CITY_MISMATCH'});
  for(const invalid of [{...place,latitude:91},{...place,longitude:Infinity},{...place,name:'bad\nlabel'}]) await assert.rejects(getWeatherBrief({place:invalid,now:NOW,fetchImpl}));
  assert.equal(fetched,0);
});
