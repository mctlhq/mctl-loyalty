import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { expireStaleRedemptions } from './services/ledger.js';

const app = createApp();

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
