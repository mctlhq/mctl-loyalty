// Rate limiting on the /api route group: the (N+1)th request gets 429, the
// per-user limiter is keyed by user id (not IP), and probes / metrics / static
// assets are never limited. Needs no Postgres: the IP limiter sits before
// requireAuth, and the user limiter is exercised on a bare app with a stubbed
// auth context.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createApp } from './app.js';
import { setCtx } from './middleware/auth.js';
import { createApiLimiters } from './middleware/rateLimit.js';

const servers: Server[] = [];
const tmp = mkdtempSync(join(tmpdir(), 'loyalty-ratelimit-'));
writeFileSync(join(tmp, 'index.html'), 'landing');
writeFileSync(join(tmp, 'asset.js'), 'x');

after(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('IP limiter: the (N+1)th /api request gets 429; probes and static are never limited', async () => {
  const N = 3;
  const base = await listen(
    createApp({ publicDir: tmp, rateLimit: { windowMs: 60_000, ipMax: N, userMax: 1000 } }),
  );
  for (let i = 0; i < N; i++) {
    assert.equal((await fetch(base + '/api/me')).status, 401, `request ${i + 1}`);
  }
  const limited = await fetch(base + '/api/me');
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: 'too many requests' });

  // Other /api paths share the same IP budget.
  assert.equal((await fetch(base + '/api/admin/merchants')).status, 429);

  // Never limited, however many times they are hit.
  for (let i = 0; i < N * 3; i++) {
    assert.equal((await fetch(base + '/healthz')).status, 200, 'healthz');
    assert.equal((await fetch(base + '/metrics')).status, 200, 'metrics');
    assert.equal((await fetch(base + '/')).status, 200, 'landing');
    assert.equal((await fetch(base + '/asset.js')).status, 200, 'static asset');
  }
});

test('user limiter is keyed by user id, not by IP', async () => {
  const N = 2;
  const { userLimiter } = createApiLimiters({ windowMs: 60_000, userMax: N });
  const app = express();
  app.use((req, _res, next) => {
    const id = Number(req.header('x-test-user'));
    setCtx(req, { userId: id, telegramId: id, username: null, superAdmin: false });
    next();
  });
  app.use(userLimiter);
  app.get('/', (_req, res) => void res.json({ ok: true }));
  const base = await listen(app);
  const as = (id: number) => fetch(base, { headers: { 'x-test-user': String(id) } });

  for (let i = 0; i < N; i++) assert.equal((await as(1)).status, 200);
  assert.equal((await as(1)).status, 429, 'user 1 over budget');
  // Same IP, different user: own budget.
  assert.equal((await as(2)).status, 200, 'user 2 unaffected');
});

// ---- CF-Connecting-IP keying (TRUST_CF_CONNECTING_IP) ----
// Every request below shares one socket address and one X-Forwarded-For, like
// traffic behind Traefik that rewrote XFF to a Cloudflare edge node.
const edge = { 'x-forwarded-for': '172.70.0.1' };

async function cfApp(trustCf: boolean, ipMax = 2): Promise<(cf?: string | string[]) => Promise<number>> {
  const base = await listen(
    createApp({
      publicDir: tmp,
      rateLimit: { windowMs: 60_000, ipMax, userMax: 1000, trustCfConnectingIp: trustCf },
    }),
  );
  return async (cf) => {
    const headers = new Headers(edge);
    if (Array.isArray(cf)) for (const v of cf) headers.append('cf-connecting-ip', v);
    else if (cf !== undefined) headers.set('cf-connecting-ip', cf);
    return (await fetch(base + '/api/me', { headers })).status;
  };
}

test('flag on: different CF-Connecting-IP values get separate buckets', async () => {
  const hit = await cfApp(true);
  assert.equal(await hit('203.0.113.1'), 401);
  assert.equal(await hit('203.0.113.1'), 401);
  assert.equal(await hit('203.0.113.1'), 429, 'client A over budget');
  assert.equal(await hit('203.0.113.2'), 401, 'client B has its own bucket');
  assert.equal(await hit('2001:db8:1:2::1'), 401, 'IPv6 client has its own bucket');
});

test('flag on: IPv6 clients in the same /56 share a bucket (ipKeyGenerator)', async () => {
  const hit = await cfApp(true, 1);
  assert.equal(await hit('2001:db8:aa:bb00::1'), 401);
  assert.equal(await hit('2001:db8:aa:bbff::9'), 429, 'same /56, same bucket');
});

test('flag off: CF-Connecting-IP is ignored, so spoofing it cannot rotate buckets', async () => {
  const hit = await cfApp(false);
  assert.equal(await hit('203.0.113.1'), 401);
  assert.equal(await hit('203.0.113.2'), 401);
  assert.equal(await hit('203.0.113.3'), 429, 'rotating the header does not reset the budget');
});

test('flag on: invalid or multi-value header falls back to req.ip', async () => {
  for (const bad of ['not-an-ip', '203.0.113.1, 203.0.113.2', '', ['203.0.113.1', '203.0.113.2']]) {
    const hit = await cfApp(true);
    assert.equal(await hit(bad), 401, `${JSON.stringify(bad)} 1`);
    assert.equal(await hit(bad), 401, `${JSON.stringify(bad)} 2`);
    assert.equal(await hit(bad), 429, `${JSON.stringify(bad)} falls back to the shared req.ip bucket`);
  }
  // Fallback bucket is the same as the no-header one.
  const hit = await cfApp(true);
  assert.equal(await hit(), 401);
  assert.equal(await hit('bogus'), 401);
  assert.equal(await hit('bogus2'), 429);
});

test('flag on: probes stay unlimited', async () => {
  const base = await listen(
    createApp({ publicDir: tmp, rateLimit: { windowMs: 60_000, ipMax: 1, userMax: 1, trustCfConnectingIp: true } }),
  );
  for (let i = 0; i < 6; i++) {
    const h = { 'cf-connecting-ip': '203.0.113.9' };
    assert.equal((await fetch(base + '/healthz', { headers: h })).status, 200);
    assert.equal((await fetch(base + '/metrics', { headers: h })).status, 200);
  }
});

test('user limiter IP fallback honours the flag', async () => {
  const mk = async (trustCf: boolean) => {
    const { userLimiter } = createApiLimiters({ windowMs: 60_000, userMax: 1, trustCfConnectingIp: trustCf });
    const app = express();
    app.use(userLimiter);
    app.get('/', (_req, res) => void res.json({ ok: true }));
    const base = await listen(app);
    return (ip: string) => fetch(base, { headers: { 'cf-connecting-ip': ip } }).then((r) => r.status);
  };
  const on = await mk(true);
  assert.equal(await on('203.0.113.1'), 200);
  assert.equal(await on('203.0.113.2'), 200, 'flag on: separate anonymous buckets');
  const off = await mk(false);
  assert.equal(await off('203.0.113.1'), 200);
  assert.equal(await off('203.0.113.2'), 429, 'flag off: header ignored');
});
