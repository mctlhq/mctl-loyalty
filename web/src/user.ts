import QRCode from 'qrcode';
import { api } from './api.js';
import { alertMsg, copyText, startMerchantId } from './tg.js';

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
  redemption_status: string | null;
  created_at: string;
}
interface PendingRedemption {
  id: number;
  reward_title: string;
  cost: number;
  expires_at: string;
  claim_token_expires_at: string;
}
interface Reward {
  id: number;
  title: string;
  description: string | null;
  cost: number;
  merchant_id: number | null;
}

let qrTimer: number | undefined;
// Per-redemption-card countdown intervals, cleared on every re-render so detached
// timers (cards removed from the DOM) never leak.
let redemptionTimers: number[] = [];

function clearRedemptionTimers(): void {
  for (const t of redemptionTimers) window.clearInterval(t);
  redemptionTimers = [];
}

// Merchant deep-link context (`startapp=merchant_<id>`): cosmetic UI scope only —
// shows a welcome banner and narrows the rewards list. Balance/QR/history stay
// global. `resolvedFor` ensures we resolve a given start id at most once (so a
// re-render after redeem keeps the banner); "Show all" sets `contextCleared`.
let merchantContext: { id: number; name: string } | null = null;
let resolvedFor: number | null = null;
let contextCleared = false;

