import { initData } from './tg.js';

// In local dev (outside Telegram) you can set these in the console:
//   localStorage.debugUserId = '210408407'
// and the backend must run with AUTH_DEV_BYPASS=true.
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const id = initData();
  if (id) {
    h['x-telegram-init-data'] = id;
  } else if (localStorage.getItem('debugUserId')) {
    h['x-debug-user-id'] = localStorage.getItem('debugUserId')!;
    const u = localStorage.getItem('debugUsername');
    if (u) h['x-debug-username'] = u;
  }
  return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body),
};
