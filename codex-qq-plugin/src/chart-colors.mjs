// Fixed absolute-temperature display scale; these are not weather-warning levels.
export const TEMPERATURE_STOPS = Object.freeze([
  { value: -10, color: '#285bb5' }, { value: 0, color: '#258bc0' },
  { value: 10, color: '#169eaa' }, { value: 20, color: '#e4a03b' },
  { value: 30, color: '#e4652b' }, { value: 40, color: '#c62c39' },
]);

const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
const hex = channels => '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
export function temperatureColor(value) {
  if (!Number.isFinite(value)) return '#66768a';
  if (value <= TEMPERATURE_STOPS[0].value) return TEMPERATURE_STOPS[0].color;
  for (let i = 1; i < TEMPERATURE_STOPS.length; i++) {
    const lower = TEMPERATURE_STOPS[i - 1], upper = TEMPERATURE_STOPS[i];
    if (value <= upper.value) {
      const fraction = (value - lower.value) / (upper.value - lower.value);
      const start = rgb(lower.color), end = rgb(upper.color);
      return hex(start.map((channel, index) => channel + (end[index] - channel) * fraction));
    }
  }
  return TEMPERATURE_STOPS.at(-1).color;
}
// Text is a solid color derived from the point's temperature, never a canvas gradient.
export function temperatureTextColor(value) {
  return hex(rgb(temperatureColor(value)).map(channel => channel * 0.77));
}

// HJ 633—2026, table 3 and annex A; effective 2026-03-01.
// https://www.mee.gov.cn/ywgz/fgbz/bz/bzwb/jcffbz/202602/W020260225366493492011.pdf
// Only PM2.5 concentration breaks are used. No composite AQI is calculated.
export const PM25_BANDS = Object.freeze([
  { upper: 35, label: '0–35', color: '#00e400', lineColor: '#159a30' },
  { upper: 60, label: '>35–60', color: '#ffff00', lineColor: '#b59d00' },
  { upper: 115, label: '>60–115', color: '#ff7e00', lineColor: '#e56c00' },
  { upper: 150, label: '>115–150', color: '#ff0000', lineColor: '#dc242b' },
  { upper: 250, label: '>150–250', color: '#99004c', lineColor: '#99004c' },
  { upper: Infinity, label: '>250', color: '#7e0023', lineColor: '#7e0023' },
]);
export function pm25Band(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return PM25_BANDS.find(band => value <= band.upper);
}
