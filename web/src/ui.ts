// Shared UI primitives for the Mini App — Direction C, vanilla TS (no framework).
// String/DOM builders + overlay controllers ported from the design bundle's
// mctl-ui.jsx. Colors come from CSS custom properties (currentColor on icons),
// so light/dark is handled entirely by the `data-theme` attribute.

import { haptic } from './tg.js';

/** Escape text for safe interpolation into innerHTML. */
export function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

// ---------------------------------------------------------------- icons
// Inner SVG markup per icon, drawn on a 24×24 grid with stroke=currentColor.
const ICON_PATHS: Record<string, string> = {
  back: '<polyline points="14.5 5 8 12 14.5 19" />',
  close: '<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />',
  dots:
    '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />' +
    '<circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />',
  copy:
    '<rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />' +
    '<path d="M5.5 15.5h-1a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5H14a1.5 1.5 0 0 1 1.5 1.5v1" />',
  check: '<polyline points="5 12.5 10 17.5 19 6.5" />',
  clock: '<circle cx="12" cy="12" r="8.2" /><polyline points="12 7.5 12 12 15.5 14" />',
  arrow: '<line x1="5" y1="12" x2="18" y2="12" /><polyline points="12.5 6 19 12 12.5 18" />',
  chevron: '<polyline points="9 6 15 12 9 18" />',
  refresh: '<path d="M19 12a7 7 0 1 1-2.1-5" /><polyline points="19 4 19 8 15 8" />',
  alert:
    '<path d="M12 4.5 21 19.5H3z" /><line x1="12" y1="10" x2="12" y2="14.5" />' +
    '<circle cx="12" cy="17.3" r="0.6" fill="currentColor" stroke="none" />',
  gift:
    '<rect x="4.5" y="9.5" width="15" height="10" rx="1.5" /><line x1="12" y1="9.5" x2="12" y2="19.5" />' +
    '<path d="M3.5 9.5h17M12 9.5s-1-4-3.2-4a2 2 0 0 0 0 4M12 9.5s1-4 3.2-4a2 2 0 0 1 0 4" />',
  qr:
    '<rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" />' +
    '<rect x="4" y="14" width="6" height="6" rx="1" /><line x1="14" y1="14" x2="14" y2="20" />' +
    '<line x1="17.5" y1="14" x2="17.5" y2="17.5" /><line x1="20" y1="14" x2="20" y2="20" />' +
    '<line x1="14" y1="20" x2="20" y2="20" />',
  spark:
    '<path d="M12 4v5m0 6v5m8-8h-5m-6 0H4m11.7-5.7-3.5 3.5m-1.4 1.4-3.5 3.5m12.4 0-3.5-3.5m-1.4-1.4-3.5-3.5" />',
  plus: '<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />',
  people:
    '<circle cx="9" cy="8.5" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" />' +
    '<path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.5 5.5 0 0 0-3-4.9" />',
  list:
    '<line x1="8.5" y1="7" x2="20" y2="7" /><line x1="8.5" y1="12" x2="20" y2="12" />' +
    '<line x1="8.5" y1="17" x2="20" y2="17" /><circle cx="4.5" cy="7" r="1" fill="currentColor" stroke="none" />' +
    '<circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4.5" cy="17" r="1" fill="currentColor" stroke="none" />',
  grid:
    '<rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" />' +
    '<rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" />',
  store:
    '<path d="M4 9.5 5.2 5h13.6L20 9.5M4 9.5v9.5h16V9.5M4 9.5h16M4 9.5a2.4 2.4 0 0 0 4 0 2.4 2.4 0 0 0 4 0 2.4 2.4 0 0 0 4 0 2.4 2.4 0 0 0 4 0" />',
  trash:
    '<polyline points="5 7 19 7" /><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />' +
    '<path d="M6.5 7l1 12h9l1-12" />',
  tag: '<path d="M4 11.5V5a1 1 0 0 1 1-1h6.5l8 8-7.5 7.5z" /><circle cx="8.5" cy="8.5" r="1.4" />',
  bolt: '<polygon points="13 3 5 13 11 13 10 21 19 10 13 10" />',
  cog:
    '<circle cx="12" cy="12" r="3" />' +
    '<path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3m14.7-6.7-1.8 1.8M7.1 16.9l-1.8 1.8m12.4 0-1.8-1.8M7.1 7.1 5.3 5.3" />',
};

