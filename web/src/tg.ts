// Thin wrapper around the Telegram WebApp SDK (loaded via the script tag).

interface TgHapticFeedback {
  impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
  notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  selectionChanged: () => void;
}
interface TgBackButton {
  show: () => void;
  hide: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
}
interface TgWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  showScanQrPopup?: (params: { text?: string }, cb?: (text: string) => boolean) => void;
  closeScanQrPopup?: () => void;
  showAlert?: (msg: string) => void;
  initDataUnsafe?: { user?: { id: number; username?: string }; start_param?: string };
  colorScheme?: 'light' | 'dark';
  onEvent?: (event: string, cb: () => void) => void;
  HapticFeedback?: TgHapticFeedback;
  BackButton?: TgBackButton;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export const tg: TgWebApp | undefined = window.Telegram?.WebApp;

export function initData(): string {
  return tg?.initData ?? '';
}

/**
 * The Telegram deep-link payload (`startapp=…` on a Direct Link), delivered by
 * the WebApp as `initDataUnsafe.start_param`. Falls back to a `?startapp=` URL
 * query so the flow is testable in a plain browser / dev. Treated as cosmetic
 * UI context only (never as authorization), so reading it client-side is fine.
 */
export function startParam(): string {
  const fromTg = tg?.initDataUnsafe?.start_param;
  if (fromTg) return fromTg;
  return new URLSearchParams(window.location.search).get('startapp') ?? '';
}

/** Parse `merchant_<id>` (or a bare numeric) from the deep-link payload. */
export function startMerchantId(): number | null {
  const m = startParam().match(/^merchant_(\d+)$|^(\d+)$/);
  if (!m) return null;
  return Number(m[1] ?? m[2]);
}

export function alertMsg(msg: string): void {
  if (tg?.showAlert) tg.showAlert(msg);
  else window.alert(msg);
}

/**
 * Open the native Telegram QR scanner. Resolves with the scanned text, or null
 * if unavailable (falls back to a manual prompt outside Telegram).
 */
export function scanQr(): Promise<string | null> {
  return new Promise((resolveScan) => {
    if (tg?.showScanQrPopup) {
      tg.showScanQrPopup({ text: 'Point at the customer QR' }, (text: string) => {
        tg.closeScanQrPopup?.();
        resolveScan(text);
        return true;
      });
    } else {
      const text = window.prompt('Paste the QR token (no native scanner):');
      resolveScan(text);
    }
  });
}

/** Copy text to the clipboard, with a prompt fallback. Returns true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt('Copy your ID:', text);
    return false;
  }
}

export function ready(): void {
  tg?.ready();
  tg?.expand();
  applyTheme();
  // Re-apply Direction C light/dark when Telegram's theme changes at runtime.
  tg?.onEvent?.('themeChanged', applyTheme);
  // Outside Telegram, follow the OS preference.
  if (!tg && window.matchMedia) {
    window
      .matchMedia('(prefers-color-scheme: dark)')
      .addEventListener('change', applyTheme);
  }
}

/**
 * Set `data-theme` on <html> so the Direction C palette switches light/dark.
 * Inside Telegram it follows `tg.colorScheme`; in a plain browser it follows
 * the OS `prefers-color-scheme`.
 */
export function applyTheme(): void {
  let dark: boolean;
  if (tg?.colorScheme) dark = tg.colorScheme === 'dark';
  else dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Fire Telegram haptic feedback when available (no-op outside Telegram). */
export function haptic(
  kind: 'impact' | 'notification' | 'selection',
  style?: string,
): void {
  const h = tg?.HapticFeedback;
  if (!h) return;
  try {
    if (kind === 'selection') h.selectionChanged();
    else if (kind === 'notification')
      h.notificationOccurred((style as 'error' | 'success' | 'warning') || 'success');
    else h.impactOccurred((style as 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') || 'light');
  } catch {
    /* haptics are best-effort */
  }
}

/**
 * Show Telegram's native BackButton wired to `cb`, returning a cleanup function
 * that hides it and detaches the handler. No-op (returns a noop) outside Telegram
 * so callers can rely on it unconditionally.
 */
export function showBackButton(cb: () => void): () => void {
  const b = tg?.BackButton;
  if (!b) return () => undefined;
  b.onClick(cb);
  b.show();
  return () => {
    b.offClick(cb);
    b.hide();
  };
}
