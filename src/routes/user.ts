import { Router } from 'express';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { getCtx } from '../middleware/auth.js';
import { mintToken } from '../qr/token.js';
import { cancelByUser, LedgerError, mintClaimToken, redeem } from '../services/ledger.js';

export const userRouter = Router();

// Current user + single global balance.
userRouter.get('/me', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const { rows } = await pool.query<{ balance: number }>(
      `SELECT balance FROM wallets WHERE user_id = $1`,
      [ctx.userId],
    );
    res.json({
      telegram_id: ctx.telegramId,
      username: ctx.username,
      super_admin: ctx.superAdmin,
      balance: rows[0]?.balance ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// Mint a fresh rotating QR token (client renders it as a QR and re-fetches ~30 s).
userRouter.get('/qr/current', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const { jti, token, tokenHash } = mintToken();
    await pool.query(
      `INSERT INTO qr_tokens (jti, token_hash, user_id, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)`,
      [jti, tokenHash, ctx.userId, String(config.qrTtlSeconds)],
    );
    res.json({ token, ttl_seconds: config.qrTtlSeconds });
  } catch (err) {
    next(err);
  }
});

// Global points history. Joins the redemption so the UI can phrase the
// lifecycle (reserved / fulfilled / cancelled / expired) per spend/reversal txn.
userRouter.get('/transactions', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const { rows } = await pool.query(
      `SELECT t.id, t.delta, t.type, t.reason, t.merchant_id, m.name AS merchant_name,
              r.status AS redemption_status, t.created_at
         FROM transactions t
         LEFT JOIN merchants m ON m.id = t.merchant_id
         LEFT JOIN redemptions r ON r.id = t.redemption_id
        WHERE t.user_id = $1
        ORDER BY t.created_at DESC
        LIMIT 100`,
      [ctx.userId],
    );
    res.json({ transactions: rows });
  } catch (err) {
    next(err);
  }
});

// The caller's own pending redemptions (the active points holds). Drives the
// redemption-QR cards at the top of the user view.
userRouter.get('/redemptions/mine', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const { rows } = await pool.query(
      `SELECT r.id, rw.title AS reward_title, r.cost, r.expires_at, r.claim_token_expires_at
         FROM redemptions r
         JOIN rewards rw ON rw.id = r.reward_id
        WHERE r.user_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at DESC`,
      [ctx.userId],
    );
    res.json({ redemptions: rows });
  } catch (err) {
    next(err);
  }
});

// Re-mint the claim token (redemption QR) for the caller's own pending
// redemption. Invalidates any previous QR. Returns the raw token once.
userRouter.post('/redemptions/:id/qr', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = Number.parseInt(req.params.id!, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad redemption id' });
      return;
    }
    const result = await mintClaimToken(id, ctx.userId);
    res.json(result);
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Owner-cancels their own pending redemption (points returned, stock restored).
// Mounted at /my-redemptions to avoid colliding with the staff cancel route.
userRouter.post('/my-redemptions/:id/cancel', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = Number.parseInt(req.params.id!, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad redemption id' });
      return;
    }
    await cancelByUser(id, ctx.userId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Active rewards catalog.
userRouter.get('/rewards', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, description, cost, stock, merchant_id
         FROM rewards WHERE active AND (stock IS NULL OR stock > 0)
        ORDER BY cost ASC`,
    );
    res.json({ rewards: rows });
  } catch (err) {
    next(err);
  }
});

// Public merchant lookup for any authenticated user. Used by the deep-link
// (`startapp=merchant_<id>`) to resolve a merchant's name for the context banner.
// Read-only; returns active merchants only. The `:mid`-scoped staff routes in
// staffRouter are multi-segment, so they don't collide with this single segment.
userRouter.get('/merchants/:id', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id!, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'bad merchant id' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT id, name, type FROM merchants WHERE id = $1 AND active`,
      [id],
    );
    if (!rows[0]) {
      res.status(404).json({ error: 'merchant not found' });
      return;
    }
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Redeem: spends points immediately and opens a pending redemption.
userRouter.post('/redeem', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const rewardId = Number.parseInt(String(req.body?.reward_id ?? ''), 10);
    if (!Number.isFinite(rewardId)) {
      res.status(400).json({ error: 'reward_id required' });
      return;
    }
    const result = await redeem(ctx.userId, rewardId);
    res.json(result);
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});
