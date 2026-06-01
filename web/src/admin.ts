// Staff /admin — Direction C, role-based tabbed Mini App (vanilla TS).
// One persistent shell (scroll + in-DOM MainBar + bottom tab bar); tabs swap the
// scroll content. Roles: scanner (2 tabs) / merchant-admin (4) / super (5).
// All backend contracts are unchanged from the previous implementation.
import { api } from './api.js';
import { scanQr, startMerchantId, showBackButton } from './tg.js';
import {
  esc,
  icon,
  sectionLabel,
  avatarFor,
  emptyState,
  skeleton,
  field,
  segmented,
  presetsFill,
  segValue,
  openSheet,
  openDialog,
  toast,
  closeOverlays,
  submitOnce,
} from './ui.js';

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

type Tab = 'scan' | 'requests' | 'staff' | 'rules' | 'program';
interface TabDef {
  id: Tab;
  icon: string;
  label: string;
}
const SCANNER_TABS: TabDef[] = [
  { id: 'scan', icon: 'qr', label: 'Scan' },
  { id: 'requests', icon: 'list', label: 'Requests' },
];
const ADMIN_TABS: TabDef[] = [
  ...SCANNER_TABS,
  { id: 'staff', icon: 'people', label: 'Staff' },
  { id: 'rules', icon: 'bolt', label: 'Rules' },
];
const SUPER_TABS: TabDef[] = [...ADMIN_TABS, { id: 'program', icon: 'grid', label: 'Program' }];

const STATUS_TONE: Record<string, string> = {
  pending: 'accent',
  fulfilled: 'success',
  cancelled: 'muted',
  expired: 'danger',
};

let merchants: Merchant[] = [];
let isSuper = false;
let activeMerchant: number | null = null;
let activeTab: Tab = 'scan';
let requestsFilter = 'all';
let deepLinkApplied = false; // apply a `startapp=merchant_<id>` preselect at most once
let backCleanup: (() => void) | null = null;

// SPA navigation (reuses main.ts's popstate route handler).
function navigateTo(path: string): void {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// Hide the native BackButton + detach its handler when leaving /admin. Called
// from main.ts on every route change (no-op when nothing is wired).
export function teardownAdmin(): void {
  backCleanup?.();
  backCleanup = null;
}

function activeRole(): string | null {
  return merchants.find((m) => m.id === activeMerchant)?.role ?? null;
}
function currentMerchant(): Merchant | null {
  return merchants.find((m) => m.id === activeMerchant) ?? null;
}
function canManage(): boolean {
  return isSuper || activeRole() === 'admin';
}
function tabsFor(): TabDef[] {
  if (isSuper) return SUPER_TABS;
  if (activeRole() === 'admin') return ADMIN_TABS;
  return SCANNER_TABS;
}
function normStatus(s: string): string {
  return s.startsWith('cancelled') ? 'cancelled' : s;
}
function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
}
function errToast(err: unknown): void {
  toast({ title: (err as Error).message, tone: 'danger' });
}

export async function renderAdmin(root: HTMLElement): Promise<void> {
  closeOverlays();
  // /me and /staff/merchants are independent — issue them together.
  const [me, mResp] = await Promise.all([
    api.get<Me>('/me'),
    api.get<{ merchants: Merchant[] }>('/staff/merchants'),
  ]);
  isSuper = me.super_admin;
  merchants = mResp.merchants;

  if (!merchants.length && !isSuper) {
    renderNoAccess(root);
    return;
  }
  // Telegram has no browser chrome, so wire the native BackButton back to the
  // member profile (no-op outside Telegram, where the in-shell links suffice).
  teardownAdmin();
  backCleanup = showBackButton(() => navigateTo('/app'));
  // Deep-link preselect: focus a merchant opened via a Direct Link, once per
  // session, so manual switches stick afterwards.
  const startId = startMerchantId();
  if (!deepLinkApplied && startId !== null && merchants.some((m) => m.id === startId)) {
    activeMerchant = startId;
    deepLinkApplied = true;
  }
  if (activeMerchant === null && merchants.length) activeMerchant = merchants[0]!.id;
  // Keep the active tab valid for the current role.
  if (!tabsFor().some((t) => t.id === activeTab)) activeTab = 'scan';

  root.innerHTML = `
    <div class="m-app">
      <div class="m-scroll" id="m-content"></div>
      <div class="m-mainbar" id="m-mainbar" style="display:none"></div>
      <nav class="m-tabbar" id="m-tabbar"></nav>
    </div>`;
  renderTabBar(root);
  await applyTab(root);
}

