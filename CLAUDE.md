# mctl-loyalty

Telegram Mini App community loyalty system. Node/TS + Express + PostgreSQL,
deployed to the mctl platform (`labs` tenant) at `labs-mctl-loyalty.mctl.ai`.

## What it does
- **Single global points balance per user** (community currency).
- **Many merchants** (shop / cafe / event), each with staff (`admin` / `scanner`).
  Merchants are created by **super-admins** (`SUPER_ADMIN_TELEGRAM_IDS`).
- Users show a **dynamic, rotating QR** (opaque one-time token, 60 s TTL, burns on
  scan). Staff scan it and apply a fixed-value **accrual rule** → points credited.
- Users spend points on a **rewards** catalog; redemptions reserve points at
  `pending` and a cancel writes a compensating reversal.

## Stack & layout
- `src/` — Express backend (TS). `src/services/ledger.ts` holds all balance-mutating
  logic; every mutation is a single DB transaction with `SELECT … FOR UPDATE` on the
  wallet. Daily accrual limits use a transaction-scoped `pg_advisory_xact_lock` + count.
- `web/` — one Vite SPA, client-routed `/app` (user) and `/admin` (staff/super-admin),
  built into `public/` and served by Express.
- `src/db/schema.sql` — idempotent schema, applied on startup under an advisory lock.

## Conventions
- Conventional commits; semver tags **without** `v` prefix.
- No emoji in code or commits. English in code/comments.
- **Never commit features directly to `main`** — feature branch → PR → review → merge.
- Secrets via Vault + base-service ExternalSecret; never hardcoded.

## Local dev
```bash
npm install && npm run build
DATABASE_URL=postgres://... AUTH_DEV_BYPASS=true npm start
# then set localStorage.debugUserId in the browser to impersonate a Telegram id
```

## Env
- `DATABASE_URL` — Postgres (injected by base-service db ExternalSecret).
- `TELEGRAM_BOT_TOKEN` — BotFather token (initData verification + notifications).
- `SUPER_ADMIN_TELEGRAM_IDS` — comma-separated Telegram ids of platform super-admins.
- `QR_TTL_SECONDS` (default 60), `PORT` (default 8080), `AUTH_DEV_BYPASS` (dev only).
