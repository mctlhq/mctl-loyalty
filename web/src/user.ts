import QRCode from 'qrcode';
import { api } from './api.js';
import { alertMsg } from './tg.js';

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
  root.innerHTML = `
    <div class="card">
      <div class="balance"><span>${me.balance}</span><small>баллов</small></div>
      <div class="muted">${me.username ? '@' + me.username : 'id ' + me.telegram_id}</div>
    </div>
    <div class="card center">
      <canvas id="qr"></canvas>
      <div class="muted">QR обновляется автоматически</div>
    </div>
    <div class="card">
      <h3>Награды</h3>
      <div id="rewards">Загрузка…</div>
    </div>
    <div class="card">
      <h3>История</h3>
      <div id="txns">Загрузка…</div>
    </div>
    ${me.super_admin ? '<a class="link" href="/admin">Панель администратора →</a>' : ''}
  `;

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
    : '<div class="muted">Пока нет наград</div>';
  rewardsEl.querySelectorAll<HTMLButtonElement>('button[data-reward]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.post<{ balance: number; rewardTitle: string }>('/redeem', {
          reward_id: Number(btn.dataset.reward),
        });
        alertMsg(`Списано! «${r.rewardTitle}». Баланс: ${r.balance}`);
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
    : '<div class="muted">Операций пока нет</div>';
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function fmt(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
