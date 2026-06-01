// Role-aware help/guide at /docs (also linked in-app as "Help & guide"). Inside
// Telegram it fetches the caller's role and shows only the relevant sections.
// In a plain browser (no Telegram auth) the calls 401 and it shows the public
// customer guide only.
import { api } from './api.js';

interface Me {
  super_admin: boolean;
}
interface Merchant {
  role: string;
}

// "You are here" badge appended to the section that matches the caller's role.
const youTag = '<span class="role-tag">You</span>';

const intro = `
  <div class="card">
    <h2>MCTL Rewards — guide</h2>
    <p class="muted">A Telegram loyalty program. Earn points across partner places and spend them
    on rewards. One balance works everywhere in the community.</p>
  </div>`;

const customer = (you: boolean): string => `
  <div class="card">
    <h3>For customers${you ? youTag : ''}</h3>
    <ol>
      <li>Open the bot and tap <b>Open</b> to launch the app.</li>
      <li>Show your personal <b>QR code</b> to the staff. It rotates every ~30 seconds and is
          single-use — a screenshot of it cannot be reused.</li>
      <li>Points land on your single <b>balance</b> and you get a Telegram notification.</li>
      <li>Open <b>Rewards</b> and tap a reward to redeem it (points are reserved immediately).
          Show the confirmation to staff to receive it.</li>
      <li><b>History</b> lists every earn and spend.</li>
    </ol>
  </div>`;

const staff = (you: boolean): string => `
  <div class="card">
    <h3>For staff (scanners)${you ? youTag : ''}</h3>
    <p class="muted">Open the bot, tap <b>Open</b>, then go to <b>Admin</b>. Staff land on a tabbed
    panel that shows only the merchant(s) you work for.</p>
    <ol>
      <li>On the <b>Scan</b> tab, pick your merchant (preselected if you have one).</li>
      <li>Tap <b>Scan to award</b>, scan the customer's QR, then tap the <b>accrual rule</b>
          (Visit, Purchase, …). Points are credited instantly; daily limits per merchant prevent farming.</li>
      <li>To hand over a reward, tap <b>Scan redemption</b> and scan the redemption QR the customer shows.</li>
      <li>The <b>Requests</b> tab lists redemptions you can <b>Fulfill</b> or <b>Cancel</b>
          (cancel returns the points and restocks).</li>
    </ol>
  </div>`;

const owner = (you: boolean): string => `
  <div class="card">
    <h3>For cafe owners (merchant admins)${you ? youTag : ''}</h3>
    <p class="muted">Beyond <b>Scan</b> and <b>Requests</b>, you get two more tabs for your place:</p>
    <ol>
      <li><b>Staff</b> — add a <b>scanner</b> or <b>admin</b> by Telegram ID (ask them to copy the
          <code>ID: …</code> line from their profile screen), or remove one. One employee belongs to
          <b>only one</b> merchant.</li>
      <li><b>Rules</b> — create and manage <b>your own accrual rules</b> (fixed points, with a
          required daily limit). You only ever see and edit your own merchant's rules. Rules are
          <b>deactivated</b>, never deleted, so daily-limit history is preserved.</li>
    </ol>
  </div>`;

const superAdmin = (you: boolean): string => `
  <div class="card">
    <h3>For the platform owner (super-admin)${you ? youTag : ''}</h3>
    <p class="muted">You can act for <b>any</b> merchant and get an extra <b>Program</b> tab:</p>
    <ol>
      <li><b>Create merchants</b> and assign each one's admin; add staff to any merchant.</li>
      <li>Create <b>global accrual rules</b> (apply at every merchant) and review every merchant's
          rules together in one list.</li>
      <li>Publish the <b>rewards</b> catalog — points cost and optional stock.</li>
    </ol>
  </div>`;

const publicNote = `
  <div class="card">
    <p class="muted">Staff and owner guides appear here when you open this inside the Telegram bot.</p>
  </div>`;

const backLink = `<div class="links"><a class="link" href="/app">← Back to app</a></div>`;

export async function renderDocs(root: HTMLElement): Promise<void> {
  let authed = false;
  let isSuper = false;
  let isStaff = false;
  let isAdmin = false;
  try {
    const me = await api.get<Me>('/me');
    authed = true;
    isSuper = me.super_admin;
    if (isSuper) {
      isStaff = true;
      isAdmin = true;
    } else {
      try {
        const { merchants } = await api.get<{ merchants: Merchant[] }>('/staff/merchants');
        isStaff = merchants.length > 0;
        isAdmin = merchants.some((m) => m.role === 'admin');
      } catch {
        /* not staff */
      }
    }
  } catch {
    authed = false; // public browser view
  }

  // Mark the section matching the caller's most-specific role with a "You" badge.
  const you = isSuper ? 'super' : isAdmin ? 'owner' : isStaff ? 'staff' : 'customer';
  const out = [intro, customer(you === 'customer')];
  if (isStaff) out.push(staff(you === 'staff'));
  if (isAdmin) out.push(owner(you === 'owner'));
  if (isSuper) out.push(superAdmin(you === 'super'));
  if (!authed) out.push(publicNote);
  out.push(backLink);
  root.innerHTML = out.join('');
}
