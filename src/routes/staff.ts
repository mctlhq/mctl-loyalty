import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { getCtx, requireMember } from '../middleware/auth.js';
import { hashToken } from '../qr/token.js';
import { notify } from '../telegram/bot.js';
import {
  audit,
  cancelRedemption,
  fulfillRedemption,
  LedgerError,
  reverseTransaction,
  scanAndAccrue,
} from '../services/ledger.js';
import { addMember, listMembers, removeMember } from '../services/members.js';

export const staffRouter = Router();

// Gate: caller is staff of at least one merchant, or a super-admin.
async function requireAnyStaff(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = getCtx(req);
    if (ctx.superAdmin) return next();
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM merchant_members WHERE user_id = $1`,
      [ctx.userId],
    );
    if ((rows[0]?.n ?? 0) === 0) {
      res.status(403).json({ error: 'staff only' });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

function sendLedgerError(res: Response, err: unknown, next: NextFunction): void {
  if (err instanceof LedgerError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  next(err);
}

// Merchants where the caller is staff (super-admins see all active merchants).
staffRouter.get('/staff/merchants', async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    if (ctx.superAdmin) {
      const { rows } = await pool.query(
        `SELECT id, name, type, 'admin' AS role FROM merchants WHERE active ORDER BY name`,
      );
      res.json({ merchants: rows });
      return;
    }
    const { rows } = await pool.query(
      `SELECT m.id, m.name, m.type, mm.role
         FROM merchant_members mm
         JOIN merchants m ON m.id = mm.merchant_id
        WHERE mm.user_id = $1 AND m.active
        ORDER BY m.name`,
      [ctx.userId],
    );
    res.json({ merchants: rows });
  } catch (err) {
    next(err);
  }
});

// Accrual rules available to a merchant (its own + global rules).
staffRouter.get('/merchants/:mid/rules', requireMember(['admin', 'scanner']), async (req, res, next) => {
  try {
    const mid = Number.parseInt(req.params.mid!, 10);
    const { rows } = await pool.query(
      `SELECT id, name, kind, point_value, daily_limit
         FROM accrual_rules
        WHERE active AND (merchant_id IS NULL OR merchant_id = $1)
        ORDER BY name`,
      [mid],
    );
    res.json({ rules: rows });
  } catch (err) {
    next(err);
  }
});

// --- Staff management (merchant-admins; super-admin bypasses requireMember) ---

staffRouter.get('/merchants/:mid/members', requireMember(['admin']), async (req, res, next) => {
  try {
    const members = await listMembers(Number.parseInt(req.params.mid!, 10));
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

staffRouter.post('/merchants/:mid/members', requireMember(['admin']), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const mid = Number.parseInt(req.params.mid!, 10);
    const telegramId = Number.parseInt(String(req.body?.telegram_id ?? ''), 10);
    // Merchant-admins may only add scanners; super-admins may set any role.
    let role = String(req.body?.role ?? 'scanner');
    if (!ctx.superAdmin) role = 'scanner';
    if (!Number.isFinite(telegramId)) {
      res.status(400).json({ error: 'telegram_id required' });
      return;
    }
    if (!['admin', 'scanner'].includes(role)) {
      res.status(400).json({ error: 'invalid role' });
      return;
    }
    const m = await addMember(mid, telegramId, role as 'admin' | 'scanner');
    await audit(ctx.userId, 'member.upsert', { merchantId: mid, targetType: 'user', targetId: m.user_id, meta: { telegram_id: telegramId, role } });
    res.json({ ok: true, ...m });
  } catch (err) {
    sendLedgerError(res, err, next);
  }
});

staffRouter.delete('/merchants/:mid/members/:userId', requireMember(['admin']), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const mid = Number.parseInt(req.params.mid!, 10);
    const userId = Number.parseInt(req.params.userId!, 10);
    if (!Number.isFinite(userId)) {
      res.status(400).json({ error: 'bad user id' });
      return;
    }
    await removeMember(mid, userId, !ctx.superAdmin); // merchant-admin: scanners only
    await audit(ctx.userId, 'member.remove', { merchantId: mid, targetType: 'user', targetId: userId });
    res.json({ ok: true });
  } catch (err) {
    sendLedgerError(res, err, next);
  }
});

// Scan a user's QR and apply an accrual rule.
staffRouter.post('/merchants/:mid/scan', requireMember(['admin', 'scanner']), async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const mid = Number.parseInt(req.params.mid!, 10);
    const token = String(req.body?.token ?? '');
    const ruleId = Number.parseInt(String(req.body?.rule_id ?? ''), 10);
    if (!token || !Number.isFinite(ruleId)) {
      res.status(400).json({ error: 'token and rule_id required' });
      return;
    }
    const { result, targetTelegramId } = await scanAndAccrue({
      tokenHash: hashToken(token),
      ruleId,
      merchantId: mid,
      scannerUserId: ctx.userId,
    });
    await audit(ctx.userId, 'scan', {
      merchantId: mid,
      targetType: 'user',
      meta: { rule_id: ruleId, delta: result.delta },
    });
    void notify(targetTelegramId, `+${result.delta} points (${result.ruleName}). Balance: ${result.balance}`);
    res.json(result);
  } catch (err) {
    sendLedgerError(res, err, next);
  }
});

// Pending/recent redemptions across the catalog (global single currency).
staffRouter.get('/redemptions', requireAnyStaff, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.status, r.cost, r.created_at, rw.title AS reward_title,
              u.telegram_id, u.username
         FROM redemptions r
         JOIN rewards rw ON rw.id = r.reward_id
         JOIN users u ON u.id = r.user_id
        ORDER BY (r.status = 'pending') DESC, r.created_at DESC
        LIMIT 100`,
    );
    res.json({ redemptions: rows });
  } catch (err) {
    next(err);
  }
});

staffRouter.post('/redemptions/:id/fulfill', requireAnyStaff, async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = Number.parseInt(req.params.id!, 10);
    await fulfillRedemption(id, ctx.userId);
    await audit(ctx.userId, 'redemption.fulfill', { targetType: 'redemption', targetId: id });
    res.json({ ok: true });
  } catch (err) {
    sendLedgerError(res, err, next);
  }
});

staffRouter.post('/redemptions/:id/cancel', requireAnyStaff, async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    const id = Number.parseInt(req.params.id!, 10);
    await cancelRedemption(id, ctx.userId);
    await audit(ctx.userId, 'redemption.cancel', { targetType: 'redemption', targetId: id });
    res.json({ ok: true });
  } catch (err) {
    sendLedgerError(res, err, next);
  }
});

// Manual reversal of a transaction (super-admin only — checked in route).
staffRouter.post('/reverse', requireAnyStaff, async (req, res, next) => {
  try {
    const ctx = getCtx(req);
    if (!ctx.superAdmin) {
      res.status(403).json({ error: 'super-admin only' });
      return;
    }
    const txnId = Number.parseInt(String(req.body?.transaction_id ?? ''), 10);
    const reason = String(req.body?.reason ?? '');
    if (!Number.isFinite(txnId)) {
      res.status(400).json({ error: 'transaction_id required' });
      return;
    }
    await reverseTransaction(txnId, reason, ctx.userId);
    await audit(ctx.userId, 'transaction.reverse', { targetType: 'transaction', targetId: txnId, meta: { reason } });
    res.json({ ok: true });
  } catch (err) {
    sendLedgerError(res, err, next);
  }
});
