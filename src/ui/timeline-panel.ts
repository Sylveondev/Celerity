// Timeline panel: layers list + canvas-rendered frame grid (fast with thousands of frames).
import type { Frame, Layer, Timeline } from '../core/types';
import { frameAt, layerLength, timelineFrameCount, moveFrames } from '../core/timeline';
import { classicTweenValid, shapeTweenValid } from '../core/tween';
import { store, ui, setUI, onUI } from './state';
import { h, clear, numField } from './dom';
import { icon } from './icons';
import { contextMenu, type MenuItem, SEP } from './menu';
import * as A from './actions';
import type { Stage } from './stage';
import { promptDialog } from './dialogs';
import { openPicker } from './colorpicker';
import { uid, cloneElements } from '../core/util';

const ROW_H = 24;
const RULER_H = 22;

interface RowInfo { layer: Layer; depth: number }

export class TimelinePanel {
  el: HTMLElement;
  private layersBox: HTMLElement;
  private framesScroll: HTMLElement;
  private spacer: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ruler: HTMLCanvasElement;
  private frameInput: HTMLInputElement;
  private fpsLabel: HTMLElement;
  private timeLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private loopBtn: HTMLButtonElement;
  private onionBtn: HTMLButtonElement;
  private rows: RowInfo[] = [];
  private cellW = 12;
  private queued = false;
  private drag: null | { kind: 'select'; l0: number; f0: number } | { kind: 'move'; l0: number; f0: number; delta: number; dl: number; started: boolean; x: number } | { kind: 'scrub' } = null;
  private layerDrag: { id: string; startY: number; started: boolean; target: number; into: string | null } | null = null;

