import type { NextFunction, Request, Response } from 'express';
import { config, isSuperAdmin } from '../config.js';
import { pool } from '../db/pool.js';
import { verifyInitData } from '../telegram/initData.js';

export interface AuthContext {
  userId: number; // internal users.id
  telegramId: number;
  username: string | null;
  superAdmin: boolean;
}

const CTX = Symbol('authCtx');

export function getCtx(req: Request): AuthContext {
  const ctx = (req as unknown as Record<symbol, AuthContext>)[CTX];
  if (!ctx) throw new Error('auth context missing — route not behind requireAuth');
  return ctx;
}

/**
 * Upsert the Telegram user + their single wallet, return the internal user id.
 */
async function resolveUser(telegramId: number, username: string | null): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO users (telegram_id, username)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id)
       DO UPDATE SET username = COALESCE(EXCLUDED.username, users.username)
     RETURNING id`,
    [telegramId, username],
  );
  const userId = rows[0]!.id;
  await pool.query(
    `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  return userId;
}

/**
 * Authenticate the request from the `X-Telegram-Init-Data` header (the Mini App
 * initData string). In dev, AUTH_DEV_BYPASS allows an `X-Debug-User-Id` header.
 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let telegramId: number | null = null;
    let username: string | null = null;

    if (config.authDevBypass && req.header('x-debug-user-id')) {
      telegramId = Number.parseInt(req.header('x-debug-user-id') ?? '', 10);
      username = req.header('x-debug-username') ?? null;
    } else {
      const initData = req.header('x-telegram-init-data') ?? '';
      const verified = verifyInitData(initData);
      if (verified) {
        telegramId = verified.user.id;
        username = verified.user.username ?? null;
      }
    }

    if (!telegramId || !Number.isFinite(telegramId)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    try {
      const userId = await resolveUser(telegramId, username);
      (req as unknown as Record<symbol, AuthContext>)[CTX] = {
        userId,
        telegramId,
        username,
        superAdmin: isSuperAdmin(telegramId),
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireSuperAdmin() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!getCtx(req).superAdmin) {
      res.status(403).json({ error: 'super-admin only' });
      return;
    }
    next();
  };
}

/**
 * Gate a route on the caller being staff of merchant `:mid` with one of `roles`.
 * Super-admins always pass. Resolves and attaches nothing extra; routes read
 * `req.params.mid`.
 */
export function requireMember(roles: Array<'admin' | 'scanner'>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = getCtx(req);
    const mid = Number.parseInt(req.params.mid ?? '', 10);
    if (!Number.isFinite(mid)) {
      res.status(400).json({ error: 'bad merchant id' });
      return;
    }
    if (ctx.superAdmin) {
      next();
      return;
    }
    try {
      const { rows } = await pool.query<{ role: string }>(
        `SELECT role FROM merchant_members WHERE merchant_id = $1 AND user_id = $2`,
        [mid, ctx.userId],
      );
      const role = rows[0]?.role as 'admin' | 'scanner' | undefined;
      if (!role || !roles.includes(role)) {
        res.status(403).json({ error: 'not authorized for this merchant' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
