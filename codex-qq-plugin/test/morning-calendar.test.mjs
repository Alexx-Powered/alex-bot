import test from 'node:test';
import assert from 'node:assert/strict';
import {morningPlan} from '../src/morning-calendar.mjs';
test('official holiday ranges choose Tianjin including holiday weekends; ordinary weekends stay Beijing',()=>{
  for(const date of ['2026-05-01','2026-05-03','2026-09-25','2026-10-07']){const p=morningPlan(Date.parse(date+'T08:00:00+08:00'));assert.equal(p.city,'tianjin');assert.equal(p.calendar.workday,false);}
  for(const date of ['2026-05-06','2026-10-24','2026-10-25'])assert.equal(morningPlan(Date.parse(date+'T08:00:00+08:00')).city,'beijing');
});
test('makeup workdays, Shanghai midnight and unannounced years are explicit',()=>{
  assert.equal(morningPlan(Date.parse('2026-05-09T08:00:00+08:00')).calendar.workday,true);
  assert.equal(morningPlan(Date.parse('2026-09-24T16:00:00Z')).city,'tianjin');
  const unknown=morningPlan(Date.parse('2027-05-01T08:00:00+08:00'));assert.equal(unknown.city,'beijing');assert.equal(unknown.calendar.known,false);assert.equal(unknown.calendar.workday,null);assert.ok(unknown.notes.length);
});
