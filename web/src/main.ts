import './styles.css';
import { ready } from './tg.js';
import { renderUser, stopQrTimer } from './user.js';
import { renderAdmin } from './admin.js';
import { renderDocs } from './docs.js';

ready();

const root = document.getElementById('root')!;

async function route(): Promise<void> {
  try {
    const path = location.pathname;
    if (path.startsWith('/help') || path.startsWith('/docs')) {
      stopQrTimer();
      renderDocs(root);
    } else if (path.startsWith('/admin')) {
      stopQrTimer(); // leaving the user view — stop the background QR poll
      await renderAdmin(root);
    } else {
      await renderUser(root);
    }
  } catch (err) {
    root.innerHTML = `<div class="card error">Ошибка: ${(err as Error).message}</div>`;
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
