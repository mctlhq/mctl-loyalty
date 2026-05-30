import { Router } from 'express';
import { pool } from '../db/pool.js';
import { getCtx, requireSuperAdmin } from '../middleware/auth.js';
import { audit } from '../services/ledger.js';

export const adminRouter = Router();

adminRouter.use(requireSuperAdmin());

// Ensure a user row exists for a Telegram id (so staff can be added pre-signup).
async function ensureUser(telegramId: number): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (telegram_id) VALUES ($1)
     ON CONFLICT (telegram_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id
     RETURNING id`,
    [telegramId],
  );
  const userId = rows[0]!.id;
  await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  return userId;
}

adminRouter.get('/merchants', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, type, active, created_at FROM merchants ORDER BY id`);
    res.json({ merchants: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/merchants', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const name = String(req.body?.name ?? '').trim();
    const type = String(req.body?.type ?? 'shop');
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    if (!['shop', 'cafe', 'event', 'community'].includes(type)) {
      res.status(400).json({ error: 'invalid type' });
      return;
    }
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO merchants (name, type) VALUES ($1, $2) RETURNING id`,
      [name, type],
    );
    await audit(ctx.userId, 'merchant.create', { merchantId: rows[0]!.id, targetType: 'merchant', targetId: rows[0]!.id, meta: { name, type } });
    res.json({ id: rows[0]!.id, name, type });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/merchants/:mid/members', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const mid = Number.parseInt(req.params.mid!, 10);
    const telegramId = Number.parseInt(String(req.body?.telegram_id ?? ''), 10);
    const role = String(req.body?.role ?? 'scanner');
    if (!Number.isFinite(mid) || !Number.isFinite(telegramId)) {
      res.status(400).json({ error: 'merchant id and telegram_id required' });
      return;
    }
    if (!['admin', 'scanner'].includes(role)) {
      res.status(400).json({ error: 'invalid role' });
      return;
    }
    const merchant = await pool.query(`SELECT 1 FROM merchants WHERE id = $1`, [mid]);
    if (merchant.rowCount === 0) {
      res.status(404).json({ error: 'merchant not found' });
      return;
    }
    const userId = await ensureUser(telegramId);
    await pool.query(
      `INSERT INTO merchant_members (merchant_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (merchant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [mid, userId, role],
    );
    await audit(ctx.userId, 'member.upsert', { merchantId: mid, targetType: 'user', targetId: userId, meta: { telegram_id: telegramId, role } });
    res.json({ ok: true, merchant_id: mid, telegram_id: telegramId, role });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/rules', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const merchantId = req.body?.merchant_id != null ? Number.parseInt(String(req.body.merchant_id), 10) : null;
    const name = String(req.body?.name ?? '').trim();
    const kind = String(req.body?.kind ?? 'fixed');
    const pointValue = Number.parseInt(String(req.body?.point_value ?? '0'), 10) || 0;
    const rate = req.body?.rate != null ? Number(req.body.rate) : null;
    const dailyLimit = req.body?.daily_limit != null ? Number.parseInt(String(req.body.daily_limit), 10) : null;
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    if (!['fixed', 'amount'].includes(kind)) {
      res.status(400).json({ error: 'invalid kind' });
      return;
    }
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO accrual_rules (merchant_id, name, kind, point_value, rate, daily_limit)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [merchantId, name, kind, pointValue, rate, dailyLimit],
    );
    await audit(ctx.userId, 'rule.create', { merchantId, targetType: 'rule', targetId: rows[0]!.id, meta: { name, kind, pointValue, dailyLimit } });
    res.json({ id: rows[0]!.id });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/rewards', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const merchantId = req.body?.merchant_id != null ? Number.parseInt(String(req.body.merchant_id), 10) : null;
    const title = String(req.body?.title ?? '').trim();
    const description = req.body?.description != null ? String(req.body.description) : null;
    const cost = Number.parseInt(String(req.body?.cost ?? ''), 10);
    const stock = req.body?.stock != null ? Number.parseInt(String(req.body.stock), 10) : null;
    if (!title || !Number.isFinite(cost) || cost <= 0) {
      res.status(400).json({ error: 'title and positive cost required' });
      return;
    }
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO rewards (merchant_id, title, description, cost, stock)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [merchantId, title, description, cost, stock],
    );
    await audit(ctx.userId, 'reward.create', { merchantId, targetType: 'reward', targetId: rows[0]!.id, meta: { title, cost } });
    res.json({ id: rows[0]!.id });
  } catch (err) {
    next(err);
  }
});
