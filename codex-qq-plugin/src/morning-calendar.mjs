import {readFileSync} from 'node:fs';
import {forecastNow,localDate} from './weather.mjs';
const calendar=JSON.parse(readFileSync(new URL('../data/holidays-cn.json',import.meta.url),'utf8'));
export function morningPlan(now=Date.now(),data=calendar){
  const stamp=forecastNow(now),date=localDate(stamp),year=data[date.slice(0,4)];
  const weekday=new Date(date+'T00:00:00Z').getUTCDay();
  const holiday=year?.holidays.find(item=>item.start<=date&&date<=item.end);
  const known=Boolean(year),workday=known?(!holiday&&(year.makeupWorkdays.includes(date)||(weekday!==0&&weekday!==6))):null;
  return {date,city:holiday?'tianjin':'beijing',cityName:holiday?'天津':'北京',calendar:{known,holiday:Boolean(holiday),holidayName:holiday?.name||null,workday,source:year?.source||null},notes:known?[]:['本年度官方放假日历未配置，暂用北京；不能确认节假日。']};
}
