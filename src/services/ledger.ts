import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db/pool.js';

/** Domain error mapped to an HTTP status by the route layer. */
export class LedgerError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

interface WalletRow {
  id: number;
  balance: number;
}

/** Lock + fetch the user's wallet row. Wallet is guaranteed to exist (created at auth). */
async function lockWallet(client: PoolClient, userId: number): Promise<WalletRow> {
  const { rows } = await client.query<WalletRow>(
    `SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  const w = rows[0];
  if (!w) throw new LedgerError(500, 'wallet missing');
  return w;
}

/** Stable 63-bit advisory-lock key for a (user, rule) pair. */
function accrualLockKey(userId: number, ruleId: number): bigint {
  // Combine into a single bigint; the modulo keeps it inside int8 range.
  return (BigInt(userId) * 1_000_003n + BigInt(ruleId)) % 9_223_372_036_854_775_783n;
}

export interface ScanResult {
  delta: number;
  balance: number;
  ruleName: string;
}

/**
 * Burn a QR token and credit the user via an accrual rule, atomically.
 * Enforces token single-use, expiry, and the rule's per-day limit at the DB level.
 */
export async function scanAndAccrue(params: {
  tokenHash: Buffer;
  ruleId: number;
  merchantId: number;
  scannerUserId: number;
}): Promise<{ result: ScanResult; targetTelegramId: number }> {
  return withTransaction(async (client) => {
    // 1. Burn the token (single-use, not expired) and learn the bearer.
    const burn = await client.query<{ user_id: number }>(
      `UPDATE qr_tokens
         SET used_at = now(), used_by_merchant_id = $2, used_by_user_id = $3
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [params.tokenHash, params.merchantId, params.scannerUserId],
    );
    const targetUserId = burn.rows[0]?.user_id;
    if (!targetUserId) throw new LedgerError(409, 'QR expired or already used');

    // 2. Resolve the rule (must be active and either global or this merchant's).
    const ruleRes = await client.query<{
      id: number;
      name: string;
      kind: string;
      point_value: number;
      daily_limit: number | null;
    }>(
      `SELECT id, name, kind, point_value, daily_limit
         FROM accrual_rules
        WHERE id = $1 AND active
          AND (merchant_id IS NULL OR merchant_id = $2)`,
      [params.ruleId, params.merchantId],
    );
    const rule = ruleRes.rows[0];
    if (!rule) throw new LedgerError(404, 'rule not found for this merchant');
    if (rule.kind !== 'fixed') throw new LedgerError(400, 'only fixed rules supported');
    const delta = rule.point_value;
    if (delta <= 0) throw new LedgerError(400, 'rule has no positive value');

    // 3. Serialize same (user,rule) accruals, then enforce the daily limit.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      accrualLockKey(targetUserId, rule.id).toString(),
    ]);
    if (rule.daily_limit !== null) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM accruals
          WHERE user_id = $1 AND rule_id = $2 AND accrual_date = current_date`,
        [targetUserId, rule.id],
      );
      if ((rows[0]?.n ?? 0) >= rule.daily_limit) {
        throw new LedgerError(429, 'daily limit reached for this rule');
      }
    }

    // 4. Credit the wallet + write the ledger + accrual rows.
    const wallet = await lockWallet(client, targetUserId);
    const txn = await client.query<{ id: number }>(
      `INSERT INTO transactions (wallet_id, user_id, merchant_id, delta, type, reason, rule_id, actor_user_id)
       VALUES ($1, $2, $3, $4, 'earn', $5, $6, $7) RETURNING id`,
      [wallet.id, targetUserId, params.merchantId, delta, rule.name, rule.id, params.scannerUserId],
    );
    await client.query(`UPDATE wallets SET balance = balance + $1, updated_at = now() WHERE id = $2`, [
      delta,
      wallet.id,
    ]);
    await client.query(
      `INSERT INTO accruals (user_id, rule_id, accrual_date, transaction_id)
       VALUES ($1, $2, current_date, $3)`,
      [targetUserId, rule.id, txn.rows[0]!.id],
    );

    const tg = await client.query<{ telegram_id: number }>(
      `SELECT telegram_id FROM users WHERE id = $1`,
      [targetUserId],
    );

    return {
      result: { delta, balance: wallet.balance + delta, ruleName: rule.name },
      targetTelegramId: tg.rows[0]!.telegram_id,
    };
  });
}

export interface RedeemResult {
  redemptionId: number;
  cost: number;
  balance: number;
  rewardTitle: string;
}

/** Spend points immediately and open a pending redemption. */
export async function redeem(userId: number, rewardId: number): Promise<RedeemResult> {
  return withTransaction(async (client) => {
    const rewardRes = await client.query<{
      id: number;
      title: string;
      cost: number;
      stock: number | null;
      merchant_id: number | null;
    }>(
      `SELECT id, title, cost, stock, merchant_id FROM rewards WHERE id = $1 AND active FOR UPDATE`,
      [rewardId],
    );
    const reward = rewardRes.rows[0];
    if (!reward) throw new LedgerError(404, 'reward not found');
    if (reward.stock !== null && reward.stock <= 0) throw new LedgerError(409, 'out of stock');

    const wallet = await lockWallet(client, userId);
    if (wallet.balance < reward.cost) throw new LedgerError(409, 'insufficient balance');

    const spend = await client.query<{ id: number }>(
      `INSERT INTO transactions (wallet_id, user_id, merchant_id, delta, type, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, 'spend', $5, $2) RETURNING id`,
      [wallet.id, userId, reward.merchant_id, -reward.cost, `redeem: ${reward.title}`],
    );
    await client.query(`UPDATE wallets SET balance = balance - $1, updated_at = now() WHERE id = $2`, [
      reward.cost,
      wallet.id,
    ]);
    if (reward.stock !== null) {
      await client.query(`UPDATE rewards SET stock = stock - 1 WHERE id = $1`, [reward.id]);
    }
    const red = await client.query<{ id: number }>(
      `INSERT INTO redemptions (user_id, reward_id, cost, status, merchant_id, spend_txn_id)
       VALUES ($1, $2, $3, 'pending', $4, $5) RETURNING id`,
      [userId, reward.id, reward.cost, reward.merchant_id, spend.rows[0]!.id],
    );
    await client.query(`UPDATE transactions SET redemption_id = $1 WHERE id = $2`, [
      red.rows[0]!.id,
      spend.rows[0]!.id,
    ]);

    return {
      redemptionId: red.rows[0]!.id,
      cost: reward.cost,
      balance: wallet.balance - reward.cost,
      rewardTitle: reward.title,
    };
  });
}

/** Mark a pending redemption fulfilled. Points were already spent at redeem time. */
export async function fulfillRedemption(redemptionId: number, actorUserId: number): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE redemptions SET status = 'fulfilled', actor_user_id = $2, updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [redemptionId, actorUserId],
    );
    if (res.rowCount === 0) throw new LedgerError(409, 'redemption not pending');
  });
}

/** Cancel a pending redemption: write a compensating reversal that credits the points back. */
export async function cancelRedemption(redemptionId: number, actorUserId: number): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query<{ user_id: number; cost: number; merchant_id: number | null }>(
      `SELECT user_id, cost, merchant_id FROM redemptions
        WHERE id = $1 AND status = 'pending' FOR UPDATE`,
      [redemptionId],
    );
    const red = res.rows[0];
    if (!red) throw new LedgerError(409, 'redemption not pending');

    const wallet = await lockWallet(client, red.user_id);
    const rev = await client.query<{ id: number }>(
      `INSERT INTO transactions (wallet_id, user_id, merchant_id, delta, type, reason, redemption_id, actor_user_id)
       VALUES ($1, $2, $3, $4, 'reversal', 'redemption cancelled', $5, $6) RETURNING id`,
      [wallet.id, red.user_id, red.merchant_id, red.cost, redemptionId, actorUserId],
    );
    await client.query(`UPDATE wallets SET balance = balance + $1, updated_at = now() WHERE id = $2`, [
      red.cost,
      wallet.id,
    ]);
    await client.query(
      `UPDATE redemptions SET status = 'cancelled', reversal_txn_id = $2, actor_user_id = $3, updated_at = now()
       WHERE id = $1`,
      [redemptionId, rev.rows[0]!.id, actorUserId],
    );
  });
}

/** Manual reversal of an arbitrary transaction (admin tool). */
export async function reverseTransaction(
  transactionId: number,
  reason: string,
  actorUserId: number,
): Promise<void> {
  await withTransaction(async (client) => {
    const res = await client.query<{ user_id: number; delta: number; merchant_id: number | null }>(
      `SELECT user_id, delta, merchant_id FROM transactions WHERE id = $1`,
      [transactionId],
    );
    const txn = res.rows[0];
    if (!txn) throw new LedgerError(404, 'transaction not found');

    const wallet = await lockWallet(client, txn.user_id);
    const newBalance = wallet.balance - txn.delta;
    if (newBalance < 0) throw new LedgerError(409, 'reversal would make balance negative');

    await client.query(
      `INSERT INTO transactions (wallet_id, user_id, merchant_id, delta, type, reason, actor_user_id)
       VALUES ($1, $2, $3, $4, 'reversal', $5, $6)`,
      [wallet.id, txn.user_id, txn.merchant_id, -txn.delta, reason || 'manual reversal', actorUserId],
    );
    await client.query(`UPDATE wallets SET balance = $1, updated_at = now() WHERE id = $2`, [
      newBalance,
      wallet.id,
    ]);
  });
}

export async function audit(
  actorUserId: number,
  action: string,
  opts: { merchantId?: number | null; targetType?: string; targetId?: number; meta?: unknown } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (actor_user_id, merchant_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      actorUserId,
      opts.merchantId ?? null,
      action,
      opts.targetType ?? null,
      opts.targetId ?? null,
      opts.meta === undefined ? null : JSON.stringify(opts.meta),
    ],
  );
}