// Stop the rotating-QR poll. Called when leaving the user view so the interval
// does not keep minting tokens / drawing to a detached canvas in the background.
export function stopQrTimer(): void {
  if (qrTimer) {
    window.clearInterval(qrTimer);
    qrTimer = undefined;
  }
  clearRedemptionTimers();
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
  // Drop any countdown timers from a previous render before rebuilding the DOM.
  clearRedemptionTimers();
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
  // Resolve the merchant deep-link context once per distinct start id. On any
  // failure (unknown / inactive / network) fall back silently to the global view.
  const wantId = startMerchantId();
  if (wantId !== null && !contextCleared && resolvedFor !== wantId) {
    resolvedFor = wantId;
    try {
      const m = await api.get<{ id: number; name: string }>(`/merchants/${wantId}`);
      merchantContext = { id: m.id, name: m.name };
    } catch (err) {
      console.warn('[deeplink] merchant context unavailable', err);
      merchantContext = null;
    }
  }
  const ctx = merchantContext;

  const banner = ctx
    ? `<div class="card">
        <div><b>You're at ${esc(ctx.name)}</b></div>
        <div class="muted">Points are one shared community balance — earn and spend them anywhere.</div>
        <div class="links"><button class="ghost" id="show-all">Show all rewards</button></div>
      </div>`
    : '';

  root.innerHTML = `
    ${banner}
    <div id="pending-redemptions"></div>
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
      <a class="link" href="/docs">Help &amp; guide</a>
    </div>
  `;

  root.querySelector<HTMLButtonElement>('#copy-id')!.addEventListener('click', async () => {
    const ok = await copyText(String(me.telegram_id));
    if (ok) alertMsg('ID copied');
  });

  // Clear the deep-link context and re-render the global view.
  root.querySelector<HTMLButtonElement>('#show-all')?.addEventListener('click', () => {
    merchantContext = null;
    contextCleared = true;
    void renderUser(root);
  });

  const canvas = root.querySelector<HTMLCanvasElement>('#qr')!;
  await refreshQr(canvas);
  if (qrTimer) window.clearInterval(qrTimer);
  qrTimer = window.setInterval(() => void refreshQr(canvas), 30_000);

  await renderPendingRedemptions(root);

  const allRewards = (await api.get<{ rewards: Reward[] }>('/rewards')).rewards;
  // In a merchant context, show this place's rewards first, then community-wide
  // (merchant_id === null) ones, which are redeemable anywhere.
  let list = allRewards;
  let rewardsNote = '';
  if (ctx) {
    const own = allRewards.filter((r) => r.merchant_id === ctx.id);
    const global = allRewards.filter((r) => r.merchant_id === null);
    list = [...own, ...global];
    if (!own.length && global.length) {
      rewardsNote = '<div class="muted">No rewards specific to this place yet — community rewards below.</div>';
    }
  }
  const rewardsEl = root.querySelector('#rewards')!;
  rewardsEl.innerHTML = list.length
    ? rewardsNote +
      list
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
        // Reserve the reward (points go on hold) and re-render so the new
        // redemption-QR card appears at the top — no instant "done" alert; the
        // reward is only captured once a merchant scans the QR.
        await api.post('/redeem', { reward_id: Number(btn.dataset.reward) });
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
            <div>${esc(txnLabel(t))}<div class="muted">${fmt(t.created_at)}${t.merchant_name ? ' · ' + esc(t.merchant_name) : ''}</div></div>
            <span class="${t.delta >= 0 ? 'pos' : 'neg'}">${t.delta >= 0 ? '+' : ''}${t.delta}</span>
          </div>`,
        )
        .join('')
    : '<div class="muted">No operations yet</div>';
}

// Phrase a history row by transaction type + redemption lifecycle status.
function txnLabel(t: Txn): string {
  const n = Math.abs(t.delta);
  if (t.type === 'spend') {
    if (t.redemption_status === 'pending') return `Reward reserved · ${n} points on hold`;
    if (t.redemption_status === 'fulfilled') return `Reward fulfilled · ${n} points spent`;
  }
  if (t.type === 'reversal' && t.redemption_status) {
    if (t.redemption_status === 'expired') return `Reward expired · ${n} points returned`;
    if (
      t.redemption_status === 'cancelled_by_user' ||
      t.redemption_status === 'cancelled_by_staff'
    ) {
      return `Reward cancelled · ${n} points returned`;
    }
  }
  return t.reason ?? t.type;
}

// Render the caller's pending-redemption QR cards into #pending-redemptions.
// Each card holds a live QR (the claim token), a mm:ss countdown to the token
// expiry (offering a Refresh QR action when it lapses), and a Cancel button.
async function renderPendingRedemptions(root: HTMLElement): Promise<void> {
  const host = root.querySelector<HTMLElement>('#pending-redemptions');
  if (!host) return;
  let pending: PendingRedemption[];
  try {
    pending = (await api.get<{ redemptions: PendingRedemption[] }>('/redemptions/mine')).redemptions;
  } catch (err) {
    console.error('redemptions/mine', err);
    return;
  }
  if (!pending.length) {
    host.innerHTML = '';
    return;
  }
  host.innerHTML = pending
    .map(
      (p) => `<div class="card center" data-redemption="${p.id}">
        <div><b>${esc(p.reward_title)}</b></div>
        <div class="muted">${p.cost} points on hold — show this QR to staff to collect</div>
        <canvas class="redeem-qr"></canvas>
        <div class="muted"><span class="redeem-countdown"></span></div>
        <div class="links">
          <button class="ghost redeem-cancel">Cancel</button>
        </div>
      </div>`,
    )
    .join('');

  for (const p of pending) {
    const card = host.querySelector<HTMLElement>(`[data-redemption="${p.id}"]`);
    if (!card) continue;
    const canvas = card.querySelector<HTMLCanvasElement>('.redeem-qr')!;
    const countdown = card.querySelector<HTMLElement>('.redeem-countdown')!;

    let tokenExpiresMs = new Date(p.claim_token_expires_at).getTime();

    const drawQr = async (token: string): Promise<void> => {
      await QRCode.toCanvas(canvas, token, { width: 200, margin: 1 });
    };

    // Initial QR: mint a fresh claim token for this redemption.
    try {
      const minted = await api.post<{ claimToken: string; claimTokenExpiresAt: string }>(
        `/redemptions/${p.id}/qr`,
      );
      tokenExpiresMs = new Date(minted.claimTokenExpiresAt).getTime();
      await drawQr(minted.claimToken);
    } catch (err) {
      console.error('mint claim token', err);
    }

    const tick = (): void => {
      const remaining = Math.round((tokenExpiresMs - Date.now()) / 1000);
      if (remaining > 0) {
        const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
        const ss = String(remaining % 60).padStart(2, '0');
        countdown.textContent = `QR valid for ${mm}:${ss}`;
      } else {
        countdown.innerHTML = 'QR expired — <button class="ghost redeem-refresh">Refresh QR</button>';
        countdown.querySelector<HTMLButtonElement>('.redeem-refresh')?.addEventListener(
          'click',
          async () => {
            try {
              const minted = await api.post<{ claimToken: string; claimTokenExpiresAt: string }>(
                `/redemptions/${p.id}/qr`,
              );
              tokenExpiresMs = new Date(minted.claimTokenExpiresAt).getTime();
              await drawQr(minted.claimToken);
            } catch (err) {
              alertMsg((err as Error).message);
            }
          },
        );
      }
    };
    tick();
    redemptionTimers.push(window.setInterval(tick, 1000));

    card.querySelector<HTMLButtonElement>('.redeem-cancel')!.addEventListener('click', async () => {
      try {
        await api.post(`/my-redemptions/${p.id}/cancel`);
        await renderUser(root);
      } catch (err) {
        alertMsg((err as Error).message);
      }
    });
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}
