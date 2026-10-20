// Menus: menu bar dropdowns and context menus share the same item model.
import { h } from './dom';
import { isMac } from './platform';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  enabled?: boolean | (() => boolean);
  checked?: boolean | (() => boolean);
  submenu?: MenuItem[] | (() => MenuItem[]);
  separator?: boolean;
}

export const SEP: MenuItem = { separator: true };

export function shortcutLabel(s: string): string {
  if (!s) return '';
  if (!isMac) return s.replace(/Mod/g, 'Ctrl');
  return s.replace(/Mod\+/g, '⌘').replace(/Ctrl\+/g, '⌃').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧').replace(/Enter/g, '↩');
}

let openMenus: HTMLElement[] = [];
let onCloseAll: (() => void) | null = null;

export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  const cb = onCloseAll;
  onCloseAll = null;
  cb?.();
}

const val = <T>(v: T | (() => T) | undefined, d: T): T => (v === undefined ? d : typeof v === 'function' ? (v as () => T)() : v);

function buildMenu(items: MenuItem[], level: number): HTMLElement {
  const el = h('div', { class: 'menu', role: 'menu' });
  let subTimer = 0;
  for (const it of items) {
    if (it.separator) { el.append(h('div', { class: 'menu-sep' })); continue; }
    const enabled = val(it.enabled, true);
    const checked = val(it.checked, false);
    const row = h('div', { class: `menu-item${enabled ? '' : ' disabled'}`, role: 'menuitem' },
      h('span', { class: 'menu-check' }, checked ? '✓' : ''),
      h('span', { class: 'menu-label' }, it.label ?? ''),
      h('span', { class: 'menu-shortcut' }, it.submenu ? '▸' : shortcutLabel(it.shortcut ?? '')));
    if (it.submenu) {
      row.addEventListener('pointerenter', () => {
        clearTimeout(subTimer);
        subTimer = window.setTimeout(() => {
          while (openMenus.length > level + 1) openMenus.pop()!.remove();
          const sub = buildMenu(val(it.submenu, []), level + 1);
          const r = row.getBoundingClientRect();
          showAt(sub, r.right - 2, r.top - 4, r.left);
        }, 120);
      });
    } else {
      row.addEventListener('pointerenter', () => {
        clearTimeout(subTimer);
        subTimer = window.setTimeout(() => { while (openMenus.length > level + 1) openMenus.pop()!.remove(); }, 150);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!enabled) return;
        closeMenus();
        try { it.action?.(); } catch (err) { console.error(err); }
      });
    }
    el.append(row);
  }
  return el;
}

function showAt(menu: HTMLElement, x: number, y: number, altX?: number) {
  document.body.append(menu);
  openMenus.push(menu);
  const r = menu.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x, top = y;
  if (left + r.width > vw - 4) left = altX !== undefined ? Math.max(4, altX - r.width + 2) : Math.max(4, vw - r.width - 4);
  if (top + r.height > vh - 4) top = Math.max(4, vh - r.height - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

export function contextMenu(items: MenuItem[], x: number, y: number, onClose?: () => void) {
  closeMenus();
  const m = buildMenu(items, 0);
  showAt(m, x, y);
  onCloseAll = onClose ?? null;
}

export function dropdown(items: MenuItem[], anchor: HTMLElement, onClose?: () => void) {
  closeMenus();
  const r = anchor.getBoundingClientRect();
  const m = buildMenu(items, 0);
  showAt(m, r.left, r.bottom);
  onCloseAll = onClose ?? null;
}

export function menusOpen() { return openMenus.length > 0; }

window.addEventListener('pointerdown', (e) => {
  if (!openMenus.length) return;
  if (openMenus.some((m) => m.contains(e.target as Node))) return;
  if ((e.target as HTMLElement).closest?.('.menubar-item')) return;
  closeMenus();
}, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenus.length) { e.stopPropagation(); closeMenus(); } }, true);
window.addEventListener('blur', () => closeMenus());
window.addEventListener('resize', () => closeMenus());
