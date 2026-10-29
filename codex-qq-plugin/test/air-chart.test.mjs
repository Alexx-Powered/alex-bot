import test from 'node:test';
import assert from 'node:assert/strict';
import { loadImage } from '@napi-rs/canvas';
import { prepareAirChart, renderAirChart } from '../src/air-chart.mjs';

const START = Date.parse('2026-10-28T10:00:00Z'), HOUR = 3_600_000;
const SHANGHAI = { id: 'geonames-1796236', name: '上海', latitude: 31.2304, longitude: 121.4737 };
const SHENZHEN = { id: 'geonames-1795565', name: '深圳', latitude: 22.5431, longitude: 114.0579 };
const CHAOYANG = { id: 'geonames-2038154', name: '辽宁省朝阳市', latitude: 41.5739, longitude: 120.4506 };
const LONG_PLACE = { id: 'geonames-1529565', name: '新疆维吾尔自治区伊犁哈萨克自治州察布查尔锡伯自治县', latitude: 43.8381, longitude: 81.1497 };
function forecast(city = SHANGHAI) {
  return { city, timezone: 'Asia/Shanghai', hourly: Array.from({ length: 48 }, (_, i) => ({ time: new Date(START + i * HOUR).toISOString(), pm25: 20 + i })) };
}

test('standalone CAMS chart uses the supplied dynamic place and displays Beijing local time', () => {
  for (const place of [SHANGHAI, SHENZHEN, CHAOYANG]) {
    const model = prepareAirChart(forecast(place));
    assert.equal(model.city.id, place.id); assert.equal(model.city.name, place.name);
    assert.equal(model.labels[0], '10-28 18:00'); assert.equal(model.labels[47], '10-30 17:00');
    assert.equal(model.values[0], 20);
  }
});

test('standalone chart retains zero and breaks missing or invalid concentration hours', () => {
  const data = forecast();
  data.hourly[0].pm25 = 0; data.hourly[1].pm25 = null; data.hourly[2].pm25 = -1; data.hourly[3].pm25 = '0';
  data.hourly.splice(4, 1);
  const model = prepareAirChart(data);
  assert.equal(model.values.length, 48);
  assert.deepEqual(model.values.slice(0, 6), [0, null, null, null, null, 25]);
});

test('invalid location, timezone, time order and entirely missing data fail explicitly', () => {
  const data = forecast();
  assert.throws(() => prepareAirChart({ ...data, city: undefined }), /CHART_CITY_INVALID/);
  assert.throws(() => prepareAirChart({ ...data, city: { ...SHANGHAI, longitude: 500 } }), /CHART_CITY_INVALID/);
  assert.throws(() => prepareAirChart({ ...data, timezone: 'UTC' }), /CHART_TIMEZONE_INVALID/);
  assert.throws(() => prepareAirChart({ ...data, hourly: data.hourly.toReversed() }), /CHART_TIME_INVALID/);
  assert.throws(() => prepareAirChart({ ...data, hourly: [{ time: 'invalid', pm25: 20 }, data.hourly[1]] }), /CHART_TIME_INVALID/);
  assert.throws(() => prepareAirChart({ ...data, hourly: data.hourly.map(point => ({ ...point, pm25: null })) }), /CHART_DATA_MISSING/);
});

test('dynamic and long administrative names render real 1200x640 PNGs with partial gaps', async () => {
  for (const place of [SHANGHAI, SHENZHEN, CHAOYANG, LONG_PLACE]) {
    const data = forecast(place); data.hourly[10].pm25 = null;
    const rendered = renderAirChart(data), image = await loadImage(rendered.buffer);
    assert.equal(rendered.mimeType, 'image/png'); assert.ok(rendered.buffer.length < 5 * 1024 * 1024);
    assert.equal(image.width, 1200); assert.equal(image.height, 640);
  }
});
