// Public CAMS forecast access through Open-Meteo, not an observation service.
// https://open-meteo.com/en/docs/air-quality-api
// Direct ADS downloads require an ECMWF account, token and accepted data terms:
// https://ads.atmosphere.copernicus.eu/how-to-api
import { CITIES, FORECAST_TIMEZONE, HOUR_MS, ForecastDataError, forecastNow, forecastDate, localDate, localIso, localTime,
  finiteValue, fetchForecastJson, validateModelMetadata, hourlyIndex } from './weather.mjs';
import { validatePlace } from './locations.mjs';

const ENDPOINT = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const PM25_FORECAST_HOURS = 48;

export async function getAirQuality({ partialWindow = false, city, place: resolvedPlace, window = 'rolling', day='today', now: nowInput = Date.now(), fetchImpl = globalThis.fetch, scheduledMorning = false, fetchTimeoutMs = 45_000 } = {}) {
  const cityKey=city===undefined?'beijing':city;
  const place = resolvedPlace === undefined ? (typeof cityKey === 'string' && Object.hasOwn(CITIES, cityKey) ? CITIES[cityKey] : null) : validatePlace(resolvedPlace);
  if (!place) throw new ForecastDataError('AIR_CITY_UNSUPPORTED');
  if (resolvedPlace !== undefined && city !== undefined && city !== place.id) throw new ForecastDataError('AIR_CITY_MISMATCH');
  if (!['rolling', 'calendar'].includes(window)) throw new ForecastDataError('AIR_WINDOW_UNSUPPORTED');
  if(window==='rolling'&&day!=='today')throw new ForecastDataError('AIR_DAY_UNSUPPORTED');
  const now = forecastNow(nowInput);
  const start = window === 'calendar' ? Date.parse(`${forecastDate(day,now,'AIR_DAY_UNSUPPORTED')}T00:00:00+08:00`) : Math.floor(now / HOUR_MS) * HOUR_MS;
  const end = start + (PM25_FORECAST_HOURS - 1) * HOUR_MS;
  const europe = place.longitude >= -24.95 && place.longitude <= 44.95 && place.latitude >= 30.05 && place.latitude <= 71.95;
  const domain = europe ? 'cams_europe' : 'cams_global';
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({ latitude: String(place.latitude), longitude: String(place.longitude),
    hourly: 'pm2_5', domains: domain, timezone: FORECAST_TIMEZONE,
    ...(window === 'calendar' ? { start_date: localDate(start), end_date: localDate(end) }
      : { forecast_hours: String(PM25_FORECAST_HOURS) }) }).toString();
  const request=address=>fetchForecastJson(address,{fetchImpl,now,timeoutMs:scheduledMorning?fetchTimeoutMs:15_000});
  const getMeta=()=>request(`https://air-quality-api.open-meteo.com/data/${domain}/static/meta.json`);
  const validate=meta=>validateModelMetadata(meta.data,{now,requiredEnd:partialWindow?now:end,maxRunAgeHours:europe?48:36});
  let forecast,freshness;
  if(partialWindow){
    freshness=validate(await getMeta());
    if(freshness.dataEndTime<=start)throw new ForecastDataError('FORECAST_OUTSIDE_WINDOW');
    url.searchParams.set('end_date',localDate(Math.min(end,freshness.dataEndTime)));
    forecast=await request(url.href);
  }else{
    const [data,meta]=await Promise.all([request(url.href),getMeta()]);
    forecast=data;freshness=validate(meta);
  }
  const index = hourlyIndex(forecast.data, { pm2_5: 'μg/m³' });
  const hourly = [];
  for (let hour = 0; hour < PM25_FORECAST_HOURS; ++hour) {
    const stamp = start + hour * HOUR_MS;
    const position = !partialWindow||stamp<freshness.dataEndTime?index.get(stamp):undefined;
    if (!partialWindow && position === undefined) throw new ForecastDataError('FORECAST_COVERAGE_INCOMPLETE');
    hourly.push({ time: localIso(stamp), pm25: finiteValue(forecast.data.hourly.pm2_5[position], 0, 5000) });
  }
  const valid = hourly.filter((p) => p.pm25 !== null);
  if(partialWindow&&!valid.length)throw new ForecastDataError('FORECAST_OUTSIDE_WINDOW');
  if (!partialWindow && valid.length < 24) throw new ForecastDataError('FORECAST_DATA_MISSING');
  const peak = valid.reduce((a, b) => a.pm25 >= b.pm25 ? a : b);
  const summary = { minPm25: Math.min(...valid.map((p) => p.pm25)), maxPm25: peak.pm25,
    // Never represent a partial-series average as a complete 48-hour mean.
    meanPm25: valid.length === hourly.length ? Math.round(valid.reduce((sum, p) => sum + p.pm25, 0) / valid.length * 10) / 10 : null,
    peakTime: peak.time, validHours: valid.length, missingHours: hourly.length - valid.length };
  const warnings = ['MODEL_RUN_NOT_BOUND_TO_RESPONSE', 'MODEL_GRID_NOT_STATION', ...(europe ? [] : ['HOURLY_INTERPOLATED']),
    ...(summary.missingHours ? ['MISSING_VALUES'] : []), ...(freshness.recentUpdate ? ['MODEL_UPDATE_PROPAGATING'] : [])];
  const source = { name: `CAMS / ECMWF ${europe ? '欧洲' : '全球'}空气质量预报，经 Open-Meteo 提供`, provider: 'Open-Meteo', model: domain,
    type: 'model_forecast', attribution: 'Copernicus Atmosphere Monitoring Service (CAMS) / ECMWF / Open-Meteo',
    spatialResolutionKm: europe ? 11 : 45, nativeTemporalResolutionHours: europe ? 1 : 3, outputTemporalResolutionHours: 1,
    documentation: 'https://open-meteo.com/en/docs/air-quality-api',
    officialDataset: europe ? 'https://ads.atmosphere.copernicus.eu/datasets/cams-europe-air-quality-forecasts' : 'https://ads.atmosphere.copernicus.eu/datasets/cams-global-atmospheric-composition-forecasts',
    metadataDocumentation: 'https://open-meteo.com/en/docs/model-updates', url: url.href };
  const text = [
    `${place.name} PM2.5 模型预报（非实测）`,
    `${localTime(start).replace('T', ' ')} 至 ${localTime(end).replace('T', ' ')}，时区 ${FORECAST_TIMEZONE}。`,
    `${summary.missingHours ? '有效数据' : window === 'calendar' ? day==='tomorrow'?'明后两天':'今明两天' : '未来48小时'}范围 ${summary.minPm25.toFixed(1)}～${summary.maxPm25.toFixed(1)} μg/m³；峰值时刻 ${summary.peakTime.slice(5, 16).replace('T', ' ')}。`,
    ...(summary.missingHours ? [`缺 ${summary.missingHours} 个小时；曲线应断开，缺失不能画成零。`] : []),
    `获取 ${localTime(now).replace('T', ' ')}；来源最新起报元数据 ${localTime(Date.parse(freshness.latestModelRunAt)).replace('T', ' ')}（不保证本次响应同批次）。`,
    '来源：CAMS / ECMWF，经 Open-Meteo 提供。',
    '这是近地面颗粒物浓度预报，不是站点实测、AQI或能见度预报，不能单凭此判断是否有雾。',
  ].join('\n');
  return { kind: 'air-quality', city: { ...place }, timezone: FORECAST_TIMEZONE, unit: 'μg/m³',
    title: `${place.name} PM2.5 模型预报（非实测）`, hourly, summary, text, source,
    fetchedAt: new Date(now).toISOString(), modelRunAt: null, freshness, warnings };
}

// Keep existing callers pinned to Beijing even if they supply a city option.
export function getBeijingAirQuality(options = {}) {
  return getAirQuality({ ...options, place: undefined, city: 'beijing' });
}
