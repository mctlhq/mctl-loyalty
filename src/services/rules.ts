import { pool, withTransaction } from '../db/pool.js';
import { LedgerError } from './ledger.js';

export interface AccrualRule {
  id: number;
  merchant_id: number | null;
  merchant_name: string | null;
  name: string;
  kind: string;
  point_value: number;
  rate: number | null;
  daily_limit: number | null;
  active: boolean;
  created_at: string;
}

export interface RuleInput {
  name: string;
  kind?: string;
  point_value?: number;
  rate?: number | null;
  daily_limit?: number | null;
  active?: boolean;
}

// Only 'fixed' is supported end-to-end: scanAndAccrue rejects any non-fixed rule
// (after burning the customer's one-time QR token), so an 'amount' rule would be an
// unusable footgun. Keep this allowlist to 'fixed' until amount-based accrual is
// actually implemented in the ledger.
const KINDS = ['fixed'] as const;

// Bounds on accrual rules. point_value is capped for every rule (a fat-fingered
// 999999999 would mint absurd balances), and merchant-scoped rules must declare a
// daily_limit so a non-super-admin cannot create an unbounded-issuance rule.
// Globals (super-admin only) may still omit the daily limit.
const MAX_POINT_VALUE = 1_000_000;
const MAX_DAILY_LIMIT = 100_000;

/** Validate + normalise the mutable fields of an accrual rule. Throws LedgerError(400). */
function normaliseInput(
  input: RuleInput,
  opts: { requireDailyLimit?: boolean } = {},
): {
  name: string;
  kind: string;
  pointValue: number;
  rate: number | null;
  dailyLimit: number | null;
  active: boolean;
} {
  const name = String(input.name ?? '').trim();
  if (!name) throw new LedgerError(400, 'name required');
  const kind = String(input.kind ?? 'fixed');
  if (!KINDS.includes(kind as (typeof KINDS)[number])) {
    throw new LedgerError(400, 'invalid kind');
  }

  const pointValue = Number.parseInt(String(input.point_value ?? ''), 10);
  if (!Number.isFinite(pointValue) || pointValue <= 0) {
    throw new LedgerError(400, 'point_value must be a positive integer');
  }
  if (pointValue > MAX_POINT_VALUE) {
    throw new LedgerError(400, `point_value must not exceed ${MAX_POINT_VALUE}`);
  }

  let rate: number | null = null;
  if (input.rate != null) {
    rate = Number(input.rate);
    if (!Number.isFinite(rate)) throw new LedgerError(400, 'rate must be a number');
  }

  let dailyLimit: number | null = null;
  if (input.daily_limit != null && String(input.daily_limit).trim() !== '') {
    dailyLimit = Number.parseInt(String(input.daily_limit), 10);
    if (!Number.isFinite(dailyLimit) || dailyLimit <= 0) {
      throw new LedgerError(400, 'daily_limit must be a positive integer');
    }
    if (dailyLimit > MAX_DAILY_LIMIT) {
      throw new LedgerError(400, `daily_limit must not exceed ${MAX_DAILY_LIMIT}`);
    }
  }
  if (opts.requireDailyLimit && dailyLimit == null) {
    throw new LedgerError(400, 'daily_limit is required for a merchant rule');
  }

  const active = input.active != null ? Boolean(input.active) : true;
  return { name, kind, pointValue, rate, dailyLimit, active };
}

/**
 * Create an accrual rule. `merchantId` is the owning scope: NULL = a global rule
 * (super-admin), non-NULL = a specific merchant's own rule. Callers are
 * responsible for authorising the requested scope; this layer never reads the
 * scope from request bodies.
 */
export async function createRule(merchantId: number | null, input: RuleInput): Promise<{ id: number }> {
  const r = normaliseInput(input, { requireDailyLimit: merchantId != null });
  if (merchantId != null) {
    const merchant = await pool.query(`SELECT 1 FROM merchants WHERE id = $1`, [merchantId]);
    if (merchant.rowCount === 0) throw new LedgerError(404, 'merchant not found');
  }
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accrual_rules (merchant_id, name, kind, point_value, rate, daily_limit, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [merchantId, r.name, r.kind, r.pointValue, r.rate, r.dailyLimit, r.active],
  );
  return { id: rows[0]!.id };
}

