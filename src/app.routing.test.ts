// HTTP routing + boot test: the Mini App SPA fallback, the legacy /help
// redirect, static assets, API mounts, the 404 page and the real entrypoint
// starting up. Needs no Postgres: no request gets past requireAuth, and the
// spawned server boots without DATABASE_URL. A route pattern the router rejects
// at registration (path-to-regexp 8 throws on a bare `*`) fails here instead of
// crash-looping the pod.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const SERVER_JS = fileURLToPath(new URL('./server.js', import.meta.url));

const SPA = '<!doctype html><title>mini app fixture</title>';
const LANDING = '<!doctype html><title>landing fixture</title>';
const PRIVACY = '<!doctype html><title>privacy fixture</title>';
const NOT_FOUND = '<!doctype html><title>404 fixture</title>';
const ASSET = 'console.log("asset fixture");';

let tmp: string | undefined;
const servers: Server[] = [];
let built = ''; // base URL of an app whose public/ holds the landing + Mini App builds
let unbuilt = ''; // base URL of an app whose public/ is empty

async function boot(publicDir: string): Promise<string> {
  const server = createApp({ publicDir }).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

before(async () => {
  // The public/ dirs sit under a dot-directory, as in a checkout under ~/.worktrees,
  // so serving must not depend on where the repo lives. The layout mirrors the
  // image: the Astro landing at the root, the Vite Mini App under _miniapp/.
  tmp = mkdtempSync(join(tmpdir(), 'loyalty-routing-'));
  const pub = join(tmp, '.checkout', 'public');
  const empty = join(tmp, '.checkout', 'empty');
  mkdirSync(join(pub, 'privacy'), { recursive: true });
  mkdirSync(join(pub, '_miniapp', 'assets'), { recursive: true });
  mkdirSync(empty, { recursive: true });
  writeFileSync(join(pub, 'index.html'), LANDING);
  writeFileSync(join(pub, '404.html'), NOT_FOUND);
  writeFileSync(join(pub, 'privacy', 'index.html'), PRIVACY);
  writeFileSync(join(pub, '_miniapp', 'index.html'), SPA);
  writeFileSync(join(pub, '_miniapp', 'assets', 'index-abc123.js'), ASSET);
  built = await boot(pub);
  unbuilt = await boot(empty);
});

after(() => {
  for (const s of servers) s.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const get = (base: string, path: string, init: RequestInit = {}) =>
  fetch(base + path, { redirect: 'manual', ...init });

test('SPA fallback serves the Mini App shell for client routes, bare and nested', async () => {
  const paths = [
    '/app',
    '/app/',
    '/app/x',
    '/app/x/y',
    '/app/x/y/',
    '/admin',
    '/admin/',
    '/admin/merchants',
    '/admin/merchants/42',
    '/docs',
    '/docs/',
    '/docs/y',
    '/docs/y/z',
    '/docs/y?tab=1',
    '/Docs/y', // routing is case-insensitive
  ];
  for (const path of paths) {
    const res = await get(built, path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/, path);
    assert.equal(await res.text(), SPA, path);
  }
});

test('legacy /help paths redirect permanently to /docs', async () => {
  for (const path of ['/help', '/help/', '/help/x', '/help/x/y', '/HELP']) {
    const res = await get(built, path);
    assert.equal(res.status, 301, path);
    assert.equal(res.headers.get('location'), '/docs', path);
  }
});

test('real static files are served by express.static, not the fallback', async () => {
  const asset = await get(built, '/_miniapp/assets/index-abc123.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.equal(await asset.text(), ASSET);

  const landing = await get(built, '/');
  assert.equal(landing.status, 200);
  assert.equal(await landing.text(), LANDING);

  const privacy = await get(built, '/privacy/');
  assert.equal(privacy.status, 200);
  assert.equal(await privacy.text(), PRIVACY);

  const bare = await get(built, '/privacy');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/privacy/');
});

test('API and health routes are not swallowed by the fallback', async () => {
  // /api/admin/* in particular must reach the authenticated API, not the /admin SPA route.
  for (const path of ['/api/me', '/api/merchants/1', '/api/admin/merchants', '/api/admin/merchants/42']) {
    const res = await get(built, path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: 'unauthorized' }, path);
  }

  const health = await get(built, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, 'ok');

  const metrics = await get(built, '/metrics');
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /^mctl_loyalty_up 1$/m);
});

test('paths that only share a prefix with a client route get the 404 page', async () => {
  const paths = [
    '/apps',
    '/apps/',
    '/appx/y',
    '/administrator',
    '/docsx',
    '/helpx',
    '/helper/x',
    '/nope',
    '/nope/x',
    '/_miniapp/assets/missing.js',
  ];
  for (const path of paths) {
    const res = await get(built, path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/, path);
    assert.equal(await res.text(), NOT_FOUND, path);
  }
});

test('non-GET requests to client routes get neither the SPA shell nor the redirect', async () => {
  for (const path of ['/app/x', '/docs/y', '/help']) {
    const res = await get(built, path, { method: 'POST' });
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('location'), null, path);
    assert.notEqual(await res.text(), SPA, path);
  }
});

test('unknown paths go home when the landing has no 404 page', async () => {
  const res = await get(unbuilt, '/nope');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
});

// ---- the real entrypoint (server.js) ----

// A listener on a free port. listen() without a host binds the same address the
// server does, so a server started on this port while it is held gets EADDRINUSE.
async function holdPort(): Promise<ReturnType<typeof createServer>> {
  const holder = createServer().listen(0);
  await once(holder, 'listening');
  return holder;
}

function startServer(port: number) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: { ...process.env, PORT: String(port), DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = once(child, 'exit').then(([code]) => code as number | null);
  return { child, exited, output: () => output };
}

test('server.js boots and answers /healthz', { timeout: 30_000 }, async (t) => {
  const holder = await holdPort();
  const { port } = holder.address() as AddressInfo;
  holder.close();
  await once(holder, 'close');

  const srv = startServer(port);
  t.after(() => srv.child.kill());
  for (;;) {
    assert.equal(srv.child.exitCode, null, `server exited early:\n${srv.output()}`);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    if (res?.status === 200) break;
    await sleep(100);
  }
});

test('server.js exits non-zero when its port is taken', { timeout: 30_000 }, async (t) => {
  const holder = await holdPort();
  t.after(() => holder.close());

  const srv = startServer((holder.address() as AddressInfo).port);
  t.after(() => srv.child.kill());
  assert.equal(await srv.exited, 1, srv.output());
  assert.match(srv.output(), /EADDRINUSE/);
});
