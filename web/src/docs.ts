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
    <ol>
      <li>Open the app and go to <b>Admin panel</b>. You only see the merchant you work for.</li>
      <li>Pick the <b>merchant</b> (preselected if you have one) and tap <b>Scan QR</b>.</li>
      <li>Scan the customer's QR and choose the <b>accrual rule</b> (e.g. Visit, Purchase).</li>
      <li>Points are awarded instantly. Daily limits per rule prevent farming.</li>
      <li>Under <b>Redemption requests</b> you can <b>Fulfill</b> or <b>Cancel</b> a redemption
          (cancel returns the points).</li>
    </ol>
  </div>`;

const owner = (you: boolean): string => `
  <div class="card">
    <h3>For cafe owners (merchant admins)${you ? youTag : ''}</h3>
    <ol>
      <li>In the <b>Admin panel</b> open the <b>Staff</b> section for your place.</li>
      <li>Ask your employee to open the bot and copy their <b>ID</b> from their profile screen
          (the <code>ID: …</code> line with a Copy button).</li>
      <li>Enter that <b>telegram_id</b> and tap <b>Add</b> to make them a scanner. Remove them
          anytime.</li>
      <li>One employee can belong to <b>only one</b> merchant.</li>
    </ol>
  </div>`;

const superAdmin = (you: boolean): string => `
  <div class="card">
    <h3>For the platform owner (super-admin)${you ? youTag : ''}</h3>
    <p>Create merchants, accrual rules and the rewards catalog, and assign each merchant's admin.
    Super-admins can manage staff for any merchant.</p>
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