/**
 * Update an accrual rule with PATCH semantics: only the fields actually supplied
 * (not `undefined`) override the existing row; the rest are preserved. This lets a
 * partial body such as `{ active: false }` work without re-sending name/points. The
 * existing row is locked `FOR UPDATE`, merged, then the MERGED result is validated
 * (so bounds/required-daily-limit still apply to the final values).
 *
 * `scopeMerchantId`, when provided, constrains the lookup to `merchant_id =
 * scopeMerchantId` so a merchant-admin can physically only touch their own rules
 * (never globals or another merchant's). Pass `undefined` for an unscoped
 * super-admin update of any rule (including globals).
 */
export async function updateRule(
  ruleId: number,
  input: RuleInput,
  scopeMerchantId?: number,
): Promise<void> {
  await withTransaction(async (client) => {
    const lookup: unknown[] = [ruleId];
    let where = `id = $1`;
    if (scopeMerchantId !== undefined) {
      where += ` AND merchant_id = $2`;
      lookup.push(scopeMerchantId);
    }
    const existing = await client.query<{
      name: string;
      kind: string;
      point_value: number;
      rate: number | null;
      daily_limit: number | null;
      active: boolean;
    }>(
      `SELECT name, kind, point_value, rate, daily_limit, active
         FROM accrual_rules WHERE ${where} FOR UPDATE`,
      lookup,
    );
    if (existing.rowCount === 0) throw new LedgerError(404, 'rule not found');
    const cur = existing.rows[0]!;

    const merged: RuleInput = {
      name: input.name !== undefined ? input.name : cur.name,
      kind: input.kind !== undefined ? input.kind : cur.kind,
      point_value: input.point_value !== undefined ? input.point_value : cur.point_value,
      rate: input.rate !== undefined ? input.rate : cur.rate,
      daily_limit: input.daily_limit !== undefined ? input.daily_limit : cur.daily_limit,
      active: input.active !== undefined ? input.active : cur.active,
    };
    const r = normaliseInput(merged, { requireDailyLimit: scopeMerchantId !== undefined });
    await client.query(
      `UPDATE accrual_rules
          SET name = $1, kind = $2, point_value = $3, rate = $4, daily_limit = $5, active = $6
        WHERE id = $7`,
      [r.name, r.kind, r.pointValue, r.rate, r.dailyLimit, r.active, ruleId],
    );
  });
}

/**
 * Soft-delete: deactivate a rule (SET active = false) instead of removing the row.
 * Both the merchant and super-admin delete routes use this — never a physical
 * DELETE: `accruals.rule_id` is `ON DELETE CASCADE` and `transactions.rule_id` is
 * `ON DELETE SET NULL`, so a hard delete would wipe a rule's accrual rows (resetting
 * daily-limit counts — a delete-and-recreate cap bypass) and detach its history.
 * `scopeMerchantId`, when provided, confines the change to that merchant's own rules
 * (merchant-admin); `undefined` lets a super-admin deactivate any rule.
 */
export async function deactivateRule(ruleId: number, scopeMerchantId?: number): Promise<void> {
  const params: unknown[] = [ruleId];
  let where = `id = $1`;
  if (scopeMerchantId !== undefined) {
    where += ` AND merchant_id = $2`;
    params.push(scopeMerchantId);
  }
  const { rowCount } = await pool.query(
    `UPDATE accrual_rules SET active = false WHERE ${where}`,
    params,
  );
  if (rowCount === 0) throw new LedgerError(404, 'rule not found');
}

/** List a single merchant's OWN rules (excludes globals). Management view. */
export async function listMerchantRules(merchantId: number): Promise<AccrualRule[]> {
  const { rows } = await pool.query(
    `SELECT id, merchant_id, NULL::text AS merchant_name, name, kind, point_value, rate,
            daily_limit, active, created_at
       FROM accrual_rules
      WHERE merchant_id = $1
      ORDER BY name`,
    [merchantId],
  );
  return rows as AccrualRule[];
}

/** List ALL rules across every merchant + globals, with the owning name joined. */
export async function listAllRules(): Promise<AccrualRule[]> {
  const { rows } = await pool.query(
    `SELECT ar.id, ar.merchant_id, m.name AS merchant_name, ar.name, ar.kind,
            ar.point_value, ar.rate, ar.daily_limit, ar.active, ar.created_at
       FROM accrual_rules ar
       LEFT JOIN merchants m ON m.id = ar.merchant_id
      ORDER BY ar.merchant_id NULLS FIRST, ar.name`,
  );
  return rows as AccrualRule[];
}