/** Inline SVG icon string (color via currentColor / CSS). */
export function icon(name: string, opts: { size?: number; stroke?: number } = {}): string {
  const s = opts.size ?? 20;
  const sw = opts.stroke ?? 1.6;
  return (
    `<svg class="m-icon" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">` +
    `${ICON_PATHS[name] ?? ''}</svg>`
  );
}

// ---------------------------------------------------------------- form builders
/** A labelled real text/number input (the source of truth for sheet forms). */
export function field(opts: {
  id: string;
  label?: string;
  placeholder?: string;
  value?: string;
  mono?: boolean;
  numeric?: boolean;
}): string {
  return (
    `<label class="m-field">` +
    (opts.label ? `<span class="label">${esc(opts.label)}</span>` : '') +
    `<input id="${opts.id}" class="m-input${opts.mono ? ' mono' : ''}" ` +
    `placeholder="${esc(opts.placeholder ?? '')}" value="${esc(opts.value ?? '')}" ` +
    (opts.numeric ? `inputmode="numeric" ` : '') +
    `/></label>`
  );
}

/** Single-select segmented control. Selected value read via segValue(). */
export function segmented(
  name: string,
  options: { value: string; label: string }[],
  value: string,
): string {
  return (
    `<div class="m-seg" data-seg="${name}">` +
    options
      .map(
        (o) =>
          `<button type="button" data-val="${esc(o.value)}"${o.value === value ? ' class="active"' : ''}>${esc(o.label)}</button>`,
      )
      .join('') +
    `</div>`
  );
}

/** Quick-pick chips that fill a target input on tap (input stays editable). */
export function presetsFill(values: number[], targetId: string, prefix = ''): string {
  return (
    `<div class="m-presets">` +
    values
      .map(
        (v) =>
          `<button type="button" class="m-preset" data-fill="${targetId}" data-val="${v}">${prefix}${v}</button>`,
      )
      .join('') +
    `</div>`
  );
}

/** Read the selected value of a segmented control inside `root`. */
export function segValue(root: ParentNode, name: string): string {
  const active = root.querySelector<HTMLElement>(`.m-seg[data-seg="${name}"] button.active`);
  return active?.dataset.val ?? '';
}

/** Wire toggle behaviour for segmented + preset-fill groups within `root`. */
export function wireToggles(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.m-seg').forEach((seg) => {
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        haptic('selection');
      }),
    );
  });
  root.querySelectorAll<HTMLButtonElement>('.m-preset[data-fill]').forEach((b) =>
    b.addEventListener('click', () => {
      const input = root.querySelector<HTMLInputElement>(`#${b.dataset.fill}`);
      if (input) input.value = b.dataset.val ?? '';
      const group = b.parentElement!;
      group.querySelectorAll('.m-preset').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      haptic('selection');
    }),
  );
}

// ---------------------------------------------------------------- overlays
let scrims: HTMLElement[] = [];

function mountScrim(centered: boolean): HTMLElement {
  const scrim = document.createElement('div');
  scrim.className = centered ? 'm-scrim center' : 'm-scrim';
  document.body.appendChild(scrim);
  scrims.push(scrim);
  return scrim;
}

function unmount(scrim: HTMLElement): void {
  scrim.remove();
  scrims = scrims.filter((s) => s !== scrim);
}

/** Dismiss every open overlay (used when navigating away from a screen). */
export function closeOverlays(): void {
  for (const s of [...scrims]) unmount(s);
}

export interface SheetHandle {
  el: HTMLElement;
  close: () => void;
}

