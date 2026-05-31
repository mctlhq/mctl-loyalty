import { Router } from 'express';
import { pool } from '../db/pool.js';
import { getCtx, requireSuperAdmin } from '../middleware/auth.js';
import { audit, LedgerError } from '../services/ledger.js';
import { addMember } from '../services/members.js';
import { createRule, deleteRule, listAllRules, updateRule } from '../services/rules.js';

export const adminRouter = Router();

adminRouter.use(requireSuperAdmin());

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
    const member = await addMember(mid, telegramId, role as 'admin' | 'scanner');
    await audit(ctx.userId, 'member.upsert', { merchantId: mid, targetType: 'user', targetId: member.user_id, meta: { telegram_id: telegramId, role } });
    res.json({ ok: true, merchant_id: mid, telegram_id: telegramId, role });
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Full cross-merchant rule list (globals + every merchant's own rules), with the
// owning merchant's name labeled. Super-admin only (router-level guard).
adminRouter.get('/rules', async (_req, res, next) => {
  try {
    const rules = await listAllRules();
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/rules', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    // Super-admin may target any scope: NULL = global, a number = that merchant.
    const merchantId = req.body?.merchant_id != null ? Number.parseInt(String(req.body.merchant_id), 10) : null;
    const { id } = await createRule(merchantId, {
      name: req.body?.name,
      kind: req.body?.kind,
      point_value: req.body?.point_value,
      rate: req.body?.rate,
      daily_limit: req.body?.daily_limit,
      active: req.body?.active,
    });
    await audit(ctx.userId, 'rule.create', { merchantId, targetType: 'rule', targetId: id, meta: { name: req.body?.name } });
    res.json({ id });
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// Update / delete ANY rule (globals or any merchant's). Unscoped — super-admin only.
adminRouter.patch('/rules/:rid', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const rid = Number.parseInt(req.params.rid!, 10);
    if (!Number.isFinite(rid)) {
      res.status(400).json({ error: 'bad rule id' });
      return;
    }
    await updateRule(rid, {
      name: req.body?.name,
      kind: req.body?.kind,
      point_value: req.body?.point_value,
      rate: req.body?.rate,
      daily_limit: req.body?.daily_limit,
      active: req.body?.active,
    });
    await audit(ctx.userId, 'rule.update', { targetType: 'rule', targetId: rid });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

adminRouter.delete('/rules/:rid', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const rid = Number.parseInt(req.params.rid!, 10);
    if (!Number.isFinite(rid)) {
      res.status(400).json({ error: 'bad rule id' });
      return;
    }
    await deleteRule(rid);
    await audit(ctx.userId, 'rule.delete', { targetType: 'rule', targetId: rid });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
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
