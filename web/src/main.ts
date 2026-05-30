import './styles.css';
import { ready } from './tg.js';
import { renderUser, stopQrTimer } from './user.js';
import { renderAdmin } from './admin.js';

ready();

const root = document.getElementById('root')!;

async function route(): Promise<void> {
  try {
    if (location.pathname.startsWith('/admin')) {
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
