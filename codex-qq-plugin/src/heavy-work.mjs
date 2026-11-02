// Only acquire around a leaf operation. The morning and chat routers share a
// Python worker which may call back into another leaf while a request is open.
let busy = false;
const waiters = new Set();
const busyError = () => Object.assign(Error('HEAVY_WORK_BUSY'),{code:'HEAVY_WORK_BUSY'});
export async function withHeavyWork(work) {
  if (busy) {
    if (waiters.size >= 2) throw busyError();
    await new Promise((resolve,reject) => {
      const begin = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { waiters.delete(begin); reject(busyError()); },60_000);
      waiters.add(begin);
    });
  } else busy = true;
  try { return await work(); }
  finally {
    const [next] = waiters;
    if (next) { waiters.delete(next); next(); }
    else busy = false;
  }
}
