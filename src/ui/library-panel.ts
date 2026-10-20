// Library panel: symbols, bitmaps, folders, preview, drag to stage.
import type { LibraryItem, SymbolType } from '../core/types';
import { renderTimeline } from '../core/render';
import { timelineBounds } from '../core/geometry';
import { isEmptyRect } from '../core/matrix';
import { timelineFrameCount } from '../core/timeline';
import { IDENTITY_CT, itemId, uniqueName, baseName, folderOf } from '../core/util';
import { store } from './state';
import { h, clear, select } from './dom';
import { icon } from './icons';
import { contextMenu, SEP } from './menu';
import { modal, row, confirmDialog } from './dialogs';
import * as A from './actions';
import { exportSpriteSheetDialog, exportSymbolsDialog } from './exporter';
import { audio } from './audio';

const I = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
export const DRAG_MIME = 'application/x-celerity-library-item';

export class LibraryPanel {
  el: HTMLElement;
  private list: HTMLElement;
  private preview: HTMLCanvasElement;
  private countEl: HTMLElement;
  private search: HTMLInputElement;
  selected = new Set<string>();
  private collapsed = new Set<string>();
  private previewAnim = 0;

  constructor(host: HTMLElement) {
    this.preview = h('canvas', { class: 'lib-preview' }) as HTMLCanvasElement;
    this.countEl = h('span', { class: 'dim' });
    this.search = h('input', { type: 'search', placeholder: 'Search library', spellcheck: false }) as HTMLInputElement;
    this.search.addEventListener('input', () => this.render());
    this.search.addEventListener('keydown', (e) => e.stopPropagation());
    this.list = h('div', { class: 'lib-list', tabindex: '0' });
    const btn = (ic: string, title: string, fn: () => void) => { const b = h('button', { class: 'icon-btn', title, html: icon(ic) }); b.addEventListener('click', fn); return b; };
    const footer = h('div', { class: 'lib-footer' },
      btn('plus', 'New Symbol…', () => newSymbolDialog()),
      btn('folder', 'New Folder', () => this.newFolder()),
      btn('gear', 'Properties…', () => { const n = [...this.selected][0]; if (n) this.properties(n); }),
      btn('trash', 'Delete', () => this.deleteSelected()));
    this.el = h('div', { class: 'library' }, h('div', { class: 'lib-preview-wrap checker' }, this.preview), h('div', { class: 'lib-head' }, this.countEl, this.search), this.list, footer);
    host.append(this.el);
    this.list.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); this.deleteSelected(); }
    });
    // drop on empty area = move to root
    this.list.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes(DRAG_MIME)) e.preventDefault(); });
    this.list.addEventListener('drop', (e) => {
      const name = e.dataTransfer?.getData(DRAG_MIME);
      if (name && e.target === this.list) { e.preventDefault(); this.moveTo(name, ''); }
    });
    store.on((w) => { if (w.has('library') || w.has('doc') || w.has('file')) this.render(); });
    new ResizeObserver(() => this.drawPreview()).observe(this.preview);
    this.render();
  }

  render() {
    const items = store.doc.library;
    for (const n of [...this.selected]) if (!store.lib.has(n)) this.selected.delete(n);
    const count = items.filter((i) => i.kind !== 'folder').length;
    this.countEl.textContent = `${count} item${count === 1 ? '' : 's'}`;
    clear(this.list);
    const q = this.search.value.trim().toLowerCase();
    // folders implied by item names
    const folders = new Set<string>(items.filter((i) => i.kind === 'folder').map((i) => i.name));
    for (const it of items) { let p = folderOf(it.name); while (p) { folders.add(p); p = folderOf(p); } }
    const all: { name: string; kind: LibraryItem['kind']; item?: LibraryItem }[] = [
      ...[...folders].map((f) => ({ name: f, kind: 'folder' as const, item: store.lib.get(f) })),
      ...items.filter((i) => i.kind !== 'folder').map((i) => ({ name: i.name, kind: i.kind, item: i })),
    ];
    all.sort((a, b) => {
      const fa = folderOf(a.name), fb = folderOf(b.name);
      if (fa !== fb) return a.name.localeCompare(b.name, undefined, { numeric: true });
      if (a.kind === 'folder' && b.kind !== 'folder') return -1;
      if (b.kind === 'folder' && a.kind !== 'folder') return 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    // order as a tree
    const tree: typeof all = [];
    const add = (parent: string, depth: number) => {
      const kids = all.filter((x) => folderOf(x.name) === parent);
      kids.sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || baseName(a.name).localeCompare(baseName(b.name), undefined, { numeric: true }));
      for (const k of kids) {
        (k as typeof k & { depth: number }).depth = depth;
        tree.push(k);
        if (k.kind === 'folder' && (q || !this.collapsed.has(k.name))) add(k.name, depth + 1);
      }
    };
    add('', 0);
    for (const entry of tree) {
      const depth = (entry as typeof entry & { depth: number }).depth;
      if (q && entry.kind !== 'folder' && !entry.name.toLowerCase().includes(q)) continue;
      if (q && entry.kind === 'folder') continue;
      const it = entry.item;
      const ic = entry.kind === 'folder' ? 'folder' : entry.kind === 'bitmap' ? 'bitmap' : entry.kind === 'sound' ? 'sound' : entry.kind === 'video' ? 'video' : (it as { symbolType: SymbolType }).symbolType;
      const typeLabel = entry.kind === 'folder' ? 'Folder' : entry.kind === 'bitmap' ? 'Bitmap' : entry.kind === 'sound' ? 'Sound' : entry.kind === 'video' ? 'Video' : ({ movieclip: 'Movie Clip', graphic: 'Graphic', button: 'Button' } as Record<string, string>)[ic];
      const nameEl = h('span', { class: 'lib-name' }, baseName(entry.name));
      const rowEl = h('div', {
        class: `lib-item${this.selected.has(entry.name) ? ' selected' : ''}`,
        draggable: 'true',
        style: `padding-left:${6 + depth * 14}px`,
        title: entry.name,
      },
      entry.kind === 'folder' ? h('span', { class: 'lib-caret' }, this.collapsed.has(entry.name) ? '▸' : '▾') : h('span', { class: 'lib-caret' }),
      h('span', { class: 'lib-icon', html: icon(ic) }), nameEl, h('span', { class: 'lib-type dim' }, typeLabel));
      rowEl.addEventListener('click', (e) => {
        if (entry.kind === 'folder' && (e.target as HTMLElement).classList.contains('lib-caret')) {
          if (this.collapsed.has(entry.name)) this.collapsed.delete(entry.name); else this.collapsed.add(entry.name);
          this.render();
          return;
        }
        if (e.ctrlKey || e.metaKey) { if (this.selected.has(entry.name)) this.selected.delete(entry.name); else this.selected.add(entry.name); }
        else if (e.shiftKey && this.anchor) {
          // range selection in display order
          const order = [...this.list.querySelectorAll<HTMLElement>('.lib-item')].map((x) => x.title);
          const a = order.indexOf(this.anchor), b = order.indexOf(entry.name);
          if (a >= 0 && b >= 0) this.selected = new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1));
        } else this.selected = new Set([entry.name]);
        if (!e.shiftKey) this.anchor = entry.name;
        this.render();
        this.list.focus();
      });
      rowEl.addEventListener('dblclick', (e) => {
        if (entry.kind === 'folder') { if (this.collapsed.has(entry.name)) this.collapsed.delete(entry.name); else this.collapsed.add(entry.name); this.render(); return; }
        if ((e.target as HTMLElement).classList.contains('lib-name')) { this.rename(entry.name, nameEl); return; }
        if (entry.kind === 'symbol') store.enterSymbol(entry.name, null, false);
        if (entry.kind === 'sound' && it?.kind === 'sound') void audio.preview(it);
      });
      rowEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.selected.has(entry.name)) { this.selected = new Set([entry.name]); this.render(); }
        contextMenu([
          { label: 'Edit', enabled: entry.kind === 'symbol', action: () => store.enterSymbol(entry.name, null, false) },
          { label: 'Rename', action: () => this.rename(entry.name, nameEl) },
          { label: 'Duplicate', enabled: entry.kind !== 'folder', action: () => { const n = store.duplicateLibraryItem(entry.name); if (n) { this.selected = new Set([n]); this.render(); } } },
          { label: 'Delete', action: () => this.deleteSelected() },
          SEP,
          { label: 'Properties…', enabled: entry.kind !== 'folder', action: () => this.properties(entry.name) },
          { label: 'Add to Stage', enabled: entry.kind !== 'folder', action: () => { const c = store.doc; A.placeLibraryItem(entry.name, c.width / 2, c.height / 2); } },
          { label: 'Export Sprite Sheet…', enabled: entry.kind === 'symbol', action: () => exportSpriteSheetDialog(entry.name) },
          { label: this.selectedSymbols().length > 1 ? `Export ${this.selectedSymbols().length} Symbols…` : 'Export Selected Symbols…', enabled: this.selectedSymbols().length > 0, action: () => exportSymbolsDialog(this.selectedSymbols()) },
          SEP,
          { label: 'New Symbol…', action: () => newSymbolDialog() },
          { label: 'New Folder', action: () => this.newFolder() },
        ], e.clientX, e.clientY);
      });
      rowEl.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(DRAG_MIME, entry.name);
        e.dataTransfer?.setData('text/plain', entry.name);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
      });
      if (entry.kind === 'folder') {
        rowEl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes(DRAG_MIME)) { e.preventDefault(); rowEl.classList.add('drop-into'); } });
        rowEl.addEventListener('dragleave', () => rowEl.classList.remove('drop-into'));
        rowEl.addEventListener('drop', (e) => {
          e.preventDefault();
          rowEl.classList.remove('drop-into');
          const name = e.dataTransfer?.getData(DRAG_MIME);
          if (name && name !== entry.name) this.moveTo(name, entry.name);
        });
      }
      this.list.append(rowEl);
    }
    if (!tree.length) this.list.append(h('div', { class: 'lib-empty' }, 'Library is empty. Convert artwork to a symbol (F8) or import images (Ctrl+R).'));
    this.drawPreview();
  }

  private anchor: string | null = null;

  selectedSymbols(): string[] {
    return [...this.selected].filter((n) => store.lib.get(n)?.kind === 'symbol');
  }

  private moveTo(name: string, folder: string) {
    const newName = (folder ? folder + '/' : '') + baseName(name);
    if (newName === name || newName.startsWith(name + '/')) return;
    if (store.renameLibraryItem(name, uniqueName(store.libraryNames(), newName))) this.selected = new Set([newName]);
  }

  private drawPreview() {
    cancelAnimationFrame(this.previewAnim);
    const c = this.preview;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const name = [...this.selected][0];
    c.onclick = () => { const s = name ? store.lib.get(name) : undefined; if (s?.kind === 'sound') void audio.preview(s); };
    const it = name ? store.lib.get(name) : undefined;
    if (!it || it.kind === 'folder') return;
    if (it.kind === 'sound') {
      // waveform; click the preview to play
      const pk = audio.peaksOf(it, Math.max(16, Math.floor(W / 2)));
      ctx.fillStyle = '#2E9BFF';
      if (!pk) { audio.onDecodedOnce(() => this.drawPreview()); return; }
      const mid = H / 2;
      for (let i = 0; i < pk.length; i++) {
        const v = pk[i] * (H / 2 - 6);
        ctx.fillRect(i * 2, mid - v, 1.5 * (W / pk.length / 2 > 1 ? 1 : 1), Math.max(1, v * 2));
      }
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      const d = audio.durationOf(it);
      ctx.fillText(`${it.format} · ${d.toFixed(2)} s — click to play`, 8 * dpr, H - 8 * dpr);
      return;
    }
    if (it.kind === 'video') return;
    if (it.kind === 'bitmap') {
      const a = store.assets.get(it.assetId);
      if (!a?.image) return;
      const k = Math.min((W - 16) / it.width, (H - 16) / it.height, 4 * dpr);
      ctx.drawImage(a.image as CanvasImageSource, (W - it.width * k) / 2, (H - it.height * k) / 2, it.width * k, it.height * k);
      return;
    }
    const len = timelineFrameCount(it.timeline);
    let b = timelineBounds(it.timeline, 0, I, store.lib);
    for (let f = 1; f < Math.min(len, 60); f++) {
      const bf = timelineBounds(it.timeline, f, I, store.lib);
      if (!isEmptyRect(bf)) b = isEmptyRect(b) ? bf : { x: Math.min(b.x, bf.x), y: Math.min(b.y, bf.y), w: Math.max(b.x + b.w, bf.x + bf.w) - Math.min(b.x, bf.x), h: Math.max(b.y + b.h, bf.y + bf.h) - Math.min(b.y, bf.y) };
    }
    if (isEmptyRect(b) || b.w <= 0 || b.h <= 0) return;
    const k = Math.min((W - 16) / b.w, (H - 16) / b.h, 4 * dpr);
    const m = { a: k, b: 0, c: 0, d: k, tx: W / 2 - (b.x + b.w / 2) * k, ty: H / 2 - (b.y + b.h / 2) * k };
    const env = { lib: store.lib, assets: store.assets, playback: true, includeHidden: true, showGuides: false, outlines: false };
    let f = 0;
    const start = performance.now();
    const step = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      renderTimeline(ctx, it.timeline, f, m, IDENTITY_CT, env, { offset: f, elapsed: f, spanAll: true, playback: true });
      if (len > 1 && this.el.isConnected && this.selected.has(name!)) {
        f = Math.floor(((performance.now() - start) / 1000) * store.doc.fps) % len;
        this.previewAnim = requestAnimationFrame(step);
      }
    };
    step();
  }

  private rename(name: string, nameEl: HTMLElement) {
    const input = h('input', { type: 'text', value: baseName(name), class: 'lib-rename', spellcheck: false }) as HTMLInputElement;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim().replace(/\//g, '-');
      if (ok && v && v !== baseName(name)) {
        const folder = folderOf(name);
        const full = (folder ? folder + '/' : '') + v;
        if (store.renameLibraryItem(name, full)) this.selected = new Set([full]);
      }
      this.render();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
  }

  private newFolder() {
    const name = uniqueName(store.libraryNames(), 'Untitled Folder 1');
    store.transact('New Folder', () => store.addLibraryItem({ kind: 'folder', name, itemID: itemId() }));
    this.selected = new Set([name]);
    this.render();
  }

  private async deleteSelected() {
    const names = [...this.selected];
    if (!names.length) return;
    const uses = names.reduce((s, n) => s + A.symbolUsage(n), 0);
    if (uses > 0 && !(await confirmDialog('Delete library items', `${names.length} item(s) are used ${uses} time(s) in the document. Deleting removes those instances too. Continue?`, 'Delete'))) return;
    store.deleteLibraryItems(names);
    this.selected.clear();
    this.render();
  }

  private properties(name: string) {
    const it = store.lib.get(name);
    if (!it || it.kind === 'folder') return;
    const nameIn = h('input', { type: 'text', value: baseName(it.name), spellcheck: false }) as HTMLInputElement;
    let type: SymbolType = it.kind === 'symbol' ? it.symbolType : 'graphic';
    modal({
      title: it.kind === 'symbol' ? 'Symbol Properties' : it.kind === 'sound' ? 'Sound Properties' : it.kind === 'video' ? 'Video Properties' : 'Bitmap Properties', width: 420,
      body: h('div', { class: 'form' },
        row('Name', nameIn),
        it.kind === 'symbol' ? row('Type', select(type, [['movieclip', 'Movie Clip'], ['graphic', 'Graphic'], ['button', 'Button']], (v) => { type = v; }))
          : it.kind === 'sound' ? row('Format', `${it.format}${it.codec === 'mp3' ? ' (MP3)' : it.codec === 'adpcm' ? ' (ADPCM)' : ''} · ${audio.durationOf(it).toFixed(2)} s`)
            : row('Size', `${it.width} × ${it.height} px`)),
      buttons: [{ label: 'Cancel' }, {
        label: 'OK', primary: true, onClick: () => {
          const folder = folderOf(it.name);
          const full = (folder ? folder + '/' : '') + nameIn.value.trim();
          if (it.kind === 'symbol' && type !== it.symbolType) store.transact('Symbol Type', () => { it.symbolType = type; });
          if (nameIn.value.trim() && full !== it.name) store.renameLibraryItem(it.name, full);
        },
      }],
    });
  }
}

