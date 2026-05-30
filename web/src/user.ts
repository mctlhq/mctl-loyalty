import QRCode from 'qrcode';
import { api } from './api.js';
import { alertMsg, copyText } from './tg.js';

interface Me {
  telegram_id: number;
  username: string | null;
  super_admin: boolean;
  balance: number;
}
interface Txn {
  id: number;
  delta: number;
  type: string;
  reason: string | null;
  merchant_name: string | null;
  created_at: string;
}
interface Reward {
  id: number;
  title: string;
  description: string | null;
  cost: number;
}

let qrTimer: number | undefined;

// Stop the rotating-QR poll. Called when leaving the user view so the interval
// does not keep minting tokens / drawing to a detached canvas in the background.
export function stopQrTimer(): void {
  if (qrTimer) {
    window.clearInterval(qrTimer);
    qrTimer = undefined;
  }
}

async function refreshQr(canvas: HTMLCanvasElement): Promise<void> {
  try {
    const { token } = await api.get<{ token: string }>('/qr/current');
    await QRCode.toCanvas(canvas, token, { width: 240, margin: 1 });
  } catch (err) {
    console.error('qr', err);
  }
}

export async function renderUser(root: HTMLElement): Promise<void> {
  const me = await api.get<Me>('/me');
  // Staff (scanner/merchant-admin) and super-admins get the Admin panel link.
  let isStaff = me.super_admin;
  if (!isStaff) {
    try {
      const { merchants } = await api.get<{ merchants: unknown[] }>('/staff/merchants');
      isStaff = merchants.length > 0;
    } catch {
      /* not staff */
    }
  }
  root.innerHTML = `
    <div class="card">
      <div class="balance"><span>${me.balance}</span><small>points</small></div>
      <div class="muted">${me.username ? '@' + esc(me.username) : 'Telegram user'}</div>
      <div class="idline">ID: <code>${me.telegram_id}</code> <button class="ghost" id="copy-id">Copy</button></div>
    </div>
    <div class="card center">
      <canvas id="qr"></canvas>
      <div class="muted">Show this QR to staff. It refreshes automatically.</div>
    </div>
    <div class="card">
      <h3>Rewards</h3>
      <div id="rewards">Loading…</div>
    </div>
    <div class="card">
      <h3>History</h3>
      <div id="txns">Loading…</div>
    </div>
    <div class="links">
      ${isStaff ? '<a class="link" href="/admin">Admin panel →</a>' : ''}
      <a class="link" href="/help">Help &amp; guide</a>
    </div>
  `;

  root.querySelector<HTMLButtonElement>('#copy-id')!.addEventListener('click', async () => {
    const ok = await copyText(String(me.telegram_id));
    if (ok) alertMsg('ID copied');
  });

  const canvas = root.querySelector<HTMLCanvasElement>('#qr')!;
  await refreshQr(canvas);
  if (qrTimer) window.clearInterval(qrTimer);
  qrTimer = window.setInterval(() => void refreshQr(canvas), 30_000);

  const rewards = await api.get<{ rewards: Reward[] }>('/rewards');
  const rewardsEl = root.querySelector('#rewards')!;
  rewardsEl.innerHTML = rewards.rewards.length
    ? rewards.rewards
        .map(
          (r) => `<div class="row">
            <div><b>${esc(r.title)}</b><div class="muted">${esc(r.description ?? '')}</div></div>
            <button data-reward="${r.id}">${r.cost}</button>
          </div>`,
        )
        .join('')
    : '<div class="muted">No rewards yet</div>';
  rewardsEl.querySelectorAll<HTMLButtonElement>('button[data-reward]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.post<{ balance: number; rewardTitle: string }>('/redeem', {
          reward_id: Number(btn.dataset.reward),
        });
        alertMsg(`Redeemed "${r.rewardTitle}". Balance: ${r.balance}`);
        await renderUser(root);
      } catch (err) {
        alertMsg((err as Error).message);
        btn.disabled = false;
      }
    });
  });

  const txns = await api.get<{ transactions: Txn[] }>('/transactions');
  const txnsEl = root.querySelector('#txns')!;
  txnsEl.innerHTML = txns.transactions.length
    ? txns.transactions
        .map(
          (t) => `<div class="row">
            <div>${esc(t.reason ?? t.type)}<div class="muted">${fmt(t.created_at)}${t.merchant_name ? ' · ' + esc(t.merchant_name) : ''}</div></div>
            <span class="${t.delta >= 0 ? 'pos' : 'neg'}">${t.delta >= 0 ? '+' : ''}${t.delta}</span>
          </div>`,
        )
        .join('')
    : '<div class="muted">No operations yet</div>';
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}
