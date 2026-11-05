import { AsyncLocalStorage } from 'node:async_hooks';
import {measureSpan} from './telemetry.mjs';

// Only acquire around a leaf operation. The morning and chat routers share a
// Python worker which may call back into another leaf while a request is open.
let busy = false;
const waiters = [];
const admission = new AsyncLocalStorage();
export const withHeavyWorkGuard = (stopReason, work) => admission.run(stopReason, work);
const busyError = () => Object.assign(Error('HEAVY_WORK_BUSY'),{code:'HEAVY_WORK_BUSY'});
export async function withHeavyWork(work) {
  if (busy) {
    if (waiters.length >= 16) throw busyError();
    await measureSpan('heavy_queue',()=>new Promise(resolve => waiters.push(resolve)));
  } else busy = true;
  try {
    const stop = admission.getStore()?.();
    if (stop) throw Object.assign(Error(stop), {code:stop});
    return await work();
  }
  finally {
    const next = waiters.shift();
    if (next) next();
    else busy = false;
  }
}
