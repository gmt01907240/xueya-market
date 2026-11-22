const TOKEN_KEY = 'xueya_token';
export const bus = new EventTarget();

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY) || ''; },
  setToken(token) { localStorage.setItem(TOKEN_KEY, token); },
  clear() { localStorage.removeItem(TOKEN_KEY); }
};

const DEFAULT_TIMEOUT = 15000;
let routeSignal = null;

/** 由路由在切换时注入取消信号，避免旧页面请求返回后覆盖新页面 */
export function setRouteSignal(signal) {
  routeSignal = signal;
  // 旧路由的在途 GET 已被取消，不能把它们的 Promise 复用到新页面
  inflight.clear();
}

/** 将外部取消信号与超时合并为一个 signal，并支持区分是否由超时触发 */
function createSignal(external, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    }
  };
}

async function send(method, path, body, opts = {}) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const external = opts.signal !== undefined ? opts.signal : routeSignal;
  const composed = createSignal(external, opts.timeout ?? DEFAULT_TIMEOUT);
  try {
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload, signal: composed.signal });
    } catch (err) {
      if (composed.timedOut()) throw new Error('请求超时，请稍后重试');
      if (err.name === 'AbortError') throw err;
      throw new Error('网络连接失败，请检查服务是否启动');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401 && auth.token) {
        auth.clear();
        bus.dispatchEvent(new Event('session-expired'));
      }
      const err = new Error((data && data.error) || `请求失败（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (composed.timedOut() && !(err instanceof Error && err.status)) {
      throw new Error('请求超时，请稍后重试');
    }
    throw err;
  } finally {
    composed.dispose();
  }
}

const inflight = new Map();

/** GET 请求在途去重：同一路径在返回前复用同一个 Promise，减少重复请求 */
function request(method, path, body, opts = {}) {
  if (method !== 'GET' || opts.noDedupe) return send(method, path, body, opts);
  const key = `${path} ${auth.token}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = send(method, path, body, opts).finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

export const api = {
  get: (path, opts) => request('GET', path, undefined, opts),
  post: (path, body) => request('POST', path, body || {}),
  patch: (path, body) => request('PATCH', path, body || {}),
  del: (path) => request('DELETE', path)
};

export async function downloadFile(materialId) {
  const res = await fetch(`/api/materials/${materialId}/download`, {
    headers: auth.token ? { Authorization: `Bearer ${auth.token}` } : {}
  });
  if (!res.ok) {
    let message = '下载失败';
    try { const data = await res.json(); if (data.error) message = data.error; } catch { /* ignore */ }
    throw new Error(message);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  let filename = '学涯集市资料';
  const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (match) {
    try { filename = decodeURIComponent(match[1]); } catch { /* ignore */ }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