/**
 * Open a bottom sheet. `bodyHtml` is the inner content (a title + form). Returns
 * the sheet element (for wiring) and a close() function. Toggle groups inside
 * are wired automatically. Tapping the scrim closes it.
 */
export function openSheet(bodyHtml: string, onClose?: () => void): SheetHandle {
  const scrim = mountScrim(false);
  scrim.innerHTML = `<div class="m-sheet"><div class="handle"></div>${bodyHtml}</div>`;
  const sheet = scrim.querySelector<HTMLElement>('.m-sheet')!;
  const close = (): void => {
    unmount(scrim);
    onClose?.();
  };
  scrim.addEventListener('click', (e) => {
    if (e.target === scrim) close();
  });
  wireToggles(sheet);
  haptic('impact', 'light');
  return { el: sheet, close };
}

/** Confirm dialog. Resolves true on confirm, false on cancel/scrim. */
export function openDialog(opts: {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'accent';
}): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = mountScrim(true);
    const danger = opts.tone === 'danger';
    scrim.innerHTML =
      `<div class="m-dialog"><div class="h">${esc(opts.title)}</div>` +
      (opts.body ? `<div class="p">${esc(opts.body)}</div>` : '') +
      `<div class="actions">` +
      `<button type="button" class="m-mainbtn${danger ? ' danger' : ''}" data-act="ok">${esc(opts.confirmLabel ?? 'Confirm')}</button>` +
      `<button type="button" class="m-mainbtn secondary" data-act="cancel">${esc(opts.cancelLabel ?? 'Cancel')}</button>` +
      `</div></div>`;
    const done = (v: boolean): void => {
      unmount(scrim);
      resolve(v);
    };
    scrim.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === scrim || t.closest('[data-act="cancel"]')) done(false);
      else if (t.closest('[data-act="ok"]')) {
        haptic(danger ? 'notification' : 'impact', danger ? 'warning' : 'medium');
        done(true);
      }
    });
    haptic('impact', 'light');
  });
}

/** Transient toast (auto-dismisses). tone drives the leading icon + color. */
export function toast(opts: { title: string; sub?: string; tone?: 'success' | 'danger' | 'ink' }): void {
  const tone = opts.tone ?? 'ink';
  const el = document.createElement('div');
  el.className = `m-toast ${tone}`;
  el.innerHTML =
    `<span class="tic">${icon(tone === 'danger' ? 'alert' : 'check', { size: 15, stroke: 2 })}</span>` +
    `<div class="grow"><div class="title">${esc(opts.title)}</div>` +
    (opts.sub ? `<div class="sub">${esc(opts.sub)}</div>` : '') +
    `</div>`;
  document.body.appendChild(el);
  if (tone === 'success') haptic('notification', 'success');
  else if (tone === 'danger') haptic('notification', 'error');
  window.setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 260);
  }, 2600);
}

// ---------------------------------------------------------------- snippets
export function sectionLabel(label: string, meta?: string): string {
  return (
    `<div class="m-seclabel"><span class="lbl">${esc(label)}</span>` +
    (meta ? `<span class="meta">${esc(meta)}</span>` : '') +
    `</div>`
  );
}

export function avatarFor(name: string | null, tgId: number): string {
  const initial = (name ?? String(tgId)).replace(/^@/, '').charAt(0).toUpperCase() || '?';
  return `<div class="m-avatar">${esc(initial)}</div>`;
}

export function emptyState(iconName: string, title: string, body: string): string {
  return (
    `<div class="m-empty"><div class="m-icon-circle">${icon(iconName, { size: 21 })}</div>` +
    `<div class="h">${esc(title)}</div><div class="p">${esc(body)}</div></div>`
  );
}

export function skeleton(w: string, h: number, mt = 0): string {
  return `<div class="m-skeleton" style="width:${w};height:${h}px;${mt ? `margin-top:${mt}px;` : ''}border-radius:${h > 40 ? 14 : 8}px"></div>`;
}
