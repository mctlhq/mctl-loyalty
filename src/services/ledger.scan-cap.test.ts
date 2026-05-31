// Integration test for the per-(user, merchant, day) accrual cap.
//
// Proves the security property behind the per-merchant accrual rules work: the
// daily limit is enforced ACROSS all of a merchant's rules, so a merchant-admin
// cannot bypass it by creating a second rule (a different rule_id) and scanning
// the same customer again the same day.
//
// Requires a Postgres reachable via DATABASE_URL; skips otherwise (CI has no DB).
// Run locally with a throwaway DB, e.g.:
//   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pw --name loyalty-test-pg postgres:16
//   DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres DATABASE_SSL=false npm test
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { scanAndAccrue, LedgerError } from './ledger.js';
import { mintToken } from '../qr/token.js';

const hasDb = Boolean(process.env.DATABASE_URL);

// Close the shared pool exactly once, after all tests in this file — not inside a
// single test's finally, which would break any sibling test in the same process.
after(async () => {
  if (hasDb) await pool.end();
});

test(
  'two different rule_ids at one merchant cannot double-accrue a user the same day',
  { skip: hasDb ? false : 'DATABASE_URL not set' },
  async () => {
    await migrate();

    // Unique-ish ids so the test does not collide with existing data.
    const tgTarget = 9_000_000_000 + Math.floor((Date.now() % 1_000_000) * 1.3);
    const tgScanner = tgTarget + 1;

    const target = (
      await pool.query<{ id: number }>(
        `INSERT INTO users (telegram_id, username) VALUES ($1, 'cap-test-target') RETURNING id`,
        [tgTarget],
      )
    ).rows[0]!.id;
    const scanner = (
      await pool.query<{ id: number }>(
        `INSERT INTO users (telegram_id, username) VALUES ($1, 'cap-test-scanner') RETURNING id`,
        [tgScanner],
      )
    ).rows[0]!.id;
    await pool.query(`INSERT INTO wallets (user_id, balance) VALUES ($1, 0)`, [target]);

    const merchant = (
      await pool.query<{ id: number }>(
        `INSERT INTO merchants (name, type) VALUES ('Cap Test Cafe', 'cafe') RETURNING id`,
      )
    ).rows[0]!.id;

    // Two DISTINCT rules for the same merchant, each daily_limit = 1.
    const mkRule = async (name: string) =>
      (
        await pool.query<{ id: number }>(
          `INSERT INTO accrual_rules (merchant_id, name, kind, point_value, daily_limit, active)
           VALUES ($1, $2, 'fixed', 50, 1, TRUE) RETURNING id`,
          [merchant, name],
        )
      ).rows[0]!.id;
    const ruleA = await mkRule('Visit');
    const ruleB = await mkRule('Purchase');

    // Two fresh QR tokens for the same customer.
    const mkToken = async () => {
      const t = mintToken();
      await pool.query(
        `INSERT INTO qr_tokens (jti, token_hash, user_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [t.jti, t.tokenHash, target],
      );
      return t;
    };
    const tokenA = await mkToken();
    const tokenB = await mkToken();

    try {
      // First scan via rule A — succeeds and credits the configured points.
      const first = await scanAndAccrue({
        tokenHash: tokenA.tokenHash,
        ruleId: ruleA,
        merchantId: merchant,
        scannerUserId: scanner,
      });
      assert.equal(first.result.delta, 50);

      // Second scan the SAME day, SAME merchant, SAME customer, but a DIFFERENT
      // rule_id — must be rejected by the per-(user, merchant, day) cap.
      await assert.rejects(
        () =>
          scanAndAccrue({
            tokenHash: tokenB.tokenHash,
            ruleId: ruleB,
            merchantId: merchant,
            scannerUserId: scanner,
          }),
        (err: unknown) => err instanceof LedgerError && err.status === 429,
        'second rule_id must not bypass the daily cap',
      );

      // The blocked scan must not have credited anything beyond the first.
      const balance = (
        await pool.query<{ balance: number }>(`SELECT balance FROM wallets WHERE user_id = $1`, [
          target,
        ])
      ).rows[0]!.balance;
      assert.equal(balance, 50, 'balance reflects exactly one accrual');

      // The blocked token must NOT have been burned (the failed scan rolled back).
      const burned = (
        await pool.query<{ used_at: string | null }>(
          `SELECT used_at FROM qr_tokens WHERE jti = $1`,
          [tokenB.jti],
        )
      ).rows[0]!.used_at;
      assert.equal(burned, null, 'failed scan rolls back the QR-token burn');
    } finally {
      // Cleanup (cascades remove wallets, tokens, transactions, accruals, rules).
      // The pool is closed once in the after() hook above, not here.
      await pool.query(`DELETE FROM merchants WHERE id = $1`, [merchant]);
      await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[target, scanner]]);
    }
  },
);
