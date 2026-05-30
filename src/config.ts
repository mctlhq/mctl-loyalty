// Central runtime configuration, read once from the environment.

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

function listEnv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: intEnv('PORT', 8080),
  appEnv: process.env.APP_ENV ?? 'development',
  serviceVersion: process.env.SERVICE_VERSION ?? '0.1.0',

  // Postgres. The platform injects DATABASE_URL via the base-service db ExternalSecret.
  databaseUrl: process.env.DATABASE_URL ?? '',

  // Telegram bot token (BotFather). Used for initData verification + notifications.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',

  // Comma-separated Telegram user ids that are platform super-admins.
  superAdminIds: new Set(listEnv('SUPER_ADMIN_TELEGRAM_IDS')),

  // QR token time-to-live in seconds (the dynamic-QR rotation window).
  qrTtlSeconds: intEnv('QR_TTL_SECONDS', 60),

  // initData freshness window in seconds (reject stale Mini App auth payloads).
  initDataMaxAgeSeconds: intEnv('INITDATA_MAX_AGE_SECONDS', 86400),

  // When true (local dev only), accept an X-Debug-User-Id header instead of real
  // Telegram initData. Hard-disabled when APP_ENV=production so an accidental
  // env flag can never open an auth bypass in prod.
  authDevBypass:
    process.env.AUTH_DEV_BYPASS === 'true' && (process.env.APP_ENV ?? 'development') !== 'production',
} as const;

export function isSuperAdmin(telegramId: string | number): boolean {
  return config.superAdminIds.has(String(telegramId));
}
