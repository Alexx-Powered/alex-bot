// Fetch public model data and render locally. Never connects to or sends QQ.
import { mkdir, writeFile } from 'node:fs/promises';
import { WeatherCommands } from '../src/weather-commands.mjs';
import { getWeatherBrief } from '../src/weather.mjs';
import { getAirQuality } from '../src/air-quality.mjs';
import { renderWeatherChart } from '../src/weather-chart.mjs';

let observed;
const weatherCommands=new WeatherCommands({weather:getWeatherBrief,air:getAirQuality,
  weatherChart:input=>{observed=input;return renderWeatherChart(input);}});
const report=await weatherCommands.briefing({cities:['guangzhou']});
if(observed.weather[0]?.city?.id!=='guangzhou'||observed.air?.city?.id!=='guangzhou') throw Error('GUANGZHOU_DATA_MISSING');
await mkdir(new URL('../test-output/',import.meta.url),{recursive:true});
await writeFile(new URL('../test-output/guangzhou-preview.png',import.meta.url),report.image.buffer);
const result={date:report.date,city:'guangzhou',
  weatherHours:observed.weather[0].hourly.length,airHours:observed.air.hourly.length,
  weatherCoordinates:{latitude:observed.weather[0].city.latitude,longitude:observed.weather[0].city.longitude},
  airCoordinates:{latitude:observed.air.city.latitude,longitude:observed.air.city.longitude},
  text:report.text,bytes:report.image.buffer.length,qqSent:false};
await writeFile(new URL('../test-output/guangzhou-live.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
