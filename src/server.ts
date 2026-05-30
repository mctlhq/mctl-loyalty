import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { requireAuth } from './middleware/auth.js';
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

// ---- static SPA ----
// One Vite build lives in /public; client-side routing handles /app and /admin.
app.use(express.static(PUBLIC_DIR, { index: false }));
app.get(['/', '/app', '/app/*', '/admin', '/admin/*'], (_req, res) => {
  res.sendFile(resolve(PUBLIC_DIR, 'index.html'));
});

// ---- error handler ----
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

async function main(): Promise<void> {
  if (config.databaseUrl) {
    await migrate();
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
