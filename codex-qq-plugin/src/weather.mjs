// Forecasts, never observations. Source contracts:
// https://open-meteo.com/en/docs/ecmwf-api
// https://open-meteo.com/en/docs/model-updates
export const FORECAST_TIMEZONE = 'Asia/Shanghai';
export const HOUR_MS = 3_600_000;
import { CITIES, validatePlace } from './locations.mjs';
export { CITIES } from './locations.mjs';
const WEATHER_ENDPOINT = 'https://api.open-meteo.com/v1/ecmwf';
const WEATHER_METADATA = 'https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json';
const MAX_BODY_BYTES = 512 * 1024;
const VARIABLES = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'precipitation_probability', 'rain', 'snowfall'];

export class ForecastDataError extends Error {
  constructor(code) { super(code); this.name = 'ForecastDataError'; this.code = code; }
}
export function forecastNow(value = Date.now()) {
  const time = typeof value === 'function' ? value() : value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(time) || time < 0 || time > 8_640_000_000_000_000 - 4 * 24 * HOUR_MS) throw new ForecastDataError('FORECAST_CLOCK_INVALID');
  return time;
}
export function localTime(time) { return new Date(time + 8 * HOUR_MS).toISOString().slice(0, 16); }
export function localIso(time) { return localTime(time) + ':00+08:00'; }
export function localDate(time) { return localTime(time).slice(0, 10); }
export function finiteValue(value, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

// URL is supplied only by the two source modules, never by a QQ message.
// Bound response size and duration, disallow redirects, and do not retry.
export async function fetchForecastJson(url, { fetchImpl = globalThis.fetch, now }) {
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new ForecastDataError(response.status === 429 ? 'FORECAST_SOURCE_RATE_LIMITED' : 'FORECAST_SOURCE_HTTP_ERROR');
    const contentType = response.headers.get('content-type') || '';
    if (!/\bapplication\/json\b/i.test(contentType)) throw new ForecastDataError('FORECAST_RESPONSE_INVALID');
    const date = Date.parse(response.headers.get('date') || '');
    // The HTTP Date checks response freshness, not the model initialization.
    if (!Number.isFinite(date) || date < now - 30 * 60_000 || date > now + 5 * 60_000) {
      throw new ForecastDataError('FORECAST_RESPONSE_STALE');
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new ForecastDataError('FORECAST_RESPONSE_TOO_LARGE');
    if (!response.body) throw new ForecastDataError('FORECAST_RESPONSE_INVALID');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new ForecastDataError('FORECAST_RESPONSE_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ForecastDataError('FORECAST_RESPONSE_INVALID'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.error) throw new ForecastDataError('FORECAST_RESPONSE_INVALID');
    return { data, httpDate: new Date(date).toISOString() };
  } catch (error) {
    if (error instanceof ForecastDataError) throw error;
    throw new ForecastDataError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'FORECAST_SOURCE_TIMEOUT' : 'FORECAST_SOURCE_UNAVAILABLE');
  }
}

export function validateModelMetadata(data, { now, requiredEnd, maxRunAgeHours }) {
  const fields = ['last_run_initialisation_time', 'last_run_availability_time', 'data_end_time'];
  if (fields.some((key) => !Number.isSafeInteger(data[key]) || data[key] <= 0)) throw new ForecastDataError('FORECAST_METADATA_INVALID');
  const run = data.last_run_initialisation_time * 1000;
  const available = data.last_run_availability_time * 1000;
  const end = data.data_end_time * 1000;
  if (run > now + 5 * 60_000 || available > now + 5 * 60_000 || run > available) throw new ForecastDataError('FORECAST_METADATA_INVALID');
  if (now - run > maxRunAgeHours * HOUR_MS || now - available > 24 * HOUR_MS || end < requiredEnd) {
    throw new ForecastDataError('FORECAST_MODEL_STALE');
  }
  return {
    // Metadata describes the provider's latest run, not a run identifier bound
    // to this particular API response (the provider is eventually consistent).
    latestModelRunAt: new Date(run).toISOString(),
    lastAvailabilityAt: new Date(available).toISOString(),
    modelAgeHours: Math.round((now - run) / HOUR_MS * 10) / 10,
    recentUpdate: now - available < 10 * 60_000,
  };
}

export function hourlyIndex(data, units) {
  if (data.timezone !== FORECAST_TIMEZONE || data.utc_offset_seconds !== 28800) throw new ForecastDataError('FORECAST_TIMEZONE_INVALID');
  if (!Array.isArray(data.hourly?.time) || data.hourly.time.length === 0 || data.hourly.time.length > 240) throw new ForecastDataError('FORECAST_SCHEMA_INVALID');
  const times = data.hourly.time;
  for (const [key, expected] of Object.entries(units)) {
    const rawUnit = data.hourly_units?.[key];
    const unit = typeof rawUnit === 'string' ? rawUnit.replaceAll('µ', 'μ') : null;
    if (unit !== expected) throw new ForecastDataError('FORECAST_UNITS_INVALID');
    if (!Array.isArray(data.hourly[key]) || data.hourly[key].length !== times.length) throw new ForecastDataError('FORECAST_SCHEMA_INVALID');
  }
  let previous = -Infinity;
  const index = new Map();
  times.forEach((time, i) => {
    if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(time)) throw new ForecastDataError('FORECAST_TIME_INVALID');
    const stamp = Date.parse(time + ':00+08:00');
    if (!Number.isFinite(stamp) || localTime(stamp) !== time || stamp <= previous) throw new ForecastDataError('FORECAST_TIME_INVALID');
    previous = stamp; index.set(stamp, i);
  });
  return index;
}