// Re-fetch the merchant list and re-render the current tab. Used after creating
// a merchant so dependent UI (counter switcher, "add staff to any" picker) is
// current within the same session.
async function refreshMerchants(root: HTMLElement): Promise<void> {
  try {
    merchants = (await api.get<{ merchants: Merchant[] }>('/staff/merchants')).merchants;
  } catch (err) {
    errToast(err);
    return;
  }
  if (activeMerchant === null && merchants.length) activeMerchant = merchants[0]!.id;
  await applyTab(root);
}

function renderNoAccess(root: HTMLElement): void {
  root.innerHTML = `
    <div class="m-app"><div class="m-scroll">
      <div class="m-state">
        <div class="m-icon-circle lg">${icon('store', { size: 24 })}</div>
        <div class="h">No merchant access</div>
        <div class="p">You're not staff at any merchant yet. Ask a merchant admin to add your Telegram ID.</div>
        <div class="links" style="margin-top:22px"><a class="link" href="/app">← My profile</a> <a class="link" href="/docs">Help &amp; guide</a></div>
      </div>
    </div></div>`;
}

function renderTabBar(root: HTMLElement): void {
  const bar = root.querySelector<HTMLElement>('#m-tabbar')!;
  const tabs = tabsFor();
  bar.innerHTML = tabs
    .map(
      (t) =>
        `<button class="m-tab${t.id === activeTab ? ' active' : ''}" data-tab="${t.id}">${icon(t.icon, { size: 22, stroke: t.id === activeTab ? 1.9 : 1.6 })}<span>${esc(t.label)}</span></button>`,
    )
    .join('');
  bar.querySelectorAll<HTMLButtonElement>('.m-tab').forEach((b) =>
    b.addEventListener('click', () => {
      const next = b.dataset.tab as Tab;
      if (next === activeTab) return;
      activeTab = next;
      closeOverlays();
      renderTabBar(root);
      void applyTab(root);
    }),
  );
}

function setMainBar(root: HTMLElement, html: string): void {
  const bar = root.querySelector<HTMLElement>('#m-mainbar')!;
  bar.innerHTML = html;
  bar.style.display = html ? '' : 'none';
}

function content(root: HTMLElement): HTMLElement {
  return root.querySelector<HTMLElement>('#m-content')!;
}

// Dispatch to the active tab loader; each fully renders content + main bar.
async function applyTab(root: HTMLElement): Promise<void> {
  content(root).scrollTop = 0;
  switch (activeTab) {
    case 'scan':
      renderScanTab(root);
      break;
    case 'requests':
      await loadRequests(root);
      break;
    case 'staff':
      await loadStaff(root);
      break;
    case 'rules':
      await loadRules(root);
      break;
    case 'program':
      await loadProgram(root);
      break;
  }
}

