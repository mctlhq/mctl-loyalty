// Thin wrapper around the Telegram WebApp SDK (loaded via the script tag).

interface TgWebApp {
  initData: string;
  ready: () => void;
  expand: () => void;
  showScanQrPopup?: (params: { text?: string }, cb?: (text: string) => boolean) => void;
  closeScanQrPopup?: () => void;
  showAlert?: (msg: string) => void;
  initDataUnsafe?: { user?: { id: number; username?: string } };
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
}
