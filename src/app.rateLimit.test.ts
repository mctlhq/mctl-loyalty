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
