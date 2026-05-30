import { pool } from '../db/pool.js';
import { LedgerError } from './ledger.js';

/** Ensure a user row + wallet exist for a Telegram id; return internal user id. */
export async function ensureUser(telegramId: number): Promise<number> {
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

export interface MemberResult {
  user_id: number;
  telegram_id: number;
  role: string;
}

/**
 * Add (or update the role of) a staff member of a merchant. Enforces the
 * one-merchant-per-employee rule: a user already on a DIFFERENT merchant is
 * rejected (the unique index on merchant_members.user_id is the DB backstop).
 * Role change within the same merchant is allowed.
 */
export async function addMember(
  merchantId: number,
  telegramId: number,
  role: 'admin' | 'scanner',
): Promise<MemberResult> {
  const merchant = await pool.query(`SELECT 1 FROM merchants WHERE id = $1`, [merchantId]);
  if (merchant.rowCount === 0) throw new LedgerError(404, 'merchant not found');

  const userId = await ensureUser(telegramId);

  const existing = await pool.query<{ merchant_id: number }>(
    `SELECT merchant_id FROM merchant_members WHERE user_id = $1`,
    [userId],
  );
  const current = existing.rows[0];
  if (current && current.merchant_id !== merchantId) {
    throw new LedgerError(409, 'this account already works at another merchant');
  }

  await pool.query(
    `INSERT INTO merchant_members (merchant_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, merchant_id = EXCLUDED.merchant_id`,
    [merchantId, userId, role],
  );
  return { user_id: userId, telegram_id: telegramId, role };
}

/** List staff of a merchant. */
export async function listMembers(merchantId: number): Promise<
  Array<{ user_id: number; telegram_id: number; username: string | null; role: string }>
> {
  const { rows } = await pool.query(
    `SELECT mm.user_id, u.telegram_id, u.username, mm.role
       FROM merchant_members mm
       JOIN users u ON u.id = mm.user_id
      WHERE mm.merchant_id = $1
      ORDER BY mm.role, u.username NULLS LAST`,
    [merchantId],
  );
  return rows as Array<{ user_id: number; telegram_id: number; username: string | null; role: string }>;
}

/**
 * Remove a staff member. `restrictToScanner` (merchant-admin self-service) forbids
 * removing admins; super-admins pass it as false.
 */
export async function removeMember(
  merchantId: number,
  userId: number,
  restrictToScanner: boolean,
): Promise<void> {
  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM merchant_members WHERE merchant_id = $1 AND user_id = $2`,
    [merchantId, userId],
  );
  const member = rows[0];
  if (!member) throw new LedgerError(404, 'member not found');
  if (restrictToScanner && member.role !== 'scanner') {
    throw new LedgerError(403, 'only scanners can be removed here');
  }
  await pool.query(`DELETE FROM merchant_members WHERE merchant_id = $1 AND user_id = $2`, [merchantId, userId]);
}