// ---------------------------------------------------------------- Scan tab
function renderScanTab(root: HTMLElement): void {
  const m = currentMerchant();
  const multi = merchants.length > 1;
  if (!m) {
    content(root).innerHTML =
      sectionLabel('Counter') +
      emptyState(
        'store',
        'No merchant selected',
        isSuper
          ? 'Create a merchant in the Program tab, then add yourself as staff to scan here.'
          : 'Ask a merchant admin to add your Telegram ID.',
      );
    setMainBar(root, '');
    return;
  }
  const roleWord = m.role === 'scanner' ? 'a scanner' : m.role === 'admin' ? 'an admin' : 'a super-admin';
  content(root).innerHTML = `
    ${sectionLabel('Counter')}
    <button class="m-selector${multi ? ' tappable' : ''}" id="m-merchant">
      ${icon('store', { size: 19 })}
      <span class="grow"><span class="val">${esc(m.name)}</span><span class="sub">${multi ? 'Tap to switch merchant' : `You're ${roleWord} here`}</span></span>
      ${multi ? icon('chevron', { size: 17 }) : `<span class="m-tag">${esc(m.role)}</span>`}
    </button>
    <div class="m-spacer"></div>
    <div class="m-card"><div class="m-scan-hero">
      <div class="frame">${icon('qr', { size: 42, stroke: 1.5 })}</div>
      <div class="h">Ready to scan</div>
      <div class="p">Tap <b>Scan to award</b>, point at the member's rotating QR, then pick an accrual rule. Points credit instantly.</div>
    </div></div>
    <div class="links" style="margin-top:18px;justify-content:center">
      <a class="link" href="/app">← My profile</a>
      <a class="link" href="/docs">Help &amp; guide</a>
    </div>`;
  setMainBar(
    root,
    `<button class="m-mainbtn secondary" id="m-scan-redeem">Scan redemption</button>
     <button class="m-mainbtn" id="m-scan-award">${icon('qr', { size: 19, stroke: 1.8 })}Scan to award</button>`,
  );
  if (multi) {
    content(root)
      .querySelector('#m-merchant')!
      .addEventListener('click', () => openMerchantSheet(root));
  }
  root.querySelector('#m-scan-award')!.addEventListener('click', () => void doScanAward(root));
  root.querySelector('#m-scan-redeem')!.addEventListener('click', () => void doRedeemScan());
}

function openMerchantSheet(root: HTMLElement): void {
  const rows = merchants
    .map(
      (m) =>
        `<button class="m-pick${m.id === activeMerchant ? ' active' : ''}" data-id="${m.id}">
          ${icon('store', { size: 18 })}<span class="grow">${esc(m.name)}</span>
          <span class="m-tag">${esc(m.role)}</span>${m.id === activeMerchant ? icon('check', { size: 17, stroke: 2 }) : ''}
        </button>`,
    )
    .join('');
  const { el, close } = openSheet(`<div class="h" style="margin-bottom:16px">Switch merchant</div><div class="m-pick-list">${rows}</div>`);
  el.querySelectorAll<HTMLButtonElement>('.m-pick').forEach((b) =>
    b.addEventListener('click', () => {
      activeMerchant = Number(b.dataset.id);
      close();
      renderScanTab(root);
    }),
  );
}

async function doScanAward(root: HTMLElement): Promise<void> {
  if (!activeMerchant) return;
  const token = await scanQr();
  if (!token) return;
  let rules: Rule[];
  try {
    rules = (await api.get<{ rules: Rule[] }>(`/merchants/${activeMerchant}/rules`)).rules;
  } catch (err) {
    errToast(err);
    return;
  }
  if (!rules.length) {
    toast({ title: 'No accrual rules', sub: 'Create one in the Rules tab first.', tone: 'danger' });
    return;
  }
  if (rules.length === 1) {
    openAwardConfirm(root, token, rules[0]!);
    return;
  }
  // Multiple rules: tap-select before awarding.
  const list = rules
    .map(
      (r) =>
        `<button class="m-program-action" data-rule="${r.id}">
          <span class="grow"><span class="title">${esc(r.name)}</span>${r.daily_limit != null ? `<span class="sub">Daily limit: ${r.daily_limit} / day</span>` : '<span class="sub">No daily limit</span>'}</span>
          <span class="m-pill accent sm">+${r.point_value} pts</span>
        </button>`,
    )
    .join('');
  const { el, close } = openSheet(`<div class="h" style="margin-bottom:16px">Choose an accrual rule</div><div class="m-stack">${list}</div>`);
  el.querySelectorAll<HTMLButtonElement>('[data-rule]').forEach((b) =>
    b.addEventListener('click', () => {
      const rule = rules.find((r) => r.id === Number(b.dataset.rule))!;
      close();
      openAwardConfirm(root, token, rule);
    }),
  );
}

function openAwardConfirm(root: HTMLElement, token: string, rule: Rule): void {
  const { el, close } = openSheet(
    `<div class="h">Award +${rule.point_value} points?</div>
     <div class="sub" style="margin-top:8px">Rule <b>${esc(rule.name)}</b>${rule.daily_limit != null ? ` · max ${rule.daily_limit}/day` : ''}. Points credit immediately and the member gets a Telegram notification.</div>
     <button class="m-mainbtn" id="m-award-go">Award +${rule.point_value} pts</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-award-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      try {
        const r = await api.post<{ delta: number; balance: number }>(`/merchants/${activeMerchant}/scan`, {
          token,
          rule_id: rule.id,
        });
        close();
        toast({ title: `Awarded +${r.delta}`, sub: `Member balance: ${r.balance}`, tone: 'success' });
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

async function doRedeemScan(): Promise<void> {
  if (!activeMerchant) return;
  const token = await scanQr();
  if (!token) return;
  try {
    const r = await api.post<{ rewardTitle: string; cost: number }>(
      `/merchants/${activeMerchant}/redeem-scan`,
      { token },
    );
    toast({ title: `Fulfilled: ${r.rewardTitle}`, sub: `−${r.cost} points`, tone: 'success' });
    // The Requests tab re-fetches on entry (applyTab), so no refresh needed here.
  } catch (err) {
    errToast(err);
  }
}

// ---------------------------------------------------------------- Requests tab
async function loadRequests(root: HTMLElement): Promise<void> {
  setMainBar(root, '');
  const el = content(root);
  el.innerHTML = sectionLabel('Redemption requests') + skeleton('100%', 64, 8) + skeleton('100%', 64, 10);
  let redemptions: Redemption[];
  try {
    redemptions = (await api.get<{ redemptions: Redemption[] }>('/redemptions')).redemptions;
  } catch (err) {
    if (activeTab !== 'requests') return;
    el.innerHTML = sectionLabel('Redemption requests') + emptyState('alert', "Couldn't load requests", (err as Error).message);
    return;
  }
  if (activeTab !== 'requests') return; // tab switched mid-load — don't clobber
  const filters = ['all', 'pending', 'fulfilled', 'cancelled', 'expired'];
  const list = redemptions.filter((r) => requestsFilter === 'all' || normStatus(r.status) === requestsFilter);
  const manage = canManage();
  el.innerHTML =
    sectionLabel('Redemption requests', `${list.length} ${list.length === 1 ? 'request' : 'requests'}`) +
    `<div class="m-filters">${filters
      .map((f) => `<button class="m-filter-chip${f === requestsFilter ? ' active' : ''}" data-filter="${f}">${f}</button>`)
      .join('')}</div>` +
    (list.length
      ? list
          .map((r, i) => {
            const st = normStatus(r.status);
            const who = r.username ? '@' + esc(r.username) : 'id ' + r.telegram_id;
            const actions =
              r.status === 'pending' && manage
                ? `<div class="m-req-actions"><button class="m-pill sm outline" data-fulfill="${r.id}">Fulfill</button><button class="m-pill sm line" data-cancel="${r.id}">Cancel</button></div>`
                : '';
            return `<div class="m-row${i === 0 ? ' first' : ''}">
              <div class="grow"><div class="title">${esc(r.reward_title)}</div>
                <div class="sub">${r.cost} pts · ${who} · ${fmt(r.created_at)}</div>${actions}</div>
              <span class="m-tag ${STATUS_TONE[st] ?? 'muted'}">${st}</span>
            </div>`;
          })
          .join('')
      : emptyState('list', 'Nothing here', `No ${requestsFilter} requests right now.`));

  el.querySelectorAll<HTMLButtonElement>('.m-filter-chip').forEach((b) =>
    b.addEventListener('click', () => {
      requestsFilter = b.dataset.filter!;
      void loadRequests(root);
    }),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-fulfill]').forEach((b) =>
    b.addEventListener('click', () => openFulfillSheet(root, Number(b.dataset.fulfill))),
  );
  el.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await openDialog({
        title: 'Cancel this redemption?',
        body: 'The member gets their points back and the reward stock is restored.',
        confirmLabel: 'Cancel redemption',
        cancelLabel: 'Keep it',
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await api.post(`/redemptions/${b.dataset.cancel}/cancel`);
        await loadRequests(root);
      } catch (err) {
        errToast(err);
      }
    }),
  );
}

