import { createHash } from 'node:crypto';
import { GROUP_FEATURES, MORNING_PART_FEATURES } from './group-features.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const visibleFeatures = new Set(GROUP_FEATURES.filter(item => !item.hidden).map(item => item.key));
const scopedErrors = new Set([
  'QQ_TARGET_PERMISSION_DENIED', 'QQ_SERVICE_UNAVAILABLE', 'PLATFORM_REJECTED', 'RATE_LIMITED', 'DELIVERY_UNCERTAIN',
]);

export const isGroupDeliveryError = code => scopedErrors.has(code);

export function morningDeliveryKey(date, part, groupKey) {
  const operation = hash('broadcast:group-morning-' + date + '-' + part);
  return hash('outgoing:broadcast:' + operation + ':' + groupKey);
}

// The receipt retains only bounded diagnostic fields. Previous releases ignore these additions.
export function groupReceiptFields(entry) {
  if (!/^[a-f0-9]{64}$/.test(entry.groupKey ?? '')) return {};
  const fields = {groupKey: entry.groupKey};
  if (visibleFeatures.has(entry.feature)) fields.feature = entry.feature;
  if (isGroupDeliveryError(entry.failureCode)) fields.failureCode = entry.failureCode;
  if (['upload','send'].includes(entry.phase)) fields.phase = entry.phase;
  if (Number.isSafeInteger(entry.bizCode) && entry.bizCode > 0) fields.bizCode = entry.bizCode;
  if (Number.isInteger(entry.httpStatus) && entry.httpStatus >= 100 && entry.httpStatus <= 599) fields.httpStatus = entry.httpStatus;
  return fields;
}

export function groupFailureHistory(deliveries, groupKey) {
  const entries = [];
  const legacyDays = new Map();
  for (let i = deliveries.length - 1; i >= 0 && entries.length < 30; i--) {
    const row = deliveries[i];
    if (!['rejected', 'uncertain'].includes(row.state)) continue;
    let feature = row.feature;
    if (row.groupKey) {
      if (row.groupKey !== groupKey) continue;
    } else {
      // Old morning receipts identify the exact group and part through their persisted delivery key.
      const date = new Date(row.at + 8 * 3600_000).toISOString().slice(0,10);
      if (!legacyDays.has(date)) {
        legacyDays.set(date, new Map(Object.entries(MORNING_PART_FEATURES).map(([part, name]) =>
          [morningDeliveryKey(date, part, groupKey), name])));
      }
      feature = legacyDays.get(date).get(row.key);
      if (!feature) continue;
    }
    const {phase, bizCode, httpStatus} = row;
    entries.push({at: row.at, state: row.state, code: row.failureCode ?? row.code,
      feature: feature ?? null, phase, bizCode, httpStatus});
  }
  return entries;
}
