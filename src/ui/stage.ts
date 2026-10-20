// The stage view: renders the document and routes pointer input to tools.
import type { Element, Matrix, Rect } from '../core/types';
import { apply, invert, multiply, setCtx, transformRect, isEmptyRect, inflateRect } from '../core/matrix';
import { renderTimeline, type RenderEnv, type Ctx2D } from '../core/render';
import { IDENTITY_CT } from '../core/util';
import { elementBounds, hitElement } from '../core/geometry';
import { store, ui, setUI, onUI } from './state';
import { tools, type Tool, type ToolEvent } from './tools';
import { timelineFrameCount } from '../core/timeline';
import { h } from './dom';
import { toPath2D } from '../core/path';
import { SUB, isMerge } from '../core/merge';
import { frameAt } from '../core/timeline';
import { motionKeyOffsets, motionPath } from '../core/motion';
import { video } from './video';
import { audio } from './audio';

let hatch: CanvasPattern | null = null;
/** Animate-style dot pattern drawn over selected parts of raw shapes. */
function hatchPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (hatch) return hatch;
  const c = document.createElement('canvas');
  c.width = c.height = 4;
  const x = c.getContext('2d')!;
  x.fillStyle = 'rgba(255,255,255,0.55)';
  x.fillRect(0, 0, 4, 4);
  x.fillStyle = 'rgba(0,0,0,0.85)';
  x.fillRect(0, 0, 1, 1); x.fillRect(2, 2, 1, 1);
  hatch = ctx.createPattern(c, 'repeat');
  return hatch;
}

const PASTEBOARD = '#2a2a2a';
const SEL_COLOR = '#2E9BFF';

export class Stage {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  overlayHost: HTMLDivElement;
  dpr = 1;
  width = 0;
  height = 0;
  private renderQueued = false;
  private spaceDown = false;
  private panning: { x: number; y: number; view: Matrix } | null = null;
  private activePointer: number | null = null;
  private lastMove: ToolEvent | null = null;
  hoverId: string | null = null;
  private playTimer = 0;
  private playStart = 0;
  private playStartFrame = 0;
  private playElapsed = 0;
  onPlayState: ((playing: boolean) => void) | null = null;

  constructor(host: HTMLElement) {
    this.el = h('div', { class: 'stage-wrap', tabindex: '0' });
    this.canvas = h('canvas', { class: 'stage-canvas' });
    this.overlayHost = h('div', { class: 'stage-overlays' });
    this.el.append(this.canvas, this.overlayHost);
    host.append(this.el);
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.resize();
    this.bindInput();
    store.on(() => this.requestRender());
    video.onFrame = () => this.requestRender();
    onUI((k) => { if (k !== 'recentColors') this.requestRender(); if (k === 'tool') this.updateCursor(); });
  }

