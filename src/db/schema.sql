-- mctl-loyalty schema. Idempotent: safe to run on every startup.
-- Single global balance per user; many merchants; per-merchant staff.

CREATE TABLE IF NOT EXISTS users (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL UNIQUE,
  username     TEXT,
  referred_by  BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one global wallet per user (the shared community currency).
CREATE TABLE IF NOT EXISTS wallets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  balance     INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The "admin" business entity: shop / cafe / event. Created by a super-admin.
CREATE TABLE IF NOT EXISTS merchants (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'shop' CHECK (type IN ('shop','cafe','event','community')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Staff membership (user <-> merchant, many-to-many).
CREATE TABLE IF NOT EXISTS merchant_members (
  id           BIGSERIAL PRIMARY KEY,
  merchant_id  BIGINT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'scanner' CHECK (role IN ('admin','scanner')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_merchant_members_user ON merchant_members(user_id);
-- One employee belongs to at most ONE merchant (DB-level backstop for the rule).
CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_members_user ON merchant_members(user_id);

-- Accrual presets. merchant_id NULL = global rule available to every merchant.
CREATE TABLE IF NOT EXISTS accrual_rules (
  id           BIGSERIAL PRIMARY KEY,
  merchant_id  BIGINT REFERENCES merchants(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'fixed' CHECK (kind IN ('fixed','amount')),
  point_value  INTEGER NOT NULL DEFAULT 0,
  rate         NUMERIC,
  daily_limit  INTEGER,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only points ledger. The balance is always the sum of deltas.
CREATE TABLE IF NOT EXISTS transactions (
  id             BIGSERIAL PRIMARY KEY,
  wallet_id      BIGINT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id    BIGINT REFERENCES merchants(id) ON DELETE SET NULL,
  delta          INTEGER NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('earn','spend','adjust','reversal')),
  reason         TEXT,
  rule_id        BIGINT REFERENCES accrual_rules(id) ON DELETE SET NULL,
  redemption_id  BIGINT,
  actor_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);

-- Dynamic-QR one-time tokens. We store ONLY the SHA-256 hash, never the raw token.
CREATE TABLE IF NOT EXISTS qr_tokens (
  jti                 UUID PRIMARY KEY,
  token_hash          BYTEA NOT NULL UNIQUE,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at          TIMESTAMPTZ NOT NULL,
  used_at             TIMESTAMPTZ,
  used_by_merchant_id BIGINT REFERENCES merchants(id) ON DELETE SET NULL,
  used_by_user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qr_tokens_expires ON qr_tokens(expires_at);

-- Backs the DB-level daily accrual limit. The accrue path takes a transaction-
-- scoped advisory lock keyed on (user_id, rule_id) so concurrent scans of the
-- same user+rule serialize, then counts today's rows against the rule's
-- daily_limit before inserting. Because lock + count + insert all run inside one
-- transaction, the cap is enforced by the database, not just application code.
CREATE TABLE IF NOT EXISTS accruals (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id         BIGINT NOT NULL REFERENCES accrual_rules(id) ON DELETE CASCADE,
  accrual_date    DATE NOT NULL,
  transaction_id  BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accruals_daily
  ON accruals(user_id, rule_id, accrual_date);

-- Global rewards catalog (merchant_id NULL = global). All priced in the shared currency.
CREATE TABLE IF NOT EXISTS rewards (
  id           BIGSERIAL PRIMARY KEY,
  merchant_id  BIGINT REFERENCES merchants(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  cost         INTEGER NOT NULL CHECK (cost > 0),
  stock        INTEGER,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Redemptions. Points are spent immediately at 'pending'. Cancel writes a reversal.
CREATE TABLE IF NOT EXISTS redemptions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reward_id       BIGINT NOT NULL REFERENCES rewards(id) ON DELETE RESTRICT,
  cost            INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fulfilled','cancelled')),
  merchant_id     BIGINT REFERENCES merchants(id) ON DELETE SET NULL,
  actor_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  spend_txn_id    BIGINT REFERENCES transactions(id) ON DELETE SET NULL,
  reversal_txn_id BIGINT REFERENCES transactions(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON redemptions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemptions_status ON redemptions(status);

-- Audit trail for staff / super-admin actions.
CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  actor_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  merchant_id    BIGINT REFERENCES merchants(id) ON DELETE SET NULL,
  action         TEXT NOT NULL,
  target_type    TEXT,
  target_id      BIGINT,
  meta           JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
