import { api } from './api.js';
import { alertMsg, scanQr, startMerchantId } from './tg.js';

interface Me {
  super_admin: boolean;
}
interface Merchant {
  id: number;
  name: string;
  type: string;
  role: string;
}
interface Rule {
  id: number;
  name: string;
  point_value: number;
  daily_limit: number | null;
}
interface ManagedRule {
  id: number;
  merchant_id: number | null;
  merchant_name: string | null;
  name: string;
  kind: string;
  point_value: number;
  daily_limit: number | null;
  active: boolean;
}
interface Redemption {
  id: number;
  status: string;
  cost: number;
  reward_title: string;
  username: string | null;
  telegram_id: number;
  created_at: string;
}
interface Member {
  user_id: number;
  telegram_id: number;
  username: string | null;
  role: string;
}

let activeMerchant: number | null = null;
let merchants: Merchant[] = [];
let isSuper = false;
let deepLinkApplied = false; // apply a `startapp=merchant_<id>` preselect at most once

function activeRole(): string | null {
  return merchants.find((m) => m.id === activeMerchant)?.role ?? null;
}

export async function renderAdmin(root: HTMLElement): Promise<void> {
  const me = await api.get<Me>('/me');
  isSuper = me.super_admin;
  merchants = (await api.get<{ merchants: Merchant[] }>('/staff/merchants')).merchants;

  if (!merchants.length && !isSuper) {
    root.innerHTML = '<div class="card">You have no merchant access.</div><a class="link" href="/docs">Help &amp; guide</a>';
    return;
  }
  // Deep-link preselect: if the caller opened a merchant Direct Link and is staff
  // of that merchant, focus it (once per session, so manual changes stick after).
  const startId = startMerchantId();
  if (!deepLinkApplied && startId !== null && merchants.some((m) => m.id === startId)) {
    activeMerchant = startId;
    deepLinkApplied = true;
  }
  if (activeMerchant === null && merchants.length) activeMerchant = merchants[0]!.id;

  root.innerHTML = `
    <div class="card">
      <h3>Scanning</h3>
      <label>Merchant
        <select id="merchant">${merchants.map((m) => `<option value="${m.id}">${esc(m.name)} (${m.role})</option>`).join('')}</select>
      </label>
      <button id="scan" class="primary">Scan to award</button>
      <button id="scan-redeem" class="primary">Scan redemption</button>
    </div>
    <div class="card"><h3>Redemption requests</h3><div id="redemptions">Loading…</div></div>
    <div class="card" id="staff-card"><h3>Staff</h3><div id="staff">Loading…</div></div>
    <div class="card" id="rules-card"><h3>Accrual rules</h3><div id="rules">Loading…</div></div>
    ${isSuper ? superAdminPanels(merchants) : ''}
    <a class="link" href="/app">← My profile</a>
    <a class="link" href="/docs">Help &amp; guide</a>
  `;

  const select = root.querySelector<HTMLSelectElement>('#merchant')!;
  if (activeMerchant) select.value = String(activeMerchant);
  select.addEventListener('change', () => {
    activeMerchant = Number(select.value);
    void loadStaff(root);
    void loadRules(root);
  });

  root.querySelector<HTMLButtonElement>('#scan')!.addEventListener('click', () => void doScan());
  root.querySelector<HTMLButtonElement>('#scan-redeem')!.addEventListener('click', () => void doRedeemScan(root));

  await loadRedemptions(root);
  await loadStaff(root);
  await loadRules(root);
  if (isSuper) wireSuperAdmin(root);
}

