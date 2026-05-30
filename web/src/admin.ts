import { api } from './api.js';
import { alertMsg, scanQr } from './tg.js';

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
interface Redemption {
  id: number;
  status: string;
  cost: number;
  reward_title: string;
  username: string | null;
  telegram_id: number;
  created_at: string;
}

let activeMerchant: number | null = null;

export async function renderAdmin(root: HTMLElement): Promise<void> {
  const me = await api.get<Me>('/me');
  const { merchants } = await api.get<{ merchants: Merchant[] }>('/staff/merchants');

  if (!merchants.length && !me.super_admin) {
    root.innerHTML = '<div class="card">У вас нет доступа к мерчантам.</div>';
    return;
  }
  if (activeMerchant === null && merchants.length) activeMerchant = merchants[0]!.id;

  root.innerHTML = `
    <div class="card">
      <h3>Сканирование</h3>
      <label>Мерчант
        <select id="merchant">${merchants.map((m) => `<option value="${m.id}">${esc(m.name)} (${m.role})</option>`).join('')}</select>
      </label>
      <button id="scan" class="primary">Сканировать QR</button>
    </div>
    <div class="card"><h3>Заявки на награды</h3><div id="redemptions">Загрузка…</div></div>
    ${me.super_admin ? superAdminPanels(merchants) : ''}
    <a class="link" href="/app">← К моему профилю</a>
  `;

  const select = root.querySelector<HTMLSelectElement>('#merchant')!;
  if (activeMerchant) select.value = String(activeMerchant);
  select.addEventListener('change', () => (activeMerchant = Number(select.value)));

  root.querySelector<HTMLButtonElement>('#scan')!.addEventListener('click', () => void doScan());

  await loadRedemptions(root);
  if (me.super_admin) wireSuperAdmin(root);
}

async function doScan(): Promise<void> {
  if (!activeMerchant) {
    alertMsg('Выберите мерчанта');
    return;
  }
  const token = await scanQr();
  if (!token) return;
  try {
    const { rules } = await api.get<{ rules: Rule[] }>(`/merchants/${activeMerchant}/rules`);
    if (!rules.length) {
      alertMsg('Нет правил начисления. Создайте правило.');
      return;
    }
    let rule = rules[0]!;
    if (rules.length > 1) {
      const choice = window.prompt(
        'Правило:\n' + rules.map((r, i) => `${i + 1}. ${r.name} (+${r.point_value})`).join('\n'),
        '1',
      );
      const idx = Number(choice) - 1;
      if (rules[idx]) rule = rules[idx]!;
    }
    const r = await api.post<{ delta: number; balance: number }>(`/merchants/${activeMerchant}/scan`, {
      token,
      rule_id: rule.id,
    });
    alertMsg(`Начислено +${r.delta}. Баланс пользователя: ${r.balance}`);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

async function loadRedemptions(root: HTMLElement): Promise<void> {
  const el = root.querySelector('#redemptions');
  if (!el) return;
  const { redemptions } = await api.get<{ redemptions: Redemption[] }>('/redemptions');
  el.innerHTML = redemptions.length
    ? redemptions
        .map(
          (r) => `<div class="row">
            <div><b>${esc(r.reward_title)}</b> — ${r.cost}
              <div class="muted">${r.username ? '@' + esc(r.username) : 'id ' + r.telegram_id} · ${r.status}</div></div>
            ${
              r.status === 'pending'
                ? `<span><button data-fulfill="${r.id}">Выдать</button> <button data-cancel="${r.id}">Отмена</button></span>`
                : ''
            }
          </div>`,
        )
        .join('')
    : '<div class="muted">Заявок нет</div>';
  el.querySelectorAll<HTMLButtonElement>('button[data-fulfill]').forEach((b) =>
    b.addEventListener('click', () => void act(`/redemptions/${b.dataset.fulfill}/fulfill`, root)),
  );
  el.querySelectorAll<HTMLButtonElement>('button[data-cancel]').forEach((b) =>
    b.addEventListener('click', () => void act(`/redemptions/${b.dataset.cancel}/cancel`, root)),
  );
}

async function act(path: string, root: HTMLElement): Promise<void> {
  try {
    await api.post(path);
    await loadRedemptions(root);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

function superAdminPanels(merchants: Merchant[]): string {
  const opts = merchants.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  return `
    <div class="card"><h3>Super-admin</h3>
      <fieldset><legend>Новый мерчант</legend>
        <input id="m-name" placeholder="Название" />
        <select id="m-type"><option>shop</option><option>cafe</option><option>event</option><option>community</option></select>
        <button id="m-create">Создать</button>
      </fieldset>
      <fieldset><legend>Добавить сотрудника</legend>
        <select id="mm-merchant">${opts}</select>
        <input id="mm-tg" placeholder="telegram_id" inputmode="numeric" />
        <select id="mm-role"><option>scanner</option><option>admin</option></select>
        <button id="mm-add">Добавить</button>
      </fieldset>
      <fieldset><legend>Правило начисления</legend>
        <input id="r-name" placeholder="Напр. Визит" />
        <input id="r-points" placeholder="Баллы" inputmode="numeric" />
        <input id="r-limit" placeholder="Лимит/день (пусто = без)" inputmode="numeric" />
        <button id="r-create">Создать (глобальное)</button>
      </fieldset>
      <fieldset><legend>Награда</legend>
        <input id="rw-title" placeholder="Название" />
        <input id="rw-cost" placeholder="Стоимость" inputmode="numeric" />
        <input id="rw-stock" placeholder="Остаток (пусто = ∞)" inputmode="numeric" />
        <button id="rw-create">Создать (глобальная)</button>
      </fieldset>
    </div>`;
}

function wireSuperAdmin(root: HTMLElement): void {
  const val = (id: string) => root.querySelector<HTMLInputElement | HTMLSelectElement>(id)!.value.trim();
  const intOrNull = (v: string) => (v === '' ? null : Number.parseInt(v, 10));

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
    alertMsg('Готово');
    await renderAdmin(root);
  } catch (err) {
    alertMsg((err as Error).message);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
