# mctl-loyalty

Telegram Mini App **community loyalty system**: dynamic-QR check-in, a single global
points balance, a multi-merchant / staff model, rewards and redemptions — all inside
Telegram.

## How it works

1. A user opens the Mini App (`/app`) and sees their **balance** and a **personal QR**
   that rotates every ~30 s. The QR carries an opaque, one-time, 60-second token bound
   to the user; only its SHA-256 hash is stored, and it burns on first scan.
2. A merchant's staff opens the admin app (`/admin`), scans the QR with Telegram's
   built-in scanner, and applies a fixed **accrual rule** (e.g. "Визит +50"). Points
   land in the user's single global balance; the user gets a Telegram notification.
3. The user spends points on **rewards** (merch / access / tickets / discounts /
   donations). Points are reserved immediately when a redemption is created; staff
   then fulfill it, or cancel it (which writes a compensating reversal).

## Roles

- **super-admin** — `SUPER_ADMIN_TELEGRAM_IDS` (comma-separated). Creates merchants,
  assigns staff, defines accrual rules and the rewards catalog.
- **merchant staff** — `admin` / `scanner` per merchant. Scan QRs, manage redemptions.
- **user** — anyone; holds the single global wallet.

## Anti-fraud

Dynamic rotating QR · 60 s token TTL · single-use burn (atomic) · opaque token, hash
only in DB · per-(user, rule) daily limit enforced at the DB level · per-merchant roles
· manual reversals · audit log.

## Stack

Node/TS + Express, PostgreSQL, a single Vite SPA. One Docker image; deployed to the
mctl `labs` tenant. See [CLAUDE.md](./CLAUDE.md) for development details.

## License

Apache-2.0.

<!-- claude-review smoke test: verifying the auto-review token works; this PR will be closed. -->