async function doScan(): Promise<void> {
  if (!activeMerchant) {
    alertMsg('Select a merchant');
    return;
  }
  const token = await scanQr();
  if (!token) return;
  try {
    const { rules } = await api.get<{ rules: Rule[] }>(`/merchants/${activeMerchant}/rules`);
    if (!rules.length) {
      alertMsg('No accrual rules. Create one first.');
      return;
    }
    let rule = rules[0]!;
    if (rules.length > 1) {
      const choice = window.prompt(
        'Rule:\n' + rules.map((r, i) => `${i + 1}. ${r.name} (+${r.point_value})`).join('\n'),
        '1',
      );
      if (choice === null) return; // cancelled — abort the scan
      const idx = Number(choice) - 1;
      if (rules[idx]) rule = rules[idx]!;
    }
    const r = await api.post<{ delta: number; balance: number }>(`/merchants/${activeMerchant}/scan`, {
      token,
      rule_id: rule.id,
    });
    alertMsg(`Awarded +${r.delta}. Customer balance: ${r.balance}`);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

// Scan a customer's redemption QR to capture (fulfill) the reward.
async function doRedeemScan(root: HTMLElement): Promise<void> {
  if (!activeMerchant) {
    alertMsg('Select a merchant');
    return;
  }
  const token = await scanQr();
  if (!token) return;
  try {
    const r = await api.post<{ rewardTitle: string; cost: number }>(
      `/merchants/${activeMerchant}/redeem-scan`,
      { token },
    );
    alertMsg(`Reward fulfilled: ${r.rewardTitle} (-${r.cost})`);
    await loadRedemptions(root);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

async function loadRedemptions(root: HTMLElement): Promise<void> {
  const el = root.querySelector('#redemptions');
  if (!el) return;
  // Manual fulfill/cancel are admin-only overrides; scanners use "Scan
  // redemption" and see the list read-only.
  const canManage = isSuper || activeRole() === 'admin';
  const { redemptions } = await api.get<{ redemptions: Redemption[] }>('/redemptions');
  el.innerHTML = redemptions.length
    ? redemptions
        .map(
          (r) => `<div class="row">
            <div><b>${esc(r.reward_title)}</b> — ${r.cost}
              <div class="muted">${r.username ? '@' + esc(r.username) : 'id ' + r.telegram_id} · ${r.status}</div></div>
            ${
              r.status === 'pending' && canManage
                ? `<span><button class="ghost" data-fulfill="${r.id}">Fulfill manually</button> <button data-cancel="${r.id}">Cancel</button></span>`
                : ''
            }
          </div>`,
        )
        .join('')
    : '<div class="muted">No requests</div>';
  el.querySelectorAll<HTMLButtonElement>('button[data-fulfill]').forEach((b) =>
    b.addEventListener('click', () => {
      const reason = window.prompt('Reason for manual fulfill:');
      if (!reason) return; // empty/cancelled — abort
      void act(`/redemptions/${b.dataset.fulfill}/fulfill`, root, { reason });
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => void act(`/redemptions/${b.dataset.cancel}/cancel`, root)),
  );
}

async function act(path: string, root: HTMLElement, body?: unknown): Promise<void> {
  try {
    await api.post(path, body);
    await loadRedemptions(root);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

// Staff management for the active merchant. Visible to its admins (and super-admins).
async function loadStaff(root: HTMLElement): Promise<void> {
  const card = root.querySelector<HTMLElement>('#staff-card');
  const el = root.querySelector<HTMLElement>('#staff');
  if (!card || !el) return;
  const canManage = isSuper || activeRole() === 'admin';
  if (!activeMerchant || !canManage) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  let members: Member[] = [];
  try {
    members = (await api.get<{ members: Member[] }>(`/merchants/${activeMerchant}/members`)).members;
  } catch {
    members = [];
  }
  const roleOptions = isSuper
    ? '<option value="scanner">scanner</option><option value="admin">admin</option>'
    : '<option value="scanner">scanner</option>';
  el.innerHTML = `
    <div class="muted">Ask the employee to open the bot and copy their ID from their profile screen.</div>
    ${
      members.length
        ? members
            .map(
              (m) => `<div class="row">
        <div>${m.username ? '@' + esc(m.username) : 'id ' + m.telegram_id}<div class="muted">${m.role} · id ${m.telegram_id}</div></div>
        ${m.role === 'scanner' || isSuper ? `<button data-remove="${m.user_id}">Remove</button>` : ''}
      </div>`,
            )
            .join('')
        : '<div class="muted">No staff yet</div>'
    }
    <fieldset><legend>Add staff</legend>
      <input id="st-tg" placeholder="telegram_id" inputmode="numeric" />
      <select id="st-role">${roleOptions}</select>
      <button id="st-add">Add</button>
    </fieldset>
  `;
  el.querySelectorAll<HTMLButtonElement>('button[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api.del(`/merchants/${activeMerchant}/members/${b.dataset.remove}`);
        await loadStaff(root);
      } catch (err) {
        alertMsg((err as Error).message);
      }
    }),
  );
  el.querySelector('#st-add')?.addEventListener('click', async () => {
    const tg = Number((root.querySelector<HTMLInputElement>('#st-tg')!).value.trim());
    const role = (root.querySelector<HTMLSelectElement>('#st-role')!).value;
    try {
      await api.post(`/merchants/${activeMerchant}/members`, { telegram_id: tg, role });
      await loadStaff(root);
    } catch (err) {
      alertMsg((err as Error).message);
    }
  });
}

// Per-merchant accrual rules for the active merchant. Lists/creates/deletes that
// merchant's OWN rules only (globals are managed in the super-admin "All accrual
// rules" panel). Visible to its admins and super-admins.
async function loadRules(root: HTMLElement): Promise<void> {
  const card = root.querySelector<HTMLElement>('#rules-card');
  const el = root.querySelector<HTMLElement>('#rules');
  if (!card || !el) return;
  const canManage = isSuper || activeRole() === 'admin';
  if (!activeMerchant || !canManage) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  let rules: ManagedRule[] = [];
  try {
    rules = (await api.get<{ rules: ManagedRule[] }>(`/merchants/${activeMerchant}/manage-rules`)).rules;
  } catch {
    rules = [];
  }
  el.innerHTML = `
    <div class="muted">This merchant's own accrual rules. Global rules are available to every merchant but are managed by a super-admin.</div>
    ${
      rules.length
        ? rules
            .map(
              (r) => `<div class="row">
        <div>${esc(r.name)} <span class="muted">+${r.point_value}${r.daily_limit != null ? ` · max ${r.daily_limit}/day` : ''}${r.active ? '' : ' · inactive'}</span></div>
        <button data-rule-del="${r.id}">Remove</button>
      </div>`,
            )
            .join('')
        : '<div class="muted">No rules yet</div>'
    }
    <fieldset><legend>Add rule</legend>
      <input id="ru-name" placeholder="e.g. Visit" />
      <input id="ru-points" placeholder="Points" inputmode="numeric" />
      <input id="ru-limit" placeholder="Daily limit (empty = none)" inputmode="numeric" />
      <button id="ru-add">Add</button>
    </fieldset>
  `;
  el.querySelectorAll<HTMLButtonElement>('button[data-rule-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api.del(`/merchants/${activeMerchant}/rules/${b.dataset.ruleDel}`);
        await loadRules(root);
      } catch (err) {
        alertMsg((err as Error).message);
      }
    }),
  );
  el.querySelector('#ru-add')?.addEventListener('click', async () => {
    const name = (root.querySelector<HTMLInputElement>('#ru-name')!).value.trim();
    const points = Number((root.querySelector<HTMLInputElement>('#ru-points')!).value.trim());
    const limitRaw = (root.querySelector<HTMLInputElement>('#ru-limit')!).value.trim();
    try {
      await api.post(`/merchants/${activeMerchant}/manage-rules`, {
        name,
        kind: 'fixed',
        point_value: points,
        daily_limit: limitRaw === '' ? null : Number.parseInt(limitRaw, 10),
      });
      await loadRules(root);
    } catch (err) {
      alertMsg((err as Error).message);
    }
  });
}

function superAdminPanels(ms: Merchant[]): string {
  const opts = ms.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  return `
    <div class="card"><h3>Super-admin</h3>
      <fieldset><legend>New merchant</legend>
        <input id="m-name" placeholder="Name" />
        <select id="m-type"><option>shop</option><option>cafe</option><option>event</option><option>community</option></select>
        <button id="m-create">Create</button>
      </fieldset>
      <fieldset><legend>Add staff (any merchant)</legend>
        <select id="mm-merchant">${opts}</select>
        <input id="mm-tg" placeholder="telegram_id" inputmode="numeric" />
        <select id="mm-role"><option>scanner</option><option>admin</option></select>
        <button id="mm-add">Add</button>
      </fieldset>
      <fieldset><legend>Accrual rule</legend>
        <input id="r-name" placeholder="e.g. Visit" />
        <input id="r-points" placeholder="Points" inputmode="numeric" />
        <input id="r-limit" placeholder="Daily limit (empty = none)" inputmode="numeric" />
        <button id="r-create">Create (global)</button>
      </fieldset>
      <fieldset><legend>Reward</legend>
        <input id="rw-title" placeholder="Title" />
        <input id="rw-cost" placeholder="Cost" inputmode="numeric" />
        <input id="rw-stock" placeholder="Stock (empty = ∞)" inputmode="numeric" />
        <button id="rw-create">Create (global)</button>
      </fieldset>
    </div>
    <div class="card"><h3>All accrual rules</h3><div id="all-rules">Loading…</div></div>`;
}

// Cross-merchant rule list for super-admins: every merchant's own rules + globals,
// labeled with the owning merchant. Super-admins can delete any rule here.
async function loadAllRules(root: HTMLElement): Promise<void> {
  const el = root.querySelector<HTMLElement>('#all-rules');
  if (!el) return;
  let rules: ManagedRule[] = [];
  try {
    rules = (await api.get<{ rules: ManagedRule[] }>('/admin/rules')).rules;
  } catch (err) {
    el.innerHTML = `<div class="muted">${esc((err as Error).message)}</div>`;
    return;
  }
  el.innerHTML = rules.length
    ? rules
        .map(
          (r) => `<div class="row">
        <div>${esc(r.name)} <span class="muted">+${r.point_value}${r.daily_limit != null ? ` · max ${r.daily_limit}/day` : ''}${r.active ? '' : ' · inactive'}</span>
          <div class="muted">${r.merchant_id == null ? 'Global' : esc(r.merchant_name ?? 'merchant ' + r.merchant_id)}</div></div>
        <button data-all-rule-del="${r.id}">Remove</button>
      </div>`,
        )
        .join('')
    : '<div class="muted">No rules</div>';
  el.querySelectorAll<HTMLButtonElement>('button[data-all-rule-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api.del(`/admin/rules/${b.dataset.allRuleDel}`);
        await loadAllRules(root);
      } catch (err) {
        alertMsg((err as Error).message);
      }
    }),
  );
}

