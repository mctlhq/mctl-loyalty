import './styles.css';
import { initData, ready } from './tg.js';
import { renderUser, stopQrTimer } from './user.js';
import { renderAdmin } from './admin.js';
import { renderDocs } from './docs.js';

ready();

const root = document.getElementById('root')!;

// The app runs inside Telegram (signed initData) or, for local dev, via an
// impersonated id in localStorage.debugUserId (paired with server AUTH_DEV_BYPASS).
function hasTelegramContext(): boolean {
  return Boolean(initData()) || Boolean(localStorage.getItem('debugUserId'));
}

// Friendly hand-off when /app or /admin is opened in a plain browser (no
// initData) — better than a bare "unauthorized" error.
function renderOutsideTelegram(el: HTMLElement): void {
  el.innerHTML = `
    <div class="card center">
      <h3>Open in Telegram</h3>
      <div class="muted">MCTL Rewards runs inside Telegram — open it there to see your points, your QR and the rewards you can redeem.</div>
      <div class="links"><a class="link" href="https://t.me/mctl_rewards_bot/app">Open @mctl_rewards_bot →</a></div>
    </div>`;
}

async function route(): Promise<void> {
  try {
    const path = location.pathname;
    // Public docs: viewable without Telegram (renderDocs degrades to the
    // customer guide when /me returns 401).
    if (path.startsWith('/docs')) {
      stopQrTimer();
      await renderDocs(root);
      return;
    }
    // Everything else (/app, /admin) is the authed Mini App.
    if (!hasTelegramContext()) {
      stopQrTimer();
      renderOutsideTelegram(root);
      return;
    }
    if (path.startsWith('/admin')) {
      stopQrTimer(); // leaving the user view — stop the background QR poll
      await renderAdmin(root);
    } else {
      await renderUser(root);
    }
  } catch (err) {
    // Use textContent, not innerHTML interpolation, so an error message can
    // never inject markup.
    root.innerHTML = '<div class="card error"></div>';
    root.firstElementChild!.textContent = `Error: ${(err as Error).message}`;
  }
}

// Intercept in-app links so /app <-> /admin switch without a full reload.
document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest('a.link');
  if (a instanceof HTMLAnchorElement && a.href.startsWith(location.origin)) {
    e.preventDefault();
    history.pushState({}, '', a.getAttribute('href')!);
    void route();
  }
});
window.addEventListener('popstate', () => void route());

void route();
