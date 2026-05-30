import { config } from '../config.js';

/**
 * Fire-and-forget Telegram notification. Never throws into the request path —
 * a failed notification must not roll back a committed points transaction.
 */
export async function notify(telegramId: number | string, text: string): Promise<void> {
  if (!config.telegramBotToken) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: telegramId, text }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn('[bot] sendMessage non-200', res.status, await res.text().catch(() => ''));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[bot] sendMessage failed', (err as Error).message);
  }
}