function openFulfillSheet(root: HTMLElement, id: number): void {
  const { el, close } = openSheet(
    `<div class="h" style="margin-bottom:18px">Fulfill manually</div>
     <div class="m-formstack">${field({ id: 'm-fulfill-reason', label: 'Reason (required)', placeholder: 'e.g. handed over in person' })}</div>
     <button class="m-mainbtn" id="m-fulfill-go">Mark fulfilled</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-fulfill-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const reason = el.querySelector<HTMLInputElement>('#m-fulfill-reason')!.value.trim();
      if (!reason) {
        toast({ title: 'A reason is required', tone: 'danger' });
        return;
      }
      try {
        await api.post(`/redemptions/${id}/fulfill`, { reason });
        close();
        await loadRequests(root);
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

// ---------------------------------------------------------------- Staff tab
async function loadStaff(root: HTMLElement): Promise<void> {
  const m = currentMerchant();
  if (!m || !canManage()) {
    setMainBar(root, '');
    content(root).innerHTML = sectionLabel('Staff') + emptyState('people', 'No merchant', 'Select a merchant you administer to manage its staff.');
    return;
  }
  setMainBar(root, `<button class="m-mainbtn" id="m-add-staff">${icon('plus', { size: 19, stroke: 1.8 })}Add staff</button>`);
  const el = content(root);
  el.innerHTML = sectionLabel('Staff') + skeleton('100%', 56, 8) + skeleton('100%', 56, 10);
  let members: Member[] = [];
  try {
    members = (await api.get<{ members: Member[] }>(`/merchants/${m.id}/members`)).members;
  } catch (err) {
    if (activeTab !== 'staff' || activeMerchant !== m.id) return;
    el.innerHTML = sectionLabel('Staff') + emptyState('alert', "Couldn't load staff", (err as Error).message);
    return;
  }
  if (activeTab !== 'staff' || activeMerchant !== m.id) return; // switched mid-load
  el.innerHTML =
    sectionLabel('Staff', members.length ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : undefined) +
    `<div class="m-hint">Working at <b>${esc(m.name)}</b>. Ask the employee to open the bot and copy their Telegram ID from their profile.</div>` +
    (members.length
      ? members
          .map((s, i) => {
            const who = s.username ? '@' + esc(s.username) : 'id ' + s.telegram_id;
            const removable = s.role === 'scanner' || isSuper;
            return `<div class="m-row${i === 0 ? ' first' : ''}">
              ${avatarFor(s.username, s.telegram_id)}
              <div class="grow"><div class="title">${who}</div><div class="sub mono">ID ${s.telegram_id}</div></div>
              <span class="m-tag ${s.role === 'admin' ? 'accent' : 'muted'}">${esc(s.role)}</span>
              ${removable ? `<button class="m-iconbtn" data-remove="${s.user_id}" aria-label="Remove">${icon('trash', { size: 17 })}</button>` : ''}
            </div>`;
          })
          .join('')
      : emptyState('people', 'No staff yet', 'Add a scanner or admin by their Telegram ID to let them work the counter.'));

  root.querySelector('#m-add-staff')!.addEventListener('click', () => openAddStaffSheet(root, m));
  el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      const ok = await openDialog({
        title: 'Remove this staff member?',
        body: 'They lose access to this merchant immediately.',
        confirmLabel: 'Remove',
        tone: 'danger',
      });
      if (!ok) return;
      try {
        await api.del(`/merchants/${m.id}/members/${b.dataset.remove}`);
        await loadStaff(root);
      } catch (err) {
        errToast(err);
      }
    }),
  );
}

function openAddStaffSheet(root: HTMLElement, m: Merchant): void {
  const roleOpts = isSuper
    ? [
        { value: 'scanner', label: 'Scanner' },
        { value: 'admin', label: 'Admin' },
      ]
    : [{ value: 'scanner', label: 'Scanner' }];
  const { el, close } = openSheet(
    `<div class="h">Add staff</div>
     <div class="sub">${icon('store', { size: 14 })}Works at <b>${esc(m.name)}</b></div>
     <div class="m-formstack">
       ${field({ id: 'm-staff-id', label: 'Telegram ID', placeholder: 'e.g. 710244180', mono: true, numeric: true })}
       <div><div class="label" style="margin-bottom:7px">Role</div>${segmented('staff-role', roleOpts, 'scanner')}</div>
     </div>
     <button class="m-mainbtn" id="m-staff-go">Add staff</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-staff-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const tg = Number.parseInt(el.querySelector<HTMLInputElement>('#m-staff-id')!.value.trim(), 10);
      const role = segValue(el, 'staff-role');
      if (!Number.isFinite(tg) || tg <= 0) {
        toast({ title: 'Enter a valid Telegram ID', tone: 'danger' });
        return;
      }
      try {
        await api.post(`/merchants/${m.id}/members`, { telegram_id: tg, role });
        close();
        await loadStaff(root);
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

// ---------------------------------------------------------------- Rules tab
async function loadRules(root: HTMLElement): Promise<void> {
  const m = currentMerchant();
  if (!m || !canManage()) {
    setMainBar(root, '');
    content(root).innerHTML = sectionLabel('Accrual rules') + emptyState('bolt', 'No merchant', 'Select a merchant you administer to manage its rules.');
    return;
  }
  setMainBar(root, `<button class="m-mainbtn" id="m-new-rule">${icon('plus', { size: 19, stroke: 1.8 })}New rule</button>`);
  const el = content(root);
  el.innerHTML = sectionLabel('Accrual rules') + skeleton('100%', 56, 8) + skeleton('100%', 56, 10);
  let rules: ManagedRule[] = [];
  try {
    rules = (await api.get<{ rules: ManagedRule[] }>(`/merchants/${m.id}/manage-rules`)).rules;
  } catch (err) {
    if (activeTab !== 'rules' || activeMerchant !== m.id) return;
    el.innerHTML = sectionLabel('Accrual rules') + emptyState('alert', "Couldn't load rules", (err as Error).message);
    return;
  }
  if (activeTab !== 'rules' || activeMerchant !== m.id) return; // switched mid-load
  el.innerHTML =
    sectionLabel('Accrual rules', rules.length ? `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}` : undefined) +
    `<div class="m-hint">Rules for <b>${esc(m.name)}</b>. Staff pick one when awarding points. Global rules (set by a super-admin) also apply.</div>` +
    (rules.length
      ? rules.map((r, i) => ruleRow(r, i === 0)).join('')
      : emptyState('bolt', 'No rules yet', 'Create an accrual rule like Visit +50 so staff can award points.'));

  root.querySelector('#m-new-rule')!.addEventListener('click', () => openNewRuleSheet(root, m));
  wireRuleToggles(el, (id, active) => api.patch(`/merchants/${m.id}/rules/${id}`, { active }), () => loadRules(root));
}

function ruleRow(r: ManagedRule, first: boolean): string {
  const meta = `+${r.point_value}${r.daily_limit != null ? ` · max ${r.daily_limit}/day` : ''}${r.active ? '' : ' · inactive'}`;
  return `<div class="m-row${first ? ' first' : ''}">
    <div class="grow"><div class="title">${esc(r.name)}</div><div class="sub">${meta}</div></div>
    <span class="m-pill outline sm">+${r.point_value}</span>
    <button class="m-pill line sm" data-toggle="${r.id}" data-active="${r.active ? '1' : '0'}">${r.active ? 'Deactivate' : 'Activate'}</button>
  </div>`;
}

// Toggle active (never hard-delete: a delete would cascade-wipe accrual history
// and reset daily-limit counts). Deactivation asks for confirmation.
function wireRuleToggles(
  el: HTMLElement,
  patch: (id: string, active: boolean) => Promise<unknown>,
  reload: () => Promise<void>,
): void {
  el.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      const id = b.dataset.toggle!;
      const isActive = b.dataset.active === '1';
      if (isActive) {
        const ok = await openDialog({
          title: 'Deactivate this rule?',
          body: 'Staff can no longer award points with it. You can reactivate it anytime.',
          confirmLabel: 'Deactivate',
          tone: 'danger',
        });
        if (!ok) return;
      }
      try {
        await patch(id, !isActive);
        await reload();
      } catch (err) {
        errToast(err);
      }
    }),
  );
}