  constructor(host: HTMLElement, private stage: Stage) {
    this.playBtn = h('button', { class: 'icon-btn', title: 'Play (Enter)', html: icon('play') }) as HTMLButtonElement;
    this.loopBtn = h('button', { class: 'icon-btn toggle', title: 'Loop playback', html: icon('loop') }) as HTMLButtonElement;
    this.onionBtn = h('button', { class: 'icon-btn toggle', title: 'Onion skin (Alt+Shift+O)', html: icon('onion') }) as HTMLButtonElement;
    this.frameInput = h('input', { class: 'num frame-num', type: 'text', value: '1', title: 'Current frame' }) as HTMLInputElement;
    this.fpsLabel = h('span', { class: 'tl-fps', title: 'Frame rate (click to change)' });
    this.timeLabel = h('span', { class: 'tl-time' });
    const btn = (ic: string, title: string, fn: () => void) => { const b = h('button', { class: 'icon-btn', title, html: icon(ic) }); b.addEventListener('click', fn); return b; };
    const zoom = h('input', { type: 'range', min: '4', max: '32', value: String(this.cellW), title: 'Frame width', class: 'tl-zoom' }) as HTMLInputElement;
    zoom.addEventListener('input', () => { this.cellW = Number(zoom.value); this.layoutSpacer(); this.request(); });
    const toolbar = h('div', { class: 'tl-toolbar' },
      btn('addLayer', 'New Layer', () => store.addLayer('normal')),
      btn('folder', 'New Folder', () => store.addLayer('folder')),
      btn('trash', 'Delete Layer', () => { const l = store.layer(); if (l) store.deleteLayers(store.frameSel?.layerIds.length ? store.frameSel.layerIds : [l.id]); }),
      h('span', { class: 'tl-sep' }),
      btn('first', 'Go to first frame (Shift+,)', () => store.setFrame(0)),
      btn('stepBack', 'Previous frame (,)', () => store.setFrame(store.frame - 1)),
      this.playBtn,
      btn('stepFwd', 'Next frame (.)', () => store.setFrame(store.frame + 1)),
      btn('last', 'Go to last frame (Shift+.)', () => store.setFrame(timelineFrameCount(store.timeline()) - 1)),
      this.loopBtn,
      this.onionBtn,
      h('span', { class: 'tl-sep' }),
      this.frameInput,
      this.fpsLabel,
      this.timeLabel,
      h('span', { class: 'tl-spacer' }),
      zoom,
    );
    this.playBtn.addEventListener('click', () => this.stage.togglePlay());
    this.loopBtn.addEventListener('click', () => setUI('loop', !ui.loop));
    this.onionBtn.addEventListener('click', () => setUI('onion', !ui.onion));
    this.onionBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu([
        { label: 'Onion skin', checked: ui.onion, action: () => setUI('onion', !ui.onion) },
        SEP,
        ...[1, 2, 3, 5, 10].map((n) => ({ label: `${n} frame${n > 1 ? 's' : ''} before/after`, checked: ui.onionBefore === n, action: () => { setUI('onionBefore', n); setUI('onionAfter', n); setUI('onion', true); } })),
      ], e.clientX, e.clientY);
    });
    this.frameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.frameInput.blur(); });
    this.frameInput.addEventListener('change', () => { const n = parseInt(this.frameInput.value, 10); if (n > 0) store.setFrame(n - 1); this.update(); });
    this.fpsLabel.addEventListener('click', () => this.editFps());

    this.layersBox = h('div', { class: 'tl-layers' });
    this.canvas = h('canvas', { class: 'tl-canvas' }) as HTMLCanvasElement;
    this.ruler = h('canvas', { class: 'tl-ruler' }) as HTMLCanvasElement;
    this.spacer = h('div', { class: 'tl-spacer-inner' });
    this.framesScroll = h('div', { class: 'tl-frames-scroll' }, this.spacer);
    const header = h('div', { class: 'tl-layers-header' },
      h('span', { class: 'tl-h-name' }, ''),
      this.headerToggle('eye', 'Show/hide all layers', () => this.toggleAll('visible')),
      this.headerToggle('lock', 'Lock/unlock all layers', () => this.toggleAll('locked')),
      this.headerToggle('outline', 'Show all layers as outlines', () => this.toggleAll('outline')));
    const left = h('div', { class: 'tl-left' }, header, this.layersBox);
    const rulerWrap = h('div', { class: 'tl-ruler-wrap' }, this.ruler);
    const right = h('div', { class: 'tl-right' }, rulerWrap, h('div', { class: 'tl-frames' }, this.canvas, this.framesScroll));
    this.el = h('div', { class: 'timeline' }, toolbar, h('div', { class: 'tl-body' }, left, right));
    host.append(this.el);

    this.framesScroll.addEventListener('scroll', () => {
      this.layersBox.scrollTop = this.framesScroll.scrollTop;
      this.request();
    });
    this.layersBox.addEventListener('wheel', (e) => { this.framesScroll.scrollTop += e.deltaY; e.preventDefault(); }, { passive: false });
    // layer drag & drop (pointer captured only once a drag actually starts, so double-click still works)
    this.layersBox.addEventListener('pointermove', (e) => {
      const d = this.layerDrag;
      if (d && !d.started && Math.abs(e.clientY - d.startY) >= 4) this.layersBox.setPointerCapture(e.pointerId);
      this.layerDragMove(e);
    });
    this.layersBox.addEventListener('pointerup', () => this.layerDragEnd());
    this.layersBox.addEventListener('lostpointercapture', () => { if (this.layerDrag?.started) this.layerDragEnd(); });
    new ResizeObserver(() => this.request()).observe(this.framesScroll);
    this.bindFrames();
    this.bindRuler();
    store.on((w) => {
      if (w.has('doc') || w.has('context') || w.has('selection') || w.has('timeline') || w.has('library')) this.update(false);
      else if (w.has('frame') || w.has('play')) this.light();
    });
    onUI((k) => { if (k === 'loop' || k === 'onion') this.updateToolbar(); });
    this.stage.onPlayState = () => this.updateToolbar();
    this.update();
  }

  private headerToggle(ic: string, title: string, fn: () => void) {
    const b = h('button', { class: 'icon-btn tiny', title, html: icon(ic) });
    b.addEventListener('click', fn);
    return b;
  }

  private toggleAll(key: 'visible' | 'locked' | 'outline') {
    const tl = store.timeline();
    const allOn = key === 'visible' ? tl.layers.every((l) => l.visible) : tl.layers.every((l) => l[key]);
    store.transact('Layers', () => {
      for (const l of tl.layers) l[key] = key === 'visible' ? !allOn : !allOn;
    });
  }

  private editFps() {
    promptDialog('Frame Rate', 'Frames per second', String(store.doc.fps)).then((v) => {
      const n = Number(v);
      if (v !== null && n > 0 && n <= 120) store.transact('Frame Rate', () => { store.doc.fps = n; });
    });
  }

  private computeRows(tl: Timeline) {
    const rows: RowInfo[] = [];
    const byId = new Map(tl.layers.map((l) => [l.id, l]));
    for (const l of tl.layers) {
      let depth = 0;
      let hidden = false;
      let p = l.parentId ? byId.get(l.parentId) : undefined;
      let guard = 0;
      while (p && guard++ < 32) {
        depth++;
        if (p.type === 'folder' && p.open === false) hidden = true;
        p = p.parentId ? byId.get(p.parentId) : undefined;
      }
      if (!hidden) rows.push({ layer: l, depth });
    }
    this.rows = rows;
  }

  private layoutSpacer() {
    const len = timelineFrameCount(store.timeline());
    const cols = Math.max(len + 200, Math.ceil(this.framesScroll.clientWidth / this.cellW) + 50);
    this.spacer.style.width = cols * this.cellW + 'px';
    this.spacer.style.height = this.rows.length * ROW_H + 'px';
  }

  private renaming = false;

  update(ensureVisible = false) {
    const tl = store.timeline();
    this.computeRows(tl);
    if (!this.renaming) this.renderLayers();
    this.layoutSpacer();
    this.updateToolbar();
    if (ensureVisible || !store.playing) this.scrollToFrame(store.frame);
    this.request();
  }

  /** Cheap refresh for playhead / frame selection changes (no DOM rebuild). */
  private light() {
    this.updateToolbar();
    this.scrollToFrame(store.frame);
    // current-layer highlight may change on frame selection
    const cur = store.layer()?.id;
    const sel = new Set(store.frameSel?.layerIds ?? []);
    this.layersBox.querySelectorAll<HTMLElement>('.tl-layer').forEach((el) => {
      el.classList.toggle('current', el.dataset.id === cur);
      el.classList.toggle('selected', sel.has(el.dataset.id!));
    });
    this.request();
  }

  private updateToolbar() {
    this.playBtn.innerHTML = icon(store.playing ? 'pause' : 'play');
    this.loopBtn.classList.toggle('on', ui.loop);
    this.onionBtn.classList.toggle('on', ui.onion);
    if (document.activeElement !== this.frameInput) this.frameInput.value = String(store.frame + 1);
    this.fpsLabel.textContent = `${+store.doc.fps.toFixed(2)} fps`;
    this.timeLabel.textContent = `${(store.frame / store.doc.fps).toFixed(2)}s`;
  }

  private scrollToFrame(f: number) {
    const x = f * this.cellW;
    const s = this.framesScroll;
    if (x < s.scrollLeft) s.scrollLeft = Math.max(0, x - this.cellW * 4);
    else if (x + this.cellW > s.scrollLeft + s.clientWidth) s.scrollLeft = x - s.clientWidth + this.cellW * 6;
  }

  // ---------------- layers list ----------------
  private renderLayers() {
    clear(this.layersBox);
    const cur = store.layer();
    const sel = new Set(store.frameSel?.layerIds ?? []);
    for (const { layer, depth } of this.rows) {
      const isCur = cur?.id === layer.id;
      const typeIcon = layer.type === 'folder' ? 'folder' : layer.type === 'mask' ? 'maskLayer' : layer.type === 'guide' ? 'guideLayer' : layer.parentId && store.timeline().layers.find((x) => x.id === layer.parentId)?.type === 'mask' ? 'outline' : 'layer';
      const caret = layer.type === 'folder' ? h('button', { class: 'tl-caret', title: layer.open === false ? 'Expand' : 'Collapse' }, layer.open === false ? '▸' : '▾') : h('span', { class: 'tl-caret' });
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (layer.type !== 'folder') return;
        store.transact(layer.open === false ? 'Expand Folder' : 'Collapse Folder', () => { layer.open = layer.open === false; });
      });
      const name = h('span', { class: 'tl-name', title: layer.name }, layer.name);
      const eye = h('button', { class: `icon-btn tiny ${layer.visible ? '' : 'off'}`, title: 'Show/hide', html: icon(layer.visible ? 'eye' : 'eyeOff') });
      const lock = h('button', { class: `icon-btn tiny ${layer.locked ? 'on' : 'dimmed'}`, title: 'Lock/unlock', html: icon(layer.locked ? 'lock' : 'unlock') });
      const outline = h('button', { class: `tl-outline ${layer.outline ? 'on' : ''}`, title: 'Outline mode (click) / color (right-click)', style: `--lc:${layer.color}` });
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.altKey) { store.transact('Show Only', () => { for (const l of store.timeline().layers) l.visible = l === layer || l.type === 'folder'; }); return; }
        store.transact(layer.visible ? 'Hide Layer' : 'Show Layer', () => { layer.visible = !layer.visible; });
      });
      lock.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.altKey) { store.transact('Lock Others', () => { for (const l of store.timeline().layers) l.locked = l !== layer; }); return; }
        store.transact(layer.locked ? 'Unlock Layer' : 'Lock Layer', () => { layer.locked = !layer.locked; });
      });
      outline.addEventListener('click', (e) => { e.stopPropagation(); store.transact('Outline', () => { layer.outline = !layer.outline; }); });
      outline.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        openPicker(outline, { color: layer.color, alpha: 1, none: false }, (v, final) => { if (final) store.transact('Layer Color', () => { layer.color = v.color; }); }, undefined, false);
      });
      const rowEl = h('div', {
        class: `tl-layer${isCur ? ' current' : ''}${sel.has(layer.id) ? ' selected' : ''}${layer.type === 'folder' ? ' folder' : ''}`,
        'data-id': layer.id,
        style: `padding-left:${4 + depth * 14}px`,
      }, caret, h('span', { class: 'tl-type', html: icon(typeIcon) }), name, eye, lock, outline);
      rowEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
        if (e.shiftKey && store.frameSel) {
          const ids = new Set(store.frameSel.layerIds);
          ids.add(layer.id);
          store.frameSel = { ...store.frameSel, layerIds: [...ids] };
          store.emit('frame');
        } else {
          store.setLayer(layer.id);
          const len = Math.max(1, layerLength(layer));
          store.frameSel = { layerIds: [layer.id], f0: 0, f1: len - 1 };
          store.clearSelection();
          store.emit('frame');
        }
        this.layerDrag = { id: layer.id, startY: e.clientY, started: false, target: -1, into: null };
      });
      rowEl.addEventListener('dblclick', (e) => {
        if (!(e.target as HTMLElement).closest('.tl-name, .tl-type')) return;
        e.stopPropagation();
        this.renameLayer(layer, name);
      });
      rowEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        store.setLayer(layer.id);
        contextMenu(this.layerMenu(layer, name), e.clientX, e.clientY);
      });
      this.layersBox.append(rowEl);
    }
    this.layersBox.append(h('div', { style: `height:${Math.max(0, 40)}px` }));
  }

  private layerDragMove(e: PointerEvent) {
    const d = this.layerDrag;
    if (!d) return;
    if (!d.started && Math.abs(e.clientY - d.startY) < 4) return;
    d.started = true;
    const r = this.layersBox.getBoundingClientRect();
    const y = e.clientY - r.top + this.layersBox.scrollTop;
    const idx = Math.max(0, Math.min(this.rows.length, Math.round(y / ROW_H)));
    d.target = idx;
    // dropping onto the middle of a folder row moves into the folder
    const over = this.rows[Math.floor(y / ROW_H)];
    const within = (y % ROW_H) / ROW_H;
    d.into = over && over.layer.type === 'folder' && within > 0.25 && within < 0.75 && over.layer.id !== d.id ? over.layer.id : null;
    this.layersBox.querySelectorAll('.drop-before, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-into'));
    const rowsEls = this.layersBox.querySelectorAll('.tl-layer');
    if (d.into) rowsEls[Math.floor(y / ROW_H)]?.classList.add('drop-into');
    else rowsEls[idx]?.classList.add('drop-before');
  }

  private layerDragEnd() {
    const d = this.layerDrag;
    this.layerDrag = null;
    if (!d || !d.started) return;
    const tl = store.timeline();
    const moving = tl.layers.find((l) => l.id === d.id);
    if (!moving) return;
    store.transact('Move Layer', () => {
      // collect the layer and (for folders/masks) its descendants
      const group: Layer[] = [moving];
      let grew = true;
      while (grew) {
        grew = false;
        for (const l of tl.layers) if (l.parentId && group.some((g) => g.id === l.parentId) && !group.includes(l)) { group.push(l); grew = true; }
      }
      const ordered = tl.layers.filter((l) => group.includes(l));
      const targetRow = this.rows[d.target];
      const rest = tl.layers.filter((l) => !group.includes(l));
      let insertAt: number;
      if (d.into) {
        const folderIdx = rest.findIndex((l) => l.id === d.into);
        insertAt = folderIdx + 1;
        moving.parentId = d.into;
      } else {
        insertAt = targetRow ? rest.indexOf(targetRow.layer) : rest.length;
        if (insertAt < 0) insertAt = rest.length;
        // adopt the parent of the row we dropped above
        const ref = targetRow?.layer ?? null;
        const refParent = ref?.parentId ? tl.layers.find((l) => l.id === ref.parentId) : null;
        if (moving.type !== 'mask' || !refParent) moving.parentId = ref && !group.includes(ref) ? (refParent && refParent.id !== moving.id ? refParent.id : null) : moving.parentId;
      }
      rest.splice(insertAt, 0, ...ordered);
      tl.layers = rest;
    });
  }

  private renameLayer(layer: Layer, nameEl: HTMLElement) {
    // the row may have been re-rendered since the event: find the live element
    const live = this.layersBox.querySelector<HTMLElement>(`.tl-layer[data-id="${layer.id}"] .tl-name`) ?? nameEl;
    const input = h('input', { class: 'tl-rename', type: 'text', value: layer.name, spellcheck: false }) as HTMLInputElement;
    live.replaceWith(input);
    this.renaming = true;
    input.focus(); input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      this.renaming = false;
      const v = input.value.trim();
      const target = store.timeline().layers.find((l) => l.id === layer.id);
      if (save && v && target && v !== target.name) store.transact('Rename Layer', () => { target.name = v; });
      else this.renderLayers();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
  }

  private layerMenu(layer: Layer, nameEl: HTMLElement): MenuItem[] {
    return [
      { label: 'Rename', action: () => this.renameLayer(layer, nameEl) },
      { label: 'Insert Layer', action: () => store.addLayer('normal') },
      { label: 'Insert Folder', action: () => store.addLayer('folder') },
      { label: 'Delete Layer', action: () => store.deleteLayers([layer.id]) },
      { label: 'Duplicate Layer', action: () => this.duplicateLayer(layer) },
      SEP,
      { label: 'Mask', checked: layer.type === 'mask', enabled: layer.type !== 'folder', action: () => A.convertLayerType('mask') },
      { label: 'Guide', checked: layer.type === 'guide', enabled: layer.type !== 'folder', action: () => A.convertLayerType('guide') },
      SEP,
      { label: 'Hide Others', action: () => store.transact('Hide Others', () => { for (const l of store.timeline().layers) l.visible = l === layer || l.type === 'folder'; }) },
      { label: 'Lock Others', action: () => store.transact('Lock Others', () => { for (const l of store.timeline().layers) l.locked = l !== layer; }) },
      { label: 'Show All', action: () => store.transact('Show All', () => { for (const l of store.timeline().layers) { l.visible = true; } }) },
    ];
  }

  private duplicateLayer(layer: Layer) {
    const tl = store.timeline();
    store.transact('Duplicate Layer', () => {
      const copy: Layer = structuredClone(layer);
      copy.id = uid();
      copy.name = `${layer.name} copy`;
      for (const f of copy.frames) f.elements = cloneElements(f.elements);
      tl.layers.splice(tl.layers.indexOf(layer), 0, copy);
      store.ctx.layerId = copy.id;
    });
  }

  // ---------------- frames grid ----------------
  private request() {
    if (this.queued) return;
    this.queued = true;
    requestAnimationFrame(() => { this.queued = false; this.draw(); });
  }

  private cellAt(e: PointerEvent | MouseEvent): { row: number; frame: number } {
    const r = this.framesScroll.getBoundingClientRect();
    const x = e.clientX - r.left + this.framesScroll.scrollLeft;
    const y = e.clientY - r.top + this.framesScroll.scrollTop;
    return { row: Math.floor(y / ROW_H), frame: Math.max(0, Math.floor(x / this.cellW)) };
  }

  private bindFrames() {
    const s = this.framesScroll;
    s.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (store.playing) this.stage.stop();
      const { row, frame } = this.cellAt(e);
      const info = this.rows[row];
      if (!info) { store.frameSel = null; store.emit('frame'); return; }
      s.setPointerCapture(e.pointerId);
      const fs = store.frameSel;
      const inSel = fs && fs.layerIds.includes(info.layer.id) && frame >= Math.min(fs.f0, fs.f1) && frame <= Math.max(fs.f0, fs.f1);
      store.clearSelection();
      if (e.shiftKey && fs) {
        const r0 = this.rows.findIndex((r) => r.layer.id === fs.layerIds[0]);
        this.setFrameSel(Math.max(0, r0), fs.f0, row, frame);
        this.drag = { kind: 'select', l0: Math.max(0, r0), f0: fs.f0 };
        return;
      }
      const fr = frameAt(info.layer, frame);
      const isKeyStart = !!fr && fr.start === frame;
      if ((inSel && fs && (fs.f1 > fs.f0 || fs.layerIds.length > 1)) || (isKeyStart && !e.altKey)) {
        if (!inSel) this.setFrameSel(row, frame, row, frame);
        store.setLayer(info.layer.id);
        store.setFrame(frame);
        this.drag = { kind: 'move', l0: row, f0: frame, delta: 0, dl: 0, started: false, x: e.clientX };
        return;
      }
      store.setLayer(info.layer.id);
      store.setFrame(frame);
      this.setFrameSel(row, frame, row, frame);
      this.drag = { kind: 'select', l0: row, f0: frame };
    });
    s.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.kind === 'scrub') return;
      const { row, frame } = this.cellAt(e);
      if (d.kind === 'select') {
        this.setFrameSel(d.l0, d.f0, Math.max(0, Math.min(this.rows.length - 1, row)), frame);
        store.setFrame(frame);
      } else {
        if (!d.started && Math.abs(e.clientX - d.x) < 4) return;
        d.started = true;
        d.delta = frame - d.f0;
        this.request();
      }
      this.autoScroll(e);
    });
    s.addEventListener('pointerup', () => {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === 'move' && d.started && d.delta !== 0 && store.frameSel) {
        const fs = store.frameSel;
        const f0 = Math.min(fs.f0, fs.f1), f1 = Math.max(fs.f0, fs.f1);
        const delta = Math.max(-f0, d.delta);
        const tl = store.timeline();
        store.transact('Move Frames', () => {
          for (const l of tl.layers) if (fs.layerIds.includes(l.id) && !l.locked) moveFrames(l, f0, f1, delta);
        });
        store.frameSel = { ...fs, f0: f0 + delta, f1: f1 + delta };
        store.setFrame(f0 + delta);
        store.emit('frame');
      } else if (d?.kind === 'move' && !d.started) {
        const { row } = { row: d.l0 };
        this.setFrameSel(row, d.f0, row, d.f0);
      }
      this.request();
    });
    s.addEventListener('dblclick', (e) => {
      const { row, frame } = this.cellAt(e);
      const info = this.rows[row];
      if (!info) { store.addLayer('normal'); return; }
      const fr = frameAt(info.layer, frame);
      if (fr) this.setFrameSel(row, fr.start, row, fr.start + fr.duration - 1);
    });
    s.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const { row, frame } = this.cellAt(e);
      const info = this.rows[row];
      if (!info) return;
      const fs = store.frameSel;
      const inSel = fs && fs.layerIds.includes(info.layer.id) && frame >= Math.min(fs.f0, fs.f1) && frame <= Math.max(fs.f0, fs.f1);
      if (!inSel) { store.setLayer(info.layer.id); store.setFrame(frame); this.setFrameSel(row, frame, row, frame); }
      contextMenu(this.frameMenu(), e.clientX, e.clientY);
    });
  }

  frameMenu(): MenuItem[] {
    return [
      { label: 'Create Classic Tween', action: () => A.createTween('classic') },
      { label: 'Create Shape Tween', action: () => A.createTween('shape') },
      { label: 'Remove Tween', action: () => A.createTween('none') },
      SEP,
      { label: 'Insert Frame', shortcut: 'F5', action: () => A.insertFrame() },
      { label: 'Remove Frames', shortcut: 'Shift+F5', action: () => A.removeFramesCmd() },
      SEP,
      { label: 'Insert Keyframe', shortcut: 'F6', action: () => A.insertKeyframeCmd(false) },
      { label: 'Insert Blank Keyframe', shortcut: 'F7', action: () => A.insertKeyframeCmd(true) },
      { label: 'Clear Keyframe', shortcut: 'Shift+F6', action: () => A.clearKeyframeCmd() },
      { label: 'Convert to Keyframes', action: () => A.insertKeyframeCmd(false) },
      SEP,
      { label: 'Cut Frames', shortcut: 'Mod+Alt+X', action: () => A.copyFramesCmd(true) },
      { label: 'Copy Frames', shortcut: 'Mod+Alt+C', action: () => A.copyFramesCmd(false) },
      { label: 'Paste Frames', shortcut: 'Mod+Alt+V', action: () => A.pasteFramesCmd(false) },
      { label: 'Paste and Insert Frames', action: () => A.pasteFramesCmd(true) },
      SEP,
      { label: 'Reverse Frames', action: () => A.reverseFramesCmd() },
      { label: 'Select All Frames', shortcut: 'Mod+Alt+A', action: () => A.selectAllFrames() },
    ];
  }

  private setFrameSel(r0: number, f0: number, r1: number, f1: number) {
    const lo = Math.min(r0, r1), hi = Math.max(r0, r1);
    const ids = this.rows.slice(lo, hi + 1).map((r) => r.layer.id);
    store.frameSel = { layerIds: ids, f0: Math.min(f0, f1), f1: Math.max(f0, f1) };
    store.emit('frame');
    this.request();
  }

  private autoScroll(e: PointerEvent) {
    const s = this.framesScroll;
    const r = s.getBoundingClientRect();
    if (e.clientX > r.right - 20) s.scrollLeft += this.cellW;
    else if (e.clientX < r.left + 20) s.scrollLeft -= this.cellW;
  }

  private bindRuler() {
    const scrub = (e: PointerEvent) => {
      const r = this.ruler.getBoundingClientRect();
      const x = e.clientX - r.left + this.framesScroll.scrollLeft;
      store.setFrame(Math.max(0, Math.floor(x / this.cellW)));
    };
    this.ruler.addEventListener('pointerdown', (e) => {
      if (store.playing) this.stage.stop();
      this.ruler.setPointerCapture(e.pointerId);
      this.drag = { kind: 'scrub' };
      scrub(e);
    });
    this.ruler.addEventListener('pointermove', (e) => { if (this.drag?.kind === 'scrub') scrub(e); });
    this.ruler.addEventListener('pointerup', () => { this.drag = null; });
  }

  private draw() {
    const dpr = window.devicePixelRatio || 1;
    const s = this.framesScroll;
    const W = s.clientWidth, H = s.clientHeight;
    const c = this.canvas;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
      c.style.width = W + 'px'; c.style.height = H + 'px';
    }
    const rw = Math.round(W * dpr), rh = Math.round(RULER_H * dpr);
    if (this.ruler.width !== rw || this.ruler.height !== rh) {
      this.ruler.width = rw; this.ruler.height = rh;
      this.ruler.style.width = W + 'px'; this.ruler.style.height = RULER_H + 'px';
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cw = this.cellW;
    const sx = s.scrollLeft, sy = s.scrollTop;
    const firstF = Math.floor(sx / cw), lastF = Math.ceil((sx + W) / cw);
    const tl = store.timeline();
    const total = timelineFrameCount(tl);
    ctx.fillStyle = '#262626';
    ctx.fillRect(0, 0, W, H);
    // column shading every 5 frames
    for (let f = firstF; f <= lastF; f++) {
      const x = f * cw - sx;
      if ((f + 1) % 5 === 0) { ctx.fillStyle = '#2c2c2c'; ctx.fillRect(x, 0, cw, H); }
    }
    const fs = store.frameSel;
    const curLayer = store.layer();
    const firstRow = Math.floor(sy / ROW_H), lastRow = Math.min(this.rows.length - 1, Math.ceil((sy + H) / ROW_H));
    const moveDelta = this.drag?.kind === 'move' && this.drag.started ? this.drag.delta : 0;
    for (let ri = firstRow; ri <= lastRow; ri++) {
      const info = this.rows[ri];
      if (!info) continue;
      const layer = info.layer;
      const y = ri * ROW_H - sy;
      if (layer.id === curLayer?.id) { ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fillRect(0, y, W, ROW_H); }
      ctx.strokeStyle = '#1b1b1b';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y + ROW_H - 0.5); ctx.lineTo(W, y + ROW_H - 0.5); ctx.stroke();
      if (layer.type === 'folder') continue;
      const frames = layer.frames;
      for (let i = 0; i < frames.length; i++) {
        const fr = frames[i];
        const a = fr.start, b = fr.start + fr.duration - 1;
        if (b < firstF || a > lastF) continue;
        this.drawSpan(ctx, fr, frames[i + 1], a, b, y, sx, layer);
      }
      // selection
      if (fs && fs.layerIds.includes(layer.id)) {
        const f0 = Math.min(fs.f0, fs.f1) + moveDelta, f1 = Math.max(fs.f0, fs.f1) + moveDelta;
        ctx.fillStyle = moveDelta ? 'rgba(46,155,255,0.25)' : 'rgba(46,155,255,0.45)';
        ctx.fillRect(f0 * cw - sx, y + 1, (f1 - f0 + 1) * cw, ROW_H - 2);
        if (moveDelta) { ctx.strokeStyle = '#2E9BFF'; ctx.strokeRect(f0 * cw - sx + 0.5, y + 1.5, (f1 - f0 + 1) * cw - 1, ROW_H - 3); }
      }
    }
    // end of timeline marker
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    const endX = total * cw - sx;
    if (endX < W) ctx.fillRect(endX, 0, W - endX, H);
    // playhead
    const px = store.frame * cw - sx + cw / 2;
    ctx.strokeStyle = '#FF3B3B';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); ctx.stroke();
    this.drawRuler(firstF, lastF, sx, W, dpr);
  }

  private drawSpan(ctx: CanvasRenderingContext2D, fr: Frame, next: Frame | undefined, a: number, b: number, y: number, sx: number, layer: Layer) {
    const cw = this.cellW;
    const x0 = a * cw - sx, x1 = (b + 1) * cw - sx;
    const empty = fr.elements.length === 0;
    let bg = empty ? '#363636' : '#5b5b5b';
    if (fr.tween === 'classic') bg = '#5a4a86';
    else if (fr.tween === 'shape') bg = '#3f6b45';
    ctx.fillStyle = bg;
    ctx.fillRect(x0, y + 1, x1 - x0, ROW_H - 2);
    // frame dividers inside span for readability when wide
    if (cw >= 10) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      for (let f = a + 1; f <= b; f++) { const x = f * cw - sx + 0.5; ctx.moveTo(x, y + 4); ctx.lineTo(x, y + ROW_H - 4); }
      ctx.stroke();
    }
    ctx.strokeStyle = '#1e1e1e';
    ctx.strokeRect(x0 + 0.5, y + 1.5, x1 - x0 - 1, ROW_H - 3);
    // tween arrow / broken tween
    if (fr.tween !== 'none' && b > a) {
      const valid = fr.tween === 'classic' ? classicTweenValid(fr, next) : shapeTweenValid(fr, next);
      ctx.strokeStyle = valid ? '#e8e8e8' : '#e8e8e8';
      ctx.setLineDash(valid ? [] : [3, 3]);
      ctx.beginPath();
      const my = y + ROW_H / 2 + 0.5;
      ctx.moveTo(x0 + cw, my); ctx.lineTo(x1 - 4, my);
      ctx.stroke();
      ctx.setLineDash([]);
      if (valid) {
        ctx.beginPath(); ctx.moveTo(x1 - 4, my); ctx.lineTo(x1 - 8, my - 3); ctx.lineTo(x1 - 8, my + 3); ctx.closePath();
        ctx.fillStyle = '#e8e8e8'; ctx.fill();
      }
    }
    // keyframe dot
    const cx = x0 + cw / 2, cy = y + ROW_H - 7;
    ctx.beginPath(); ctx.arc(cx, cy, Math.min(3.5, cw / 2 - 1), 0, Math.PI * 2);
    if (empty) { ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1.2; ctx.stroke(); }
    else { ctx.fillStyle = '#ececec'; ctx.fill(); }
    // end-of-span marker
    if (b > a && fr.tween === 'none') {
      ctx.strokeStyle = '#ddd';
      ctx.strokeRect((b * cw - sx) + cw / 2 - 2.5 + 0.5, y + ROW_H - 10.5, 5, 7);
    }
    // label / script
    if (fr.label) {
      ctx.fillStyle = fr.labelType === 'comment' ? '#7ac943' : '#ff5a5a';
      ctx.beginPath(); ctx.moveTo(x0 + 3, y + 4); ctx.lineTo(x0 + 3, y + 12); ctx.moveTo(x0 + 3, y + 4); ctx.lineTo(x0 + 9, y + 6.5); ctx.lineTo(x0 + 3, y + 9);
      ctx.strokeStyle = ctx.fillStyle; ctx.stroke(); ctx.fill();
      if (x1 - x0 > 30) {
        ctx.fillStyle = '#f0f0f0';
        ctx.font = '10px system-ui, sans-serif';
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y, x1 - x0 - 2, ROW_H); ctx.clip();
        ctx.fillText(fr.labelType === 'comment' ? `// ${fr.label}` : fr.label, x0 + 11, y + 12);
        ctx.restore();
      }
    }
    if (fr.script && fr.script.trim()) {
      ctx.fillStyle = '#ffd24a';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.fillText('a', x0 + (fr.label ? cw : 2), y + 10);
    }
    void layer;
  }

  private drawRuler(firstF: number, lastF: number, sx: number, W: number, dpr: number) {
    const ctx = this.ruler.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#2d2d2d';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = '#555';
    ctx.fillStyle = '#aaa';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const cw = this.cellW;
    const labelEvery = cw >= 10 ? 5 : cw >= 6 ? 10 : 20;
    ctx.beginPath();
    for (let f = firstF; f <= lastF; f++) {
      const x = Math.round(f * cw - sx) + 0.5;
      const n = f + 1;
      ctx.moveTo(x, RULER_H); ctx.lineTo(x, n % 5 === 0 || n === 1 ? RULER_H - 7 : RULER_H - 3);
      if (n % labelEvery === 0 || n === 1) ctx.fillText(String(n), x + cw / 2, 11);
    }
    ctx.stroke();
    // playhead head
    const px = store.frame * cw - sx;
    ctx.fillStyle = '#FF3B3B';
    ctx.fillRect(px, 1, cw, RULER_H - 2);
    ctx.fillStyle = '#fff';
    if (cw >= 8) ctx.fillText(String(store.frame + 1), px + cw / 2, 15);
    ctx.textAlign = 'left';
  }
}

export { numField };