function wireSuperAdmin(root: HTMLElement): void {
  const val = (id: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(id)!.value.trim();
  const intOrNull = (v: string) => (v === '' ? null : Number.parseInt(v, 10));

  void loadAllRules(root);

  root.querySelector('#m-create')?.addEventListener('click', () =>
    submit(() => api.post('/admin/merchants', { name: val('#m-name'), type: val('#m-type') }), root),
  );
  root.querySelector('#mm-add')?.addEventListener('click', () =>
    submit(
      () =>
        api.post(`/admin/merchants/${val('#mm-merchant')}/members`, {
          telegram_id: Number(val('#mm-tg')),
          role: val('#mm-role'),
        }),
      root,
    ),
  );
  root.querySelector('#r-create')?.addEventListener('click', () =>
    submit(
      () =>
        api.post('/admin/rules', {
          name: val('#r-name'),
          kind: 'fixed',
          point_value: Number(val('#r-points')),
          daily_limit: intOrNull(val('#r-limit')),
        }),
      root,
    ),
  );
  root.querySelector('#rw-create')?.addEventListener('click', () =>
    submit(
      () =>
        api.post('/admin/rewards', {
          title: val('#rw-title'),
          cost: Number(val('#rw-cost')),
          stock: intOrNull(val('#rw-stock')),
        }),
      root,
    ),
  );
}

async function submit(fn: () => Promise<unknown>, root: HTMLElement): Promise<void> {
  try {
    await fn();
    alertMsg('Done');
    await renderAdmin(root);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