export function newSymbolDialog(fromSelection = false) {
  const nameIn = h('input', { type: 'text', value: A.nextSymbolName('Symbol'), spellcheck: false }) as HTMLInputElement;
  let type: SymbolType = 'movieclip';
  let reg = { x: 0, y: 0 };
  const grid = h('div', { class: 'reg-grid', title: 'Registration point' });
  const cells: HTMLElement[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    const cell = h('button', { class: `reg-cell${r === 0 && c === 0 ? ' on' : ''}` });
    cell.addEventListener('click', (e) => { e.preventDefault(); reg = { x: c / 2, y: r / 2 }; cells.forEach((x) => x.classList.remove('on')); cell.classList.add('on'); });
    cells.push(cell);
    grid.append(cell);
  }
  modal({
    title: fromSelection ? 'Convert to Symbol' : 'Create New Symbol', width: 440,
    body: h('div', { class: 'form' },
      row('Name', nameIn),
      row('Type', select(type, [['movieclip', 'Movie Clip'], ['graphic', 'Graphic'], ['button', 'Button']], (v) => { type = v; })),
      fromSelection ? row('Registration', grid) : null),
    buttons: [{ label: 'Cancel' }, {
      label: 'OK', primary: true, onClick: () => {
        const name = nameIn.value.trim() || 'Symbol 1';
        if (fromSelection) A.convertSelectionToSymbol(name, type, reg);
        else { const n = A.createEmptySymbol(name, type); store.enterSymbol(n, null, false); }
      },
    }],
  });
}
