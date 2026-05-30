import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: number;
}

/**
 * Verify a Telegram Mini App `initData` string per the official algorithm:
 *   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash       = HMAC_SHA256(key=secret_key, msg=data_check_string)
 * where data_check_string is the `\n`-joined sorted "key=value" pairs except `hash`.
 * Returns the verified user, or null if the signature / freshness check fails.
 */
export function verifyInitData(initData: string): VerifiedInitData | null {
  if (!initData || !config.telegramBotToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs: string[] = [];
  for (const [k, v] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    pairs.push(`${k}=${v}`);
  }
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const authDate = Number.parseInt(params.get('auth_date') ?? '0', 10);
  if (!authDate) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > config.initDataMaxAgeSeconds || ageSeconds < -300) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  let user: TelegramUser;
  try {
    user = JSON.parse(userRaw) as TelegramUser;
  } catch {
    return null;
  }
  if (!user || typeof user.id !== 'number') return null;

  return { user, authDate };
}

export function sha256(input: Buffer | string): Buffer {
  return createHash('sha256').update(input).digest();
}