function openNewRuleSheet(root: HTMLElement, m: Merchant): void {
  const { el, close } = openSheet(
    `<div class="h" style="margin-bottom:18px">New accrual rule</div>
     <div class="m-formstack">
       ${field({ id: 'm-rule-name', label: 'Name', placeholder: 'e.g. Visit' })}
       <div><div class="label" style="margin-bottom:7px">Points</div>${presetsFill([10, 20, 50, 100], 'm-rule-points', '+')}${field({ id: 'm-rule-points', placeholder: 'Points', numeric: true })}</div>
       ${field({ id: 'm-rule-limit', label: 'Daily limit per customer (required)', placeholder: 'e.g. 1', numeric: true })}
     </div>
     <button class="m-mainbtn" id="m-rule-go">Create rule</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-rule-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const name = el.querySelector<HTMLInputElement>('#m-rule-name')!.value.trim();
      const points = Number.parseInt(el.querySelector<HTMLInputElement>('#m-rule-points')!.value.trim(), 10);
      const limit = Number.parseInt(el.querySelector<HTMLInputElement>('#m-rule-limit')!.value.trim(), 10);
      if (!name) return toast({ title: 'Enter a rule name', tone: 'danger' });
      if (!Number.isFinite(points) || points <= 0) return toast({ title: 'Points must be a positive number', tone: 'danger' });
      if (!Number.isFinite(limit) || limit <= 0) return toast({ title: 'A positive daily limit is required', tone: 'danger' });
      try {
        await api.post(`/merchants/${m.id}/manage-rules`, { name, kind: 'fixed', point_value: points, daily_limit: limit });
        close();
        await loadRules(root);
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

// ---------------------------------------------------------------- Program tab (super)
async function loadProgram(root: HTMLElement): Promise<void> {
  setMainBar(root, '');
  const el = content(root);
  const actions = [
    { ic: 'store', title: 'New merchant', sub: 'Shop, café or venue', act: 'merchant' },
    { ic: 'people', title: 'Add staff to any merchant', sub: 'Scanner or admin by ID', act: 'staff' },
    { ic: 'bolt', title: 'Global accrual rule', sub: 'Applies across merchants', act: 'rule' },
    { ic: 'gift', title: 'Global reward', sub: 'Cost + optional stock', act: 'reward' },
  ];
  el.innerHTML =
    sectionLabel('Program control') +
    `<div class="m-stack">${actions
      .map(
        (a) =>
          `<button class="m-program-action" data-prog="${a.act}">
            <span class="badge">${icon(a.ic, { size: 20, stroke: 1.7 })}</span>
            <span class="grow"><span class="title">${a.title}</span><span class="sub">${a.sub}</span></span>
            ${icon('plus', { size: 18, stroke: 1.7 })}
          </button>`,
      )
      .join('')}</div>` +
    `<div class="m-spacer lg"></div>` +
    sectionLabel('All accrual rules') +
    `<div id="m-all-rules">${skeleton('100%', 56, 0)}${skeleton('100%', 56, 10)}</div>`;

  el.querySelector('[data-prog="merchant"]')!.addEventListener('click', () => openNewMerchantSheet(root));
  el.querySelector('[data-prog="staff"]')!.addEventListener('click', () => openAddStaffAnySheet());
  el.querySelector('[data-prog="rule"]')!.addEventListener('click', () => openGlobalRuleSheet(root));
  el.querySelector('[data-prog="reward"]')!.addEventListener('click', () => openGlobalRewardSheet());
  await loadAllRules(root);
}

// Cross-merchant rule list: every merchant's own rules + globals, labeled.
async function loadAllRules(root: HTMLElement): Promise<void> {
  const host = root.querySelector<HTMLElement>('#m-all-rules');
  if (!host) return;
  let rules: ManagedRule[];
  try {
    rules = (await api.get<{ rules: ManagedRule[] }>('/admin/rules')).rules;
  } catch (err) {
    host.innerHTML = `<div class="m-hint">${esc((err as Error).message)}</div>`;
    return;
  }
  host.innerHTML = rules.length
    ? rules
        .map((r, i) => {
          const owner = r.merchant_id == null ? 'Global' : esc(r.merchant_name ?? 'merchant ' + r.merchant_id);
          const meta = `+${r.point_value}${r.daily_limit != null ? ` · max ${r.daily_limit}/day` : ''}${r.active ? '' : ' · inactive'}`;
          return `<div class="m-row${i === 0 ? ' first' : ''}">
            <div class="grow"><div class="title">${esc(r.name)}</div><div class="sub">${owner} · ${meta}</div></div>
            <button class="m-pill line sm" data-toggle="${r.id}" data-active="${r.active ? '1' : '0'}">${r.active ? 'Deactivate' : 'Activate'}</button>
          </div>`;
        })
        .join('')
    : `<div class="m-hint">No rules yet.</div>`;
  wireRuleToggles(host, (id, active) => api.patch(`/admin/rules/${id}`, { active }), () => loadAllRules(root));
}

function openNewMerchantSheet(root: HTMLElement): void {
  const { el, close } = openSheet(
    `<div class="h" style="margin-bottom:18px">New merchant</div>
     <div class="m-formstack">
       ${field({ id: 'm-merch-name', label: 'Name', placeholder: 'e.g. Capulus Coffee' })}
       <div><div class="label" style="margin-bottom:7px">Type</div>${segmented(
         'merch-type',
         [
           { value: 'shop', label: 'Shop' },
           { value: 'cafe', label: 'Café' },
           { value: 'event', label: 'Event' },
           { value: 'community', label: 'Community' },
         ],
         'cafe',
       )}</div>
     </div>
     <button class="m-mainbtn" id="m-merch-go">Create merchant</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-merch-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const name = el.querySelector<HTMLInputElement>('#m-merch-name')!.value.trim();
      if (!name) return toast({ title: 'Enter a merchant name', tone: 'danger' });
      try {
        await api.post('/admin/merchants', { name, type: segValue(el, 'merch-type') });
        close();
        toast({ title: 'Merchant created', tone: 'success' });
        // Re-fetch so the new merchant appears in the counter switcher and the
        // "Add staff to any merchant" picker within this same session (super-admins
        // see all active merchants via /staff/merchants).
        await refreshMerchants(root);
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

function openAddStaffAnySheet(): void {
  const pickList = merchants
    .map(
      (m, i) =>
        `<button class="m-pick${i === 0 ? ' active' : ''}" data-id="${m.id}">${icon('store', { size: 18 })}<span class="grow">${esc(m.name)}</span></button>`,
    )
    .join('');
  const noMerchants = merchants.length === 0;
  const { el, close } = openSheet(
    `<div class="h" style="margin-bottom:18px">Add staff to any merchant</div>
     <div class="m-formstack">
       ${
         noMerchants
           ? `<div class="m-hint">You're not a member of any merchant yet — create one first, then reopen the app.</div>`
           : `<div><div class="label" style="margin-bottom:7px">Merchant</div><div class="m-pick-list" id="m-any-merchants">${pickList}</div></div>`
       }
       ${field({ id: 'm-any-id', label: 'Telegram ID', placeholder: 'e.g. 710244180', mono: true, numeric: true })}
       <div><div class="label" style="margin-bottom:7px">Role</div>${segmented(
         'any-role',
         [
           { value: 'scanner', label: 'Scanner' },
           { value: 'admin', label: 'Admin' },
         ],
         'scanner',
       )}</div>
     </div>
     <button class="m-mainbtn" id="m-any-go"${noMerchants ? ' disabled' : ''}>Add staff</button>`,
  );
  // Single-select the merchant pick-list.
  el.querySelectorAll<HTMLButtonElement>('#m-any-merchants .m-pick').forEach((b) =>
    b.addEventListener('click', () => {
      el.querySelectorAll('#m-any-merchants .m-pick').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    }),
  );
  const go = el.querySelector<HTMLButtonElement>('#m-any-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const picked = el.querySelector<HTMLElement>('#m-any-merchants .m-pick.active');
      const merchantId = picked?.dataset.id;
      const tg = Number.parseInt(el.querySelector<HTMLInputElement>('#m-any-id')!.value.trim(), 10);
      if (!merchantId) return toast({ title: 'Pick a merchant', tone: 'danger' });
      if (!Number.isFinite(tg) || tg <= 0) return toast({ title: 'Enter a valid Telegram ID', tone: 'danger' });
      try {
        await api.post(`/admin/merchants/${merchantId}/members`, { telegram_id: tg, role: segValue(el, 'any-role') });
        close();
        toast({ title: 'Staff added', tone: 'success' });
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

function openGlobalRuleSheet(root: HTMLElement): void {
  const { el, close } = openSheet(
    `<div class="h" style="margin-bottom:18px">Global accrual rule</div>
     <div class="m-formstack">
       ${field({ id: 'm-grule-name', label: 'Name', placeholder: 'e.g. Visit' })}
       <div><div class="label" style="margin-bottom:7px">Points</div>${presetsFill([10, 20, 50, 100], 'm-grule-points', '+')}${field({ id: 'm-grule-points', placeholder: 'Points', numeric: true })}</div>
       ${field({ id: 'm-grule-limit', label: 'Daily limit per customer (optional)', placeholder: 'No limit', numeric: true })}
     </div>
     <button class="m-mainbtn" id="m-grule-go">Create global rule</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-grule-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const name = el.querySelector<HTMLInputElement>('#m-grule-name')!.value.trim();
      const points = Number.parseInt(el.querySelector<HTMLInputElement>('#m-grule-points')!.value.trim(), 10);
      const limitRaw = el.querySelector<HTMLInputElement>('#m-grule-limit')!.value.trim();
      const limit = limitRaw === '' ? null : Number.parseInt(limitRaw, 10);
      if (!name) return toast({ title: 'Enter a rule name', tone: 'danger' });
      if (!Number.isFinite(points) || points <= 0) return toast({ title: 'Points must be a positive number', tone: 'danger' });
      if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) return toast({ title: 'Daily limit must be a positive number', tone: 'danger' });
      try {
        await api.post('/admin/rules', { name, kind: 'fixed', point_value: points, daily_limit: limit });
        close();
        toast({ title: 'Global rule created', tone: 'success' });
        await loadAllRules(root);
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}

function openGlobalRewardSheet(): void {
  const { el, close } = openSheet(
    `<div class="h" style="margin-bottom:18px">Global reward</div>
     <div class="m-formstack">
       ${field({ id: 'm-rw-title', label: 'Title', placeholder: 'e.g. Specialty coffee' })}
       <div><div class="label" style="margin-bottom:7px">Cost</div>${presetsFill([120, 200, 300], 'm-rw-cost')}${field({ id: 'm-rw-cost', placeholder: 'Cost in points', numeric: true })}</div>
       ${field({ id: 'm-rw-stock', label: 'Stock (optional)', placeholder: 'Unlimited', numeric: true })}
     </div>
     <button class="m-mainbtn" id="m-rw-go">Publish reward</button>`,
  );
  const go = el.querySelector<HTMLButtonElement>('#m-rw-go')!;
  go.addEventListener('click', () =>
    submitOnce(go, async () => {
      const title = el.querySelector<HTMLInputElement>('#m-rw-title')!.value.trim();
      const cost = Number.parseInt(el.querySelector<HTMLInputElement>('#m-rw-cost')!.value.trim(), 10);
      const stockRaw = el.querySelector<HTMLInputElement>('#m-rw-stock')!.value.trim();
      const stock = stockRaw === '' ? null : Number.parseInt(stockRaw, 10);
      if (!title) return toast({ title: 'Enter a reward title', tone: 'danger' });
      if (!Number.isFinite(cost) || cost <= 0) return toast({ title: 'Cost must be a positive number', tone: 'danger' });
      if (stock !== null && (!Number.isFinite(stock) || stock < 0)) return toast({ title: 'Stock must be zero or more', tone: 'danger' });
      try {
        await api.post('/admin/rewards', { title, cost, stock });
        close();
        toast({ title: 'Reward published', tone: 'success' });
      } catch (err) {
        close();
        errToast(err);
      }
    }),
  );
}
