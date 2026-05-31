# mctl-loyalty

Telegram Mini App **community loyalty** system. Node/TS + Express + PostgreSQL,
deployed to the mctl platform (`labs` tenant). Live at **`rewards.mctl.ai`**
(legacy `labs-mctl-loyalty.mctl.ai` / `.mctl.me` kept as permanent aliases).
Bot: **@MCTL Rewards** (`@mctl_rewards_bot`). Current image: **0.8.0**.

## What it does
- **One points balance per user, global across all merchants** (a single community
  currency). NOTE: "global" means the balance is NOT split per-merchant — each user
  still earns their OWN points; there is no shared/pooled balance across people.
- **Many merchants** (shop / cafe / event), each with staff (`admin` / `scanner`).
  Merchants are created by **super-admins** (`SUPER_ADMIN_TELEGRAM_IDS`). One
  employee belongs to at most ONE merchant (unique index on `merchant_members.user_id`).
- **Earning**: a user shows a dynamic rotating QR (opaque one-time token, 60 s TTL,
  only the SHA-256 hash stored, burns on scan). Staff scan it and apply a fixed-value
  **accrual rule** → points credited. Daily limits enforced at the DB level.
  Accrual rules are global (super-admin) or per-merchant (a merchant-admin manages
  its own). `point_value` is capped (`MAX_POINT_VALUE`) and a merchant-scoped rule
  must declare a `daily_limit` (per-customer/day, also capped) so a merchant-admin
  cannot mint unbounded points; globals may omit the limit. Merchant-admins can only
  deactivate their rules (soft-delete) — hard delete is super-admin only, since the
  `accruals` FK cascade would otherwise reset daily-limit history.
- **Redeeming (hold → capture)**: tapping a reward HOLDS the points immediately
  (`pending`, balance debited, stock decremented) and shows the user a **redemption QR**.
  Staff scan that QR ("Scan redemption") to **capture/fulfill** it. If the user cancels
  or the reservation expires, a compensating reversal returns points AND restores stock.
- **Merchant deep-link context**: `https://t.me/mctl_rewards_bot/app?startapp=merchant_<id>`
  opens the Mini App scoped to that merchant (welcome banner + rewards filtered to that
  merchant + community-wide). Cosmetic UI only (read client-side from `start_param`),
  NOT authorization — no change to initData validation.

## Stack & layout
- `src/` — Express backend (TS). `src/services/ledger.ts` holds ALL balance/stock-mutating
  logic; every mutation is a single `withTransaction` with `SELECT … FOR UPDATE` on the
  wallet (and reward, where stock changes). Daily accrual limits use a transaction-scoped
  `pg_advisory_xact_lock` + count. Routes: `src/routes/{user,staff,admin}.ts` — all mounted
  at `/api` behind `requireAuth()`; userRouter before staffRouter.
- `web/` — one Vite SPA (the Mini App), client-routed `/app` (user) and `/admin`
  (staff/super-admin) + `/help` + `/docs`. Builds to `public/_miniapp/`
  (`vite base:/_miniapp/`, `outDir:../public/_miniapp`).
- `landing/` — **Astro static** marketing landing (zero/minimal JS). Builds to `public/`
  root (`index.html`, `/privacy`, `/terms`, `404.html`, assets under `_astro/`).
- `src/db/schema.sql` — idempotent schema, applied on startup under an advisory lock
  (CREATE TABLE IF NOT EXISTS + idempotent ALTERs for live migrations).

## Routing (Express, `src/server.ts`)
- `/api/*` — backend (registered BEFORE static).
- `/` — Astro landing (`public/index.html`), public, no auth.
- `/app`, `/admin`, `/docs` — SPA fallback → `public/_miniapp/index.html`.
- `/help` — permanent 301 redirect → `/docs` (legacy route, collapsed into `/docs`).
- `/_astro/*`, `/_miniapp/*`, `/privacy`, `/terms`, `/favicon.svg` — static files.
- unknown path → `public/404.html` (else redirect `/`).
- The Telegram Menu Button + deep links point to **`/app`**, never `/`.

## Build & deploy
- Root `npm run build` orchestrates `build:landing` → `build:web` → `build:api`
  (order matters: Astro empties `public/` first, then the SPA writes only `public/_miniapp`).
- Dockerfile: separate `build-api` (uses `build:api`, NOT the full build), `build-landing`,
  `build-web` stages; runtime copies landing → `./public`, then SPA → `./public/_miniapp`.
  Vite `outDir:../public/_miniapp` resolves from the `web/` root to `/app/public/_miniapp`.
- Deploy: `mctl_deploy_service action=deploy team=labs component=mctl-loyalty git_tag=X.Y.Z`
  (builds image in mctl-gitops GHA, bumps gitops values, refreshes the appset — avoids the
  stale-revision footgun). A rolling update briefly serves the OLD pod (~1 min) — verify
  with a cache-buster before concluding a deploy "didn't take".

## Version history
- 0.1.x — MVP. 0.2.x — English UI, one-merchant-per-employee, self-service staff, role-aware docs.
- 0.3.0 — merchant deep-link (`startapp=merchant_<id>`).
- 0.4.0 — redemption QR (hold-on-click → merchant-scan capture; statuses `pending`/`fulfilled`/
  `cancelled_by_user`/`cancelled_by_staff`/`expired`; 15-min reservation + 5-min re-mintable QR;
  60 s expiry sweeper; manual fulfill admin-only + requires reason).
- 0.5.0 — public Astro landing at `/`; Mini App moved under `/_miniapp`.
- 0.6.0 — landing: real app screenshot in a device frame.
- 0.7.0 — Telegram hand-off for `/app`+`/admin`; `/help` collapsed into `/docs`.
- 0.8.0 — landing redesign to "Direction C · Minimal Editorial" (light/Onest/blue;
  zero-JS Astro phone + admin mockups).

## Conventions
- Conventional commits; semver tags **without** `v` prefix. No emoji in code/commits.
  No `Co-Authored-By` trailer. English in code/comments.
- **Never commit to `main`** — feature branch → PR → CI green → merge commit (not squash).
- Secrets via Vault + base-service ExternalSecret; never hardcoded. The bot token lives in
  Vault `teams/labs/mctl-loyalty` → ExternalSecret `mctl-loyalty-secrets` (wired via a manual
  `envFrom` edit in gitops — any new secret needs the same wiring).
- **Review gate**: `claude-review.yml` exists (tiered model by complexity) but is INERT until
  the per-repo secret `CLAUDE_CODE_OAUTH_TOKEN` is set (`claude setup-token` →
  `gh secret set CLAUDE_CODE_OAUTH_TOKEN -R mctlhq/mctl-loyalty`). Until then PRs are gated by
  CI (backend + web + docker build) + manual self-review.

## Local dev
```bash
npm install && npm run build
DATABASE_URL=postgres://... AUTH_DEV_BYPASS=true npm start
# impersonate a Telegram id: set localStorage.debugUserId in the browser
# deep-link / redemption flows are testable in a plain browser via ?startapp=merchant_<id>
```

## Env
- `DATABASE_URL` — Postgres (injected by base-service db ExternalSecret; CNPG requires SSL).
- `TELEGRAM_BOT_TOKEN` — BotFather token (initData verification + push notifications).
- `SUPER_ADMIN_TELEGRAM_IDS` — comma-separated Telegram ids of platform super-admins.
- `QR_TTL_SECONDS` (default 60), `REDEMPTION_TTL_SECONDS` (default 900),
  `CLAIM_TOKEN_TTL_SECONDS` (default 300), `PORT` (default 8080), `AUTH_DEV_BYPASS` (dev only).
