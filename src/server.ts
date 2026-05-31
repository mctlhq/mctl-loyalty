import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { requireAuth } from './middleware/auth.js';
import { expireStaleRedemptions } from './services/ledger.js';
import { adminRouter } from './routes/admin.js';
import { staffRouter } from './routes/staff.js';
import { userRouter } from './routes/user.js';

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---- liveness / readiness / metrics ----
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', version: config.serviceVersion });
});

app.get('/readyz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not-ready' });
  }
});

app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(
    [
      '# HELP mctl_loyalty_up Service is up.',
      '# TYPE mctl_loyalty_up gauge',
      'mctl_loyalty_up 1',
    ].join('\n') + '\n',
  );
});

// ---- API (all routes require Telegram auth) ----
const api = express.Router();
api.use(requireAuth());
api.use('/', userRouter);
api.use('/', staffRouter);
api.use('/admin', adminRouter);
app.use('/api', api);

// ---- static assets ----
// /public holds two builds: the Astro marketing landing at the root
// (index.html, /privacy, /terms, assets under /_astro) and the Vite Mini App
// SPA under /_miniapp (assets under /_miniapp/assets). express.static serves
// every real file (landing pages, /_astro/*, /_miniapp/*) including the
// landing's index.html at `/`.
app.use(express.static(PUBLIC_DIR));

// ---- Mini App SPA fallback ----
// Client-routed paths (/app, /admin, /docs) are not real files, so map them to
// the SPA's index.html. `/docs` is the single docs route (it was also /help —
// collapsed). The root `/` is intentionally NOT here — it is the Astro landing
// served by express.static above.
app.get(['/app', '/app/*', '/admin', '/admin/*', '/docs', '/docs/*'], (_req, res) => {
  res.sendFile(resolve(PUBLIC_DIR, '_miniapp', 'index.html'));
});

// legacy /help collapsed into /docs (0.7.0); redirect permanently so old bookmarks still work.
app.get(['/help', '/help/*'], (_req, res) => {
  res.redirect(301, '/docs');
});

// ---- catch-all ----
// Unknown paths fall through to the landing's 404 page (or home if absent).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET') return next();
  res.status(404).sendFile(resolve(PUBLIC_DIR, '404.html'), (err) => {
    if (err && !res.headersSent) res.redirect('/');
  });
});

// ---- error handler ----
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

// Reverse expired redemption holds, returning the reserved points. Idempotent
// and safe to run on every replica; logs and swallows errors so a transient DB
// blip never crashes the loop. Runs once on boot (re-sweeps rows that expired
// while the pod was down) and then on a fixed interval.
function sweepExpiredRedemptions(): void {
  expireStaleRedemptions()
    .then((n) => {
      if (n > 0) {
        // eslint-disable-next-line no-console
        console.log(`[sweeper] expired ${n} stale redemption(s)`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[sweeper] expireStaleRedemptions failed', err);
    });
}

async function main(): Promise<void> {
  if (config.databaseUrl) {
    await migrate();
    sweepExpiredRedemptions();
    setInterval(sweepExpiredRedemptions, 60_000);
  } else {
    // eslint-disable-next-line no-console
    console.warn('[startup] DATABASE_URL not set — skipping migrations (dev only)');
  }
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[startup] mctl-loyalty ${config.serviceVersion} listening on :${config.port} (env=${config.appEnv})`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[startup] fatal', err);
  process.exit(1);
});
