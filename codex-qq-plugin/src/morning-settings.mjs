import {createHash} from 'node:crypto';
import {validatePlace} from './locations.mjs';

export const defaultMorningTime='07:30';
export function validMorningInput(value) {
  return value && typeof value.time==='string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) &&
    typeof value.location==='string' && value.location.length<=60 && value.location.trim()===value.location;
}
export function validMorningSchedule(value) {
  if (!validMorningInput(value)) return false;
  if (!value.location) return value.place===null;
  try {validatePlace(value.place);return true;} catch {return false;}
}
export function morningScheduleKey(schedule) {
  if (!schedule || (schedule.time===defaultMorningTime && !schedule.place)) return null;
  const p=schedule.place;
  return createHash('sha256').update(JSON.stringify([schedule.time,p?.id,p?.latitude,p?.longitude,p?.name])).digest('hex');
}
