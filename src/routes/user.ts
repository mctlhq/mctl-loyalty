import { Router } from 'express';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { getCtx } from '../middleware/auth.js';
import { mintToken } from '../qr/token.js';
import { LedgerError, redeem } from '../services/ledger.js';

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

// Global points history.
userRouter.get('/transactions', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const { rows } = await pool.query(
      `SELECT t.id, t.delta, t.type, t.reason, t.merchant_id, m.name AS merchant_name, t.created_at
         FROM transactions t
         LEFT JOIN merchants m ON m.id = t.merchant_id
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