function range(values) {
  const present = values.filter((v) => v !== null);
  return { min: present.length ? Math.min(...present) : null, max: present.length ? Math.max(...present) : null,
    complete: present.length === values.length, validHours: present.length };
}
function total(values) { return values.every((v) => v !== null) ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100 : null; }
function rainIntervals(hourly) {
  const periods = [];
  for (const point of hourly) {
    if (point.rainMm === null || point.rainMm < 0.1) continue;
    const previous = periods.at(-1);
    if (previous?.end === point.time) previous.end = point.periodEnd;
    else periods.push({ start: point.time, end: point.periodEnd });
  }
  return periods;
}
export function assessRain(hourly) {
  const rain = hourly.some((p) => p.rainMm !== null && p.rainMm >= 0.1);
  const snow = hourly.some((p) => p.snowfallCm !== null && p.snowfallCm > 0);
  const precip = hourly.some((p) => p.precipitationMm !== null && p.precipitationMm >= 0.1);
  const probabilities = hourly.map((p) => p.precipitationProbabilityPct).filter((p) => p !== null);
  const maximum = probabilities.length ? Math.max(...probabilities) : null;
  const complete = hourly.every((p) => [p.rainMm, p.snowfallCm, p.precipitationMm, p.precipitationProbabilityPct].every((v) => v !== null));
  if (rain) return { category: 'rain_signal', text: snow ? '模型有雨雪信号；请留意降水时段。' : '模型有降雨信号；建议准备雨具。', intervals: rainIntervals(hourly) };
  if (snow) return { category: 'snow_signal', text: '模型有降雪信号，不能把总降水直接说成下雨。', intervals: [] };
  if (precip || (maximum !== null && maximum >= 30)) return { category: 'precipitation_possible', text: '存在降水可能；雨量和概率信号不完全一致，是否下雨仍不确定。', intervals: [] };
  if (!complete) return { category: 'unknown', text: '降水字段有缺失，暂不能可靠判断是否下雨。', intervals: [] };
  return { category: 'low_signal', text: '暂无明显降雨信号，但不保证全天无雨。', intervals: [] };
}
const shown = (value, suffix = '') => value === null ? '缺数据' : `${Math.round(value * 10) / 10}${suffix}`;