  // ---------------- view ----------------
  resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const first = this.width === 0;
    this.width = Math.max(1, Math.round(r.width));
    this.height = Math.max(1, Math.round(r.height));
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    if (first && this.width > 1) this.fitStage();
    this.requestRender();
  }

  fitStage() {
    const d = store.doc;
    const pad = 40;
    const z = Math.max(0.05, Math.min((this.width - pad * 2) / d.width, (this.height - pad * 2) / d.height, 4));
    this.setView(z, (this.width - d.width * z) / 2, (this.height - d.height * z) / 2);
  }

  centerStage(zoom = ui.zoom) {
    const d = store.doc;
    this.setView(zoom, (this.width - d.width * zoom) / 2, (this.height - d.height * zoom) / 2);
  }

  setView(zoom: number, tx: number, ty: number) {
    zoom = Math.max(0.04, Math.min(64, zoom));
    setUI('view', { a: zoom, b: 0, c: 0, d: zoom, tx, ty });
    setUI('zoom', zoom);
  }

  zoomAt(factor: number, sx = this.width / 2, sy = this.height / 2) {
    const v = ui.view;
    const z = Math.max(0.04, Math.min(64, ui.zoom * factor));
    const k = z / ui.zoom;
    this.setView(z, sx - (sx - v.tx) * k, sy - (sy - v.ty) * k);
  }

  zoomToRect(r: Rect) {
    if (r.w < 2 || r.h < 2) return;
    const z = Math.max(0.04, Math.min(64, Math.min(this.width / r.w, this.height / r.h) * 0.9));
    this.setView(z, this.width / 2 - (r.x + r.w / 2) * z, this.height / 2 - (r.y + r.h / 2) * z);
  }

  /** Matrix from current edit space (symbol/group) to CSS pixels. */
  editToScreen(): Matrix {
    return multiply(ui.view, multiply(store.contextMatrix(), store.groupMatrix()));
  }

  /** Matrix from current timeline space (symbol, ignoring group) to CSS pixels. */
  timelineToScreen(): Matrix {
    return multiply(ui.view, store.contextMatrix());
  }

  screenToEdit(sx: number, sy: number) {
    return apply(invert(this.editToScreen()), sx, sy);
  }

  get pxSize() {
    // size of one screen pixel in edit space
    const m = this.editToScreen();
    return 1 / (Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1);
  }

  env(): RenderEnv {
    return { lib: store.lib, assets: store.assets, playback: store.playing, includeHidden: false, showGuides: true, outlines: true, authoring: true, videoFrame: (n, o) => video.frameSync(n, o) };
  }

  // ---------------- rendering ----------------
  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      try { this.render(); } catch (e) { console.error('render failed', e); }
    });
  }

  render() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = PASTEBOARD;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const devView = multiply({ a: dpr, b: 0, c: 0, d: dpr, tx: 0, ty: 0 }, ui.view);
    const doc = store.doc;
    const inSymbol = store.stack.length > 1;
    const inPlace = inSymbol && store.ctx.parentVisible;

    // stage rectangle
    if (!inSymbol || inPlace) {
      setCtx(ctx, devView);
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 12 * dpr;
      ctx.fillStyle = doc.background;
      ctx.fillRect(0, 0, doc.width, doc.height);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }

    const env = this.env();
    if (ui.clipToStage && !inSymbol) {
      ctx.save();
      setCtx(ctx, devView);
      ctx.beginPath();
      ctx.rect(0, 0, doc.width, doc.height);
      ctx.clip();
    }

    if (inPlace) {
      // parent timelines dimmed (edit in place)
      ctx.globalAlpha = 0.35;
      const parentEntry = store.stack[store.stack.length - 2];
      const parentTl = this.timelineOf(parentEntry.symbol);
      if (parentTl) renderTimeline(ctx, parentTl, parentEntry.frame, multiply(devView, parentEntry.matrix), IDENTITY_CT, env, { offset: parentEntry.frame, elapsed: parentEntry.frame, spanAll: true, playback: false });
      ctx.globalAlpha = 1;
    }

    const tl = store.timeline();
    const tlM = multiply(devView, store.contextMatrix());
    const frame = store.frame;

    // onion skin
    if (ui.onion && !store.playing) {
      const len = timelineFrameCount(tl);
      for (let k = ui.onionBefore; k >= 1; k--) this.renderOnion(tl, frame - k, tlM, env, '#3060FF', k, ui.onionBefore);
      for (let k = ui.onionAfter; k >= 1; k--) if (frame + k < len) this.renderOnion(tl, frame + k, tlM, env, '#20B040', k, ui.onionAfter);
    }

    if (store.ctx.groupPath.length) {
      // dim everything but the group being edited
      ctx.globalAlpha = 0.4;
      renderTimeline(ctx, tl, frame, tlM, IDENTITY_CT, env, { offset: frame, elapsed: this.playElapsed || frame, spanAll: true, playback: store.playing });
      ctx.globalAlpha = 1;
      const g = store.groupTarget();
      if (g) {
        const gm = multiply(tlM, store.groupMatrix());
        for (const c of g.children) {
          renderElementSafe(ctx, c, gm, env);
        }
      }
    } else {
      renderTimeline(ctx, tl, frame, tlM, IDENTITY_CT, env, { offset: frame, elapsed: this.playElapsed || frame, spanAll: true, playback: store.playing });
    }

    if (ui.clipToStage && !inSymbol) ctx.restore();

    if (inSymbol && !inPlace) {
      // registration crosshair
      const p = apply(tlM, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.strokeStyle = '#ccc';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(p.x - 8 * dpr, p.y); ctx.lineTo(p.x + 8 * dpr, p.y);
      ctx.moveTo(p.x, p.y - 8 * dpr); ctx.lineTo(p.x, p.y + 8 * dpr);
      ctx.stroke();
    }

    if (ui.showGrid) this.drawGrid(devView);
    if (!store.playing) this.drawSelection();
    const tool = this.currentTool();
    if (tool.overlay) {
      ctx.save();
      tool.overlay(ctx, multiply({ a: dpr, b: 0, c: 0, d: dpr, tx: 0, ty: 0 }, this.editToScreen()), this);
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private timelineOf(symbol: string | null) {
    if (!symbol) return store.scene();
    const it = store.lib.get(symbol);
    return it && it.kind === 'symbol' ? it.timeline : null;
  }

  private onionCanvas: HTMLCanvasElement | null = null;
  private renderOnion(tl: ReturnType<typeof store.timeline>, f: number, m: Matrix, env: RenderEnv, color: string, k: number, n: number) {
    if (f < 0) return;
    const w = this.canvas.width, hgt = this.canvas.height;
    if (!this.onionCanvas) this.onionCanvas = document.createElement('canvas');
    const oc = this.onionCanvas;
    if (oc.width !== w || oc.height !== hgt) { oc.width = w; oc.height = hgt; }
    const octx = oc.getContext('2d')!;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, w, hgt);
    renderTimeline(octx, tl, f, m, IDENTITY_CT, { ...env, outlines: false }, { offset: f, elapsed: f, spanAll: true, playback: false });
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.globalCompositeOperation = 'source-atop';
    octx.globalAlpha = 0.55;
    octx.fillStyle = color;
    octx.fillRect(0, 0, w, hgt);
    octx.globalAlpha = 1;
    octx.globalCompositeOperation = 'source-over';
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 0.45 * (1 - (k - 1) / Math.max(1, n));
    this.ctx.drawImage(oc, 0, 0);
    this.ctx.globalAlpha = 1;
  }

  private drawGrid(devView: Matrix) {
    const ctx = this.ctx;
    const step = 20;
    const z = devView.a;
    if (step * z < 6) return;
    ctx.save();
    setCtx(ctx, devView);
    ctx.strokeStyle = 'rgba(128,128,128,0.25)';
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    const d = store.doc;
    for (let x = 0; x <= d.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, d.height); }
    for (let y = 0; y <= d.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(d.width, y); }
    ctx.stroke();
    ctx.restore();
  }

  private drawSelection() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    const m = multiply({ a: dpr, b: 0, c: 0, d: dpr, tx: 0, ty: 0 }, this.editToScreen());
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const tool = ui.tool;
    const sel = store.selected();
    // hover highlight
    if (this.hoverId && !sel.some((s) => s.el.id === this.hoverId) && (tool === 'select' || tool === 'subselect')) {
      const f = store.findElement(this.hoverId);
      if (f && !isMerge(f.el)) {
        const r = transformRect(m, elementBounds(f.el, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, store.lib));
        if (!isEmptyRect(r)) {
          ctx.strokeStyle = 'rgba(46,155,255,0.6)';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
        }
      }
    }
    // motion tween paths of selected tweened objects
    if (!store.ctx.groupPath.length) {
      for (const s of sel) {
        const fr = frameAt(s.layer, store.frame);
        if (!fr || fr.tween !== 'motion' || !fr.motion || fr.elements[0]?.id !== s.el.id || fr.duration < 2) continue;
        const pts = motionPath(fr).map((p) => apply(m, p.x, p.y));
        ctx.strokeStyle = s.layer.color || SEL_COLOR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
        const keys = new Set(motionKeyOffsets(fr.motion));
        pts.forEach((p, i) => {
          ctx.fillStyle = keys.has(i) ? '#000' : s.layer.color || SEL_COLOR;
          const r = keys.has(i) ? 3 : 1.6;
          ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
        });
      }
    }
    if (tool === 'transform') return; // the transform tool draws its own box
    for (const s of sel) {
      if (s.el.type === 'shape' && (s.el.id.startsWith(SUB) || s.el.lifted)) {
        // selected part of a raw shape: dot pattern over its fills and strokes
        const pat = hatchPattern(ctx);
        if (!pat) continue;
        const mm = multiply(m, s.el.matrix);
        ctx.save();
        setCtx(ctx, mm);
        const sc = Math.sqrt(Math.abs(mm.a * mm.d - mm.b * mm.c)) || 1;
        pat.setTransform(new DOMMatrix([1 / sc, 0, 0, 1 / sc, 0, 0]));
        ctx.fillStyle = pat;
        ctx.strokeStyle = pat;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const p of s.el.paths) {
          const path = toPath2D(p.d);
          if (p.fill) ctx.fill(path);
          if (p.stroke) { ctx.lineWidth = Math.max(p.stroke.width, 3 / sc); ctx.stroke(path); }
        }
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        continue;
      }
      const r = inflateRect(transformRect(m, elementBounds(s.el, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, store.lib)), 1);
      if (isEmptyRect(r)) continue;
      ctx.strokeStyle = s.layer.color || SEL_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(r.x) + 0.5, Math.round(r.y) + 0.5, Math.round(r.w), Math.round(r.h));
      if (s.el.type === 'symbol') {
        // registration point (+) and transformation point (o)
        const reg = apply(multiply(m, s.el.matrix), 0, 0);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(reg.x - 4, reg.y); ctx.lineTo(reg.x + 4, reg.y);
        ctx.moveTo(reg.x, reg.y - 4); ctx.lineTo(reg.x, reg.y + 4);
        ctx.stroke();
        const tp = apply(multiply(m, s.el.matrix), s.el.transformPoint.x, s.el.transformPoint.y);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath(); ctx.arc(tp.x, tp.y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#000'; ctx.stroke();
      }
    }
  }

  // ---------------- playback ----------------
  play() {
    if (store.playing) return;
    const len = timelineFrameCount(store.timeline());
    if (len <= 1) return;
    if (store.frame >= len - 1) store.setFrame(0);
    store.playing = true;
    void audio.playTimeline(store.timeline(), store.frame, store.doc.fps);
    this.playStart = performance.now();
    this.playStartFrame = store.frame;
    this.playElapsed = store.frame;
    const tick = () => {
      if (!store.playing) return;
      const len2 = timelineFrameCount(store.timeline());
      const elapsedFrames = Math.floor(((performance.now() - this.playStart) / 1000) * store.doc.fps);
      let f = this.playStartFrame + elapsedFrames;
      this.playElapsed = f;
      if (f >= len2) {
        if (ui.loop) {
          // restart the clock (and the sounds) at each loop
          f = f % len2;
          this.playStart = performance.now() - (f / store.doc.fps) * 1000;
          this.playStartFrame = 0;
          void audio.playTimeline(store.timeline(), f, store.doc.fps);
        } else { store.setFrame(len2 - 1); this.stop(); return; }
      }
      if (f !== store.frame) store.setFrame(f);
      this.playTimer = requestAnimationFrame(tick);
    };
    this.playTimer = requestAnimationFrame(tick);
    this.onPlayState?.(true);
    store.emit('play');
  }

  stop() {
    if (!store.playing) return;
    store.playing = false;
    audio.stop();
    this.playElapsed = 0;
    cancelAnimationFrame(this.playTimer);
    this.onPlayState?.(false);
    store.emit('play');
    this.requestRender();
  }

  togglePlay() { if (store.playing) this.stop(); else this.play(); }

  // ---------------- hit testing ----------------
  /** Topmost selectable element at an edit-space point. */
  hitTest(x: number, y: number): { layer: ReturnType<typeof store.layer>; el: Element } | null {
    const tol = 3 * this.pxSize;
    for (const s of store.selectable()) {
      if (hitElement(s.el, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, x, y, store.lib, tol)) return s;
    }
    return null;
  }

  currentTool(): Tool {
    if (this.spaceDown || this.panning) return tools.hand;
    return tools[ui.tool];
  }

  updateCursor() {
    this.canvas.style.cursor = this.currentTool().cursor(this);
  }

  // ---------------- input ----------------
  private toolEvent(e: PointerEvent | MouseEvent): ToolEvent {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const p = this.screenToEdit(sx, sy);
    const pe = e as PointerEvent;
    return {
      x: p.x, y: p.y, sx, sy,
      shift: e.shiftKey, alt: e.altKey, mod: e.ctrlKey || e.metaKey,
      button: e.button,
      pressure: pe.pointerType === 'pen' ? (pe.pressure || 0.5) : 1,
      isPen: pe.pointerType === 'pen',
      detail: e.detail,
      native: e,
    };
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const te = this.toolEvent(e);
      this.currentTool().contextMenu?.(te, this);
    });
    c.addEventListener('pointerdown', (e) => {
      this.el.focus({ preventScroll: true });
      if (this.activePointer !== null) return;
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault();
        this.panning = { x: e.clientX, y: e.clientY, view: ui.view };
        c.setPointerCapture(e.pointerId);
        this.activePointer = e.pointerId;
        this.updateCursor();
        return;
      }
      if (e.button !== 0) return;
      if (store.playing) this.stop();
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.activePointer = e.pointerId;
      const te = this.toolEvent(e);
      this.lastMove = te;
      try { this.currentTool().down?.(te, this); } catch (err) { console.error(err); }
      this.requestRender();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.panning) {
        const v = this.panning.view;
        setUI('view', { ...v, tx: v.tx + e.clientX - this.panning.x, ty: v.ty + e.clientY - this.panning.y });
        return;
      }
      const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
      const pressed = this.activePointer === e.pointerId;
      for (const ev of events) {
        const te = this.toolEvent(ev);
        te.pressed = pressed;
        this.lastMove = te;
        try { this.currentTool().move?.(te, this); } catch (err) { console.error(err); }
      }
      if (!pressed && (ui.tool === 'select' || ui.tool === 'subselect')) {
        const te = this.toolEvent(e);
        const hit = this.hitTest(te.x, te.y);
        const id = hit ? hit.el.id : null;
        if (id !== this.hoverId) { this.hoverId = id; this.requestRender(); }
      }
      if (pressed || this.currentTool().overlay) this.requestRender();
    });
    const end = (e: PointerEvent) => {
      if (this.activePointer !== e.pointerId) return;
      this.activePointer = null;
      if (this.panning) { this.panning = null; this.updateCursor(); return; }
      const te = this.toolEvent(e);
      try { this.currentTool().up?.(te, this); } catch (err) { console.error(err); }
      this.requestRender();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', (e) => {
      if (this.activePointer !== e.pointerId) return;
      this.activePointer = null;
      this.panning = null;
      this.currentTool().cancel?.(this);
      if (store.isLive) store.commitLive('Edit');
      this.requestRender();
    });
    c.addEventListener('dblclick', (e) => {
      const te = this.toolEvent(e);
      try { this.currentTool().dblclick?.(te, this); } catch (err) { console.error(err); }
      this.requestRender();
    });
    c.addEventListener('pointerleave', () => { if (this.hoverId) { this.hoverId = null; this.requestRender(); } });
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        this.zoomAt(f, e.clientX - r.left, e.clientY - r.top);
      } else {
        const k = e.deltaMode === 1 ? 16 : 1;
        const dx = (e.shiftKey ? e.deltaY : e.deltaX) * k;
        const dy = (e.shiftKey ? 0 : e.deltaY) * k;
        setUI('view', { ...ui.view, tx: ui.view.tx - dx, ty: ui.view.ty - dy });
      }
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !this.spaceDown && document.activeElement && !isEditable(document.activeElement)) {
        this.spaceDown = true;
        this.updateCursor();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); }
    });
    window.addEventListener('blur', () => { this.spaceDown = false; this.updateCursor(); });
  }

  /** Called by the app's key handler for tool-specific keys. */
  toolKey(e: KeyboardEvent): boolean {
    const t = this.currentTool();
    return t.key ? t.key(e, this) : false;
  }

  lastPointer(): ToolEvent | null { return this.lastMove; }

  /** Center of the visible area in edit space (for pasting). */
  viewCenter() {
    return this.screenToEdit(this.width / 2, this.height / 2);
  }
}

function isEditable(el: globalThis.Element): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable;
}

import { renderElement } from '../core/render';
function renderElementSafe(ctx: Ctx2D, el: Element, m: Matrix, env: RenderEnv) {
  renderElement(ctx, el, m, IDENTITY_CT, env, { offset: store.frame, elapsed: store.frame, spanAll: true, playback: false }, 0);
}
