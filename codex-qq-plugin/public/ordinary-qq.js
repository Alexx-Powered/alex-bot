function createOrdinaryQQPanel(api) {
  const stateText = document.getElementById('ordinaryState');
  const services = document.getElementById('ordinaryServices');
  const refresh = document.getElementById('ordinaryRefresh');
  const login = document.getElementById('ordinaryLogin');
  const figure = document.getElementById('ordinaryScan');
  const canvas = document.getElementById('ordinaryQr');
  const labels = {
    online:'已在线，NoneBot 已从 Milky 读到当前账号的群列表。',
    offline:'普通 QQ 未连接。可以检查服务状态，或重新登录。',
    verifying:'正在等待 NoneBot 确认当前账号的群列表…',
    starting:'正在启动登录，等待 ECS 返回二维码或恢复已有会话…',
    waiting_scan:'等待手机扫码确认。',
    expired:'本次登录已超时。点击「重新登录」可重新检查会话并获取新码。',
    failed:'QQ 登录验证失败。请检查手机上的提示后重试。',
    unavailable:'暂时无法读取 ECS 状态。请稍后点击「检查状态」。'
  };
  const unitNames = {active:'运行中', inactive:'已停止', failed:'失败', activating:'启动中',
    deactivating:'停止中', reloading:'重新加载中', unknown:'未知'};
  let visible = false, sequence = 0, timer, expiry, pixels, busy = false;

  function hideQr() {
    clearTimeout(expiry);
    figure.classList.add('hidden');
    canvas.width = 0;
    pixels = null;
  }
  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }
  async function update(start = false) {
    if (!visible || document.hidden || busy) return;
    const id = ++sequence;
    const requested = performance.now();
    clearTimeout(timer);
    busy = true;
    refresh.disabled = login.disabled = true;
    let interval = 20_000;
    if (start) { hideQr(); setText(stateText, '正在请求 ECS 重新登录…'); }
    try {
      const result = start ? await api('ordinary-qq/login/start', {}) : await api('ordinary-qq/status');
      if (id !== sequence) return;
      if (!result.ok || !Object.hasOwn(labels, result.state)) throw Error();
      const state = result.state, details = result.services;
      const pending = ['starting','waiting_scan','verifying'].includes(state);
      interval = pending ? 2500 : 20_000;
      setText(services, 'Yogurt ' + unitNames[details.yogurt] + ' · NoneBot ' + unitNames[details.nonebot]
        + ' · Milky 19437 ' + (details.listening ? '正在监听' : '未监听'));
      if (state === 'waiting_scan') {
        if (pixels !== result.png) {
          hideQr();
          const bytes = Uint8Array.from(atob(result.png), c => c.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([bytes], {type:'image/png'}));
          try {
            if (id !== sequence) return;
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            pixels = result.png;
          } finally { bitmap.close(); }
        }
        const remaining = result.remainingMs - (performance.now() - requested);
        if (!(remaining > 0)) { hideQr(); setText(stateText, labels.expired); return; }
        figure.classList.remove('hidden');
        clearTimeout(expiry);
        expiry = setTimeout(() => { hideQr(); setText(stateText, labels.expired); }, remaining);
      } else hideQr();
      setText(stateText, labels[state]);
      login.disabled = state === 'starting' || state === 'waiting_scan' || (state === 'verifying' && !!result.expiresAt);
    } catch {
      if (id !== sequence) return;
      hideQr();
      setText(services, '');
      setText(stateText, labels.unavailable);
    } finally {
      if (id === sequence) {
        busy = false;
        refresh.disabled = false;
        timer = setTimeout(update, interval);
      }
    }
  }
  function reset() {
    sequence++;
    clearTimeout(timer);
    hideQr();
    busy = false;
    if (visible && !document.hidden) update();
  }
  login.addEventListener('click', () => {
    if (window.confirm('重新登录会短暂断开普通 QQ。继续吗？')) update(true);
  });
  refresh.addEventListener('click', () => update());
  document.addEventListener('visibilitychange', reset);
  window.addEventListener('pagehide', () => { visible = false; reset(); });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { visible = !document.getElementById('panel-connection').classList.contains('hidden'); reset(); }
  });
  return {show(active) { visible = active; reset(); }};
}