export async function getWeatherBrief({ city, place: resolvedPlace, day = 'today', exerciseFields = false, now: nowInput = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const cityKey=city===undefined?'beijing':city;
  const place = resolvedPlace === undefined ? (typeof cityKey === 'string' && Object.hasOwn(CITIES, cityKey) ? CITIES[cityKey] : null) : validatePlace(resolvedPlace);
  if (!place) throw new ForecastDataError('WEATHER_CITY_UNSUPPORTED');
  if (resolvedPlace !== undefined && city !== undefined && city !== place.id) throw new ForecastDataError('WEATHER_CITY_MISMATCH');
  if (!['today', 'tomorrow'].includes(day)) throw new ForecastDataError('WEATHER_DAY_UNSUPPORTED');
  const now = forecastNow(nowInput);
  const date = localDate(now + (day === 'tomorrow' ? 24 * HOUR_MS : 0));
  const midnight = Date.parse(date + 'T00:00:00+08:00');
  const nextMidnight = midnight + 24 * HOUR_MS;
  const url = new URL(WEATHER_ENDPOINT);
  url.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude),
    hourly: [...VARIABLES,...(exerciseFields?['wind_speed_10m','shortwave_radiation','weather_code']:[])].join(','), models: 'ecmwf_ifs025', timezone: FORECAST_TIMEZONE,
    start_date: date, end_date: localDate(nextMidnight), temperature_unit: 'celsius', precipitation_unit: 'mm' }).toString();
  if(exerciseFields)url.searchParams.set('wind_speed_unit','ms');
  const [forecast, metadata] = await Promise.all([
    fetchForecastJson(url.href, { fetchImpl, now }), fetchForecastJson(WEATHER_METADATA, { fetchImpl, now }),
  ]);
  const freshness = validateModelMetadata(metadata.data, { now, requiredEnd: nextMidnight, maxRunAgeHours: 24 });
  const data = forecast.data;
  const index = hourlyIndex(data, { temperature_2m: '°C', relative_humidity_2m: '%', precipitation: 'mm', precipitation_probability: '%', rain: 'mm', snowfall: 'cm' });
  // Optional exercise fields never turn a missing forecast into a calm/dark/clear hour.
  const extra=(key,unit,i,min,max)=>{
    const value=data.hourly_units?.[key]===unit&&Array.isArray(data.hourly?.[key])&&data.hourly[key].length===data.hourly.time.length?finiteValue(data.hourly[key][i],min,max):null;
    return key==='weather_code'&&!Number.isInteger(value)?null:value;
  };
  const hourly = [];
  for (let h = 0; h < 24; ++h) {
    const stamp = midnight + h * HOUR_MS;
    const instant = index.get(stamp), following = index.get(stamp + HOUR_MS);
    if (instant === undefined || following === undefined) throw new ForecastDataError('FORECAST_COVERAGE_INCOMPLETE');
    // The API's precipitation/probability are for the PRECEDING hour. Shift
    // these only so each row describes [time, periodEnd), including 23-24h.
    hourly.push({ time: localIso(stamp), periodEnd: localIso(stamp + HOUR_MS),
      temperatureC: finiteValue(data.hourly.temperature_2m[instant], -90, 65),
      humidityPct: finiteValue(data.hourly.relative_humidity_2m[instant], 0, 100),
      precipitationMm: finiteValue(data.hourly.precipitation[following], 0, 1000),
      precipitationProbabilityPct: finiteValue(data.hourly.precipitation_probability[following], 0, 100),
      rainMm: finiteValue(data.hourly.rain[following], 0, 1000),
      snowfallCm: finiteValue(data.hourly.snowfall[following], 0, 1000),
      ...(exerciseFields?{windSpeedMs:extra('wind_speed_10m','m/s',instant,0,150),solarRadiationWm2:extra('shortwave_radiation','W/m²',following,0,2000),weatherCode:extra('weather_code','wmo code',instant,0,99)}:{}),
    });
  }
  const temperature = range(hourly.map((p) => p.temperatureC));
  const humidity = range(hourly.map((p) => p.humidityPct));
  if (!temperature.validHours || !humidity.validHours) throw new ForecastDataError('FORECAST_DATA_MISSING');
  const probability = range(hourly.map((p) => p.precipitationProbabilityPct));
  const missingValues = hourly.some((p) => Object.values(p).includes(null));
  const warnings = ['MODEL_RUN_NOT_BOUND_TO_RESPONSE', ...(missingValues ? ['MISSING_VALUES'] : []), ...(freshness.recentUpdate ? ['MODEL_UPDATE_PROPAGATING'] : [])];
  const summary = { temperature, humidity, precipitationTotalMm: total(hourly.map((p) => p.precipitationMm)),
    rainTotalMm: total(hourly.map((p) => p.rainMm)), snowfallTotalCm: total(hourly.map((p) => p.snowfallCm)),
    maxHourlyPrecipitationProbabilityPct: probability.max, probabilityComplete: probability.complete, rain: assessRain(hourly) };
  const source = { name: 'ECMWF IFS 0.25°，经 Open-Meteo 提供', model: 'ecmwf_ifs025', provider: 'Open-Meteo',
    type: 'model_forecast', documentation: 'https://open-meteo.com/en/docs/ecmwf-api',
    metadataDocumentation: 'https://open-meteo.com/en/docs/model-updates', attribution: 'ECMWF / Open-Meteo', url: url.href };
  const intervalText = summary.rain.intervals.map((p) => `${p.start.slice(11, 16)}–${p.end.slice(11, 16) === '00:00' ? '24:00' : p.end.slice(11, 16)}`).join('、');
  const text = [
    `${place.name} ${day === 'today' ? '今日' : '明日'}天气预报｜${date}`,
    `逐小时温度范围 ${shown(temperature.min)}～${shown(temperature.max, '°C')}；湿度 ${shown(humidity.min)}～${shown(humidity.max, '%')}。`,
    `全日降水 ${shown(summary.precipitationTotalMm, ' mm')}（雨雪合计水当量）；最高逐小时降水概率 ${shown(probability.max, '%')}，不是全日降水概率。`,
    `是否下雨：${summary.rain.text}${intervalText ? ` 有雨信号时段：${intervalText}。` : ''}`,
    ...(missingValues ? ['部分字段缺失；范围仅按有效数据计算，缺失值未计为零。'] : []),
    `获取 ${localTime(now).replace('T', ' ')}；来源最新起报元数据 ${localTime(Date.parse(freshness.latestModelRunAt)).replace('T', ' ')}（不保证本次响应同批次）。`,
    `来源：ECMWF IFS / Open-Meteo https://open-meteo.com/ ；模型预报，非实测。时区 ${FORECAST_TIMEZONE}。`,
  ].join('\n');
  const hourlyText = hourly.map((p) => `${p.time.slice(11, 16)} ${shown(p.temperatureC, '°C')} ${shown(p.humidityPct, '%')} ${shown(p.precipitationMm, 'mm')} ${shown(p.precipitationProbabilityPct, '%')}`).join('\n');
  return { kind: 'weather', city: { ...place }, date, day, timezone: FORECAST_TIMEZONE, hourly, summary, text, hourlyText,
    source, fetchedAt: new Date(now).toISOString(), modelRunAt: null, freshness, warnings,
    temporalNote: '温湿度为行首时刻；降水量/概率对应 time 至 periodEnd。降水为雨雪合计，不等于雨量。' };
}
