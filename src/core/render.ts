import type { ColorTransform, Element, Fill, FilterDef, Layer, Matrix, Stroke, SymbolInstance, Timeline } from './types';
import { invert, isEmptyRect, multiply, scaleFactor, setCtx, IDENTITY } from './matrix';
import { timelineBounds } from './geometry';
import { toPath2D } from './path';
import { resolveLayerFrame, timelineFrameCount } from './timeline';
import {
  applyCTColor, applyCTFill, applyCTStroke, concatCT, effectToTransform, isAlphaOnlyCT, isIdentityCT, rgba, IDENTITY_CT,
} from './util';
import { childContext, getBitmap, getSymbol, instanceFrame, layoutText, type FrameContext, type LibIndex } from './symbols';
import type { AssetStore } from './assets';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface RenderEnv {
  lib: LibIndex;
  assets: AssetStore;
  playback: boolean;      // movie clips animate
  includeHidden: boolean; // render hidden layers
  showGuides: boolean;    // render guide layers
  outlines: boolean;      // honour per-layer outline mode
  authoring?: boolean;    // stage editing: masks only apply when mask + masked layers are locked (like Animate)
}

export const ROOT_CONTEXT: FrameContext = { offset: 0, elapsed: 0, spanAll: true, playback: false };

const MAX_DEPTH = 24;

// ---------- offscreen canvas pool (used for masks) ----------
const pool: (OffscreenCanvas | HTMLCanvasElement)[] = [];
function borrowCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  let c = pool.pop();
  if (!c) c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const x = c.getContext('2d') as Ctx2D;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalAlpha = 1;
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, w, h);
  return c;
}
function returnCanvas(c: OffscreenCanvas | HTMLCanvasElement) {
  if (pool.length < 4) pool.push(c);
}

export function layerVisible(tl: Timeline, layer: Layer, includeHidden: boolean): boolean {
  if (includeHidden) return true;
  let l: Layer | undefined = layer;
  let guard = 0;
  while (l && guard++ < 64) {
    if (!l.visible) return false;
    const pid: string | null = l.parentId;
    if (!pid) break;
    l = tl.layers.find((x) => x.id === pid);
  }
  return true;
}

function isGuided(tl: Timeline, layer: Layer): boolean {
  if (layer.type === 'guide') return true;
  return false;
}

/** Renders a timeline frame. `m` maps timeline space to device pixels. */
export function renderTimeline(
  ctx: Ctx2D, tl: Timeline, frame: number, m: Matrix, ct: ColorTransform, env: RenderEnv, fctx: FrameContext, depth = 0,
) {
  if (depth > MAX_DEPTH) return;
  const layers = tl.layers;
  const tlLen = timelineFrameCount(tl);
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer.type === 'folder') continue;
    if (isGuided(tl, layer) && !env.showGuides) continue;
    if (layer.parentId) {
      const parent = layers.find((l) => l.id === layer.parentId);
      if (parent && parent.type === 'mask') continue; // drawn with its mask
    }
    if (!layerVisible(tl, layer, env.includeHidden)) continue;
    if (layer.type === 'mask') {
      const children = layers.filter((l) => l.parentId === layer.id && l.type !== 'folder');
      if (env.authoring && depth === 0 && (!layer.locked || children.some((c) => !c.locked))) {
        // editing: show mask content and masked content without masking
        for (let k = children.length - 1; k >= 0; k--) {
          if (layerVisible(tl, children[k], env.includeHidden)) renderLayer(ctx, tl, children[k], frame, m, ct, env, fctx, depth, tlLen);
        }
        renderLayer(ctx, tl, layer, frame, m, ct, env, fctx, depth, tlLen);
        continue;
      }
      renderMaskGroup(ctx, tl, layer, frame, m, ct, env, fctx, depth, tlLen);
      continue;
    }
    renderLayer(ctx, tl, layer, frame, m, ct, env, fctx, depth, tlLen);
  }
}

function renderLayer(
  ctx: Ctx2D, _tl: Timeline, layer: Layer, frame: number, m: Matrix, ct: ColorTransform, env: RenderEnv, fctx: FrameContext, depth: number, tlLen: number,
  forceFill?: string,
) {
  const r = resolveLayerFrame(layer, frame);
  if (!r) return;
  const sub = childContext(fctx, r.frame.start, r.frame.duration, tlLen, r.offset);
  const outline = env.outlines && layer.outline ? layer.color : null;
  for (const el of r.elements) renderElement(ctx, el, m, ct, env, sub, depth, outline, forceFill);
}

function renderMaskGroup(
  ctx: Ctx2D, tl: Timeline, mask: Layer, frame: number, m: Matrix, ct: ColorTransform, env: RenderEnv, fctx: FrameContext, depth: number, tlLen: number,
) {
  const children = tl.layers.filter((l) => l.parentId === mask.id && l.type !== 'folder');
  const w = ctx.canvas.width, h = ctx.canvas.height;
  if (w === 0 || h === 0) return;
  const off = borrowCanvas(w, h);
  const octx = off.getContext('2d') as Ctx2D;
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (!layerVisible(tl, c, env.includeHidden)) continue;
    renderLayer(octx, tl, c, frame, m, ct, env, fctx, depth, tlLen);
  }
  octx.globalCompositeOperation = 'destination-in';
  const mk = borrowCanvas(w, h);
  const mctx = mk.getContext('2d') as Ctx2D;
  renderLayer(mctx, tl, mask, frame, m, IDENTITY_CT, { ...env, outlines: false }, fctx, depth, tlLen, '#000000');
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.drawImage(mk as CanvasImageSource, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off as CanvasImageSource, 0, 0);
  ctx.restore();
  returnCanvas(mk);
  returnCanvas(off);
}

function gradientFor(ctx: Ctx2D, f: Exclude<Fill, { kind: 'solid' }>): CanvasGradient {
  const g = f.kind === 'linear'
    ? ctx.createLinearGradient(-819.2, 0, 819.2, 0)
    : ctx.createRadialGradient(0, 0, 0, 0, 0, 819.2);
  const stops = f.stops.length ? f.stops : [{ offset: 0, color: '#000000', alpha: 1 }];
  for (const s of stops) g.addColorStop(Math.min(1, Math.max(0, s.offset)), rgba(s.color, s.alpha));
  return g;
}

export function fillPath(ctx: Ctx2D, d: number[], fill: Fill, m: Matrix) {
  if (fill.kind === 'solid') {
    setCtx(ctx, m);
    ctx.fillStyle = rgba(fill.color, fill.alpha);
    ctx.fill(toPath2D(d), 'nonzero');
    return;
  }
  const gm = multiply(m, fill.matrix);
  const inv = invert(fill.matrix);
  const p = new Path2D();
  p.addPath(toPath2D(d), new DOMMatrix([inv.a, inv.b, inv.c, inv.d, inv.tx, inv.ty]));
  setCtx(ctx, gm);
  ctx.fillStyle = gradientFor(ctx, fill);
  ctx.fill(p, 'nonzero');
}

export function strokePath(ctx: Ctx2D, d: number[], s: Stroke, m: Matrix) {
  setCtx(ctx, m);
  ctx.strokeStyle = rgba(s.color, s.alpha);
  ctx.lineWidth = s.width <= 0.05 ? 1 / scaleFactor(m) : s.width;
  ctx.lineCap = s.caps === 'butt' ? 'butt' : s.caps === 'square' ? 'square' : 'round';
  ctx.lineJoin = s.joints;
  ctx.miterLimit = s.miter ?? 3;
  ctx.stroke(toPath2D(d));
}

const ctImageCache = new WeakMap<object, { key: string; canvas: HTMLCanvasElement | OffscreenCanvas }>();
function colorTransformedImage(img: CanvasImageSource & { width: number; height: number }, ct: ColorTransform) {
  const key = `${ct.rm},${ct.gm},${ct.bm},${ct.am},${ct.ro},${ct.go},${ct.bo},${ct.ao}`;
  const hit = ctImageCache.get(img);
  if (hit && hit.key === key) return hit.canvas;
  const w = img.width, h = img.height;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const x = c.getContext('2d') as Ctx2D;
  x.drawImage(img, 0, 0);
  const data = x.getImageData(0, 0, w, h);
  const p = data.data;
  for (let i = 0; i < p.length; i += 4) {
    p[i] = p[i] * ct.rm + ct.ro;
    p[i + 1] = p[i + 1] * ct.gm + ct.go;
    p[i + 2] = p[i + 2] * ct.bm + ct.bo;
    p[i + 3] = p[i + 3] * ct.am + ct.ao;
  }
  x.putImageData(data, 0, 0);
  ctImageCache.set(img, { key, canvas: c });
  return c;
}

export function renderElement(
  ctx: Ctx2D, el: Element, parent: Matrix, ct: ColorTransform, env: RenderEnv, fctx: FrameContext, depth: number,
  outline: string | null = null, forceFill?: string,
) {
  const m = multiply(parent, el.matrix);
  switch (el.type) {
    case 'shape': {
      for (const p of el.paths) {
        if (outline) {
          setCtx(ctx, m);
          ctx.strokeStyle = outline;
          ctx.lineWidth = 1 / scaleFactor(m);
          ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.stroke(toPath2D(p.d));
          continue;
        }
        if (forceFill) {
          if (p.fill) { setCtx(ctx, m); ctx.fillStyle = forceFill; ctx.fill(toPath2D(p.d)); }
          if (p.stroke) strokePath(ctx, p.d, { ...p.stroke, color: forceFill, alpha: 1 }, m);
          continue;
        }
        if (p.fill) fillPath(ctx, p.d, isIdentityCT(ct) ? p.fill : applyCTFill(p.fill, ct), m);
        if (p.stroke) strokePath(ctx, p.d, isIdentityCT(ct) ? p.stroke : applyCTStroke(p.stroke, ct), m);
      }
      break;
    }
    case 'group':
      for (const c of el.children) renderElement(ctx, c, m, ct, env, fctx, depth, outline, forceFill);
      break;
    case 'symbol': {
      const sym = getSymbol(env.lib, el.libraryItem);
      if (!sym) { drawMissing(ctx, m); break; }
      const f = instanceFrame(el, sym, fctx);
      const childCT = forceFill ? ct : concatCT(ct, effectToTransform(el.color));
      const elapsed = el.symbolType === 'movieclip' && fctx.playback ? (fctx.spanAll ? fctx.elapsed : fctx.offset) : fctx.elapsed;
      const sub: FrameContext = { offset: f, elapsed, spanAll: fctx.spanAll, playback: fctx.playback };
      const fx = !outline && !forceFill && el.symbolType !== 'graphic' &&
        ((el.filters && el.filters.length > 0) || (el.blendMode !== undefined && el.blendMode !== 'normal' && el.blendMode !== 'layer'));
      if (fx && renderWithEffects(ctx, el, sym.timeline, f, m, childCT, env, sub, depth + 1)) {
        // rendered through an offscreen buffer
      } else if (outline) {
        renderTimelineOutline(ctx, sym.timeline, f, m, env, sub, depth + 1, outline);
      } else {
        renderTimelineForced(ctx, sym.timeline, f, m, childCT, env, sub, depth + 1, forceFill);
      }
      break;
    }
    case 'bitmap': {
      const item = getBitmap(env.lib, el.libraryItem);
      const asset = item ? env.assets.get(item.assetId) : undefined;
      setCtx(ctx, m);
      if (!item || !asset || !asset.image) {
        if (item) {
          ctx.fillStyle = 'rgba(128,128,128,0.4)';
          ctx.fillRect(0, 0, item.width, item.height);
        } else drawMissing(ctx, m);
        break;
      }
      if (outline) {
        ctx.strokeStyle = outline; ctx.lineWidth = 1 / scaleFactor(m);
        ctx.strokeRect(0, 0, item.width, item.height);
        break;
      }
      if (forceFill) { ctx.fillStyle = forceFill; ctx.fillRect(0, 0, item.width, item.height); break; }
      ctx.imageSmoothingEnabled = item.smoothing;
      const img = asset.image as CanvasImageSource & { width: number; height: number };
      if (isIdentityCT(ct)) {
        ctx.drawImage(img, 0, 0, item.width, item.height);
      } else if (isAlphaOnlyCT(ct)) {
        const ga = ctx.globalAlpha;
        ctx.globalAlpha = ga * Math.max(0, Math.min(1, ct.am));
        ctx.drawImage(img, 0, 0, item.width, item.height);
        ctx.globalAlpha = ga;
      } else {
        ctx.drawImage(colorTransformedImage(img, ct) as CanvasImageSource, 0, 0, item.width, item.height);
      }
      ctx.imageSmoothingEnabled = true;
      break;
    }
    case 'text': {
      const lay = layoutText(el);
      setCtx(ctx, m);
      if (outline) {
        ctx.strokeStyle = outline; ctx.lineWidth = 1 / scaleFactor(m);
        ctx.strokeRect(0, 0, lay.width, lay.height);
        break;
      }
      const [c, a] = forceFill ? [forceFill, 1] : applyCTColor(el.color, el.alpha, ct);
      ctx.font = lay.font;
      try { (ctx as any).letterSpacing = `${el.letterSpacing || 0}px`; } catch { /* ignore */ }
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillStyle = rgba(c, a);
      for (const line of lay.lines) ctx.fillText(line.text, line.x, line.y + el.size * 0.1);
      try { (ctx as any).letterSpacing = '0px'; } catch { /* ignore */ }
      break;
    }
  }
}

const BLEND_OPS: Record<string, GlobalCompositeOperation> = {
  multiply: 'multiply', screen: 'screen', lighten: 'lighten', darken: 'darken', difference: 'difference',
  add: 'lighter', subtract: 'difference', invert: 'difference', overlay: 'overlay', hardlight: 'hard-light',
};

/** CSS filter string approximating Flash filters at a given device scale. */
export function filterCss(filters: FilterDef[], s: number): string {
  const parts: string[] = [];
  for (const f of filters) {
    const blur = Math.max(0, ((f.blurX + f.blurY) / 2) * s * 0.5);
    if (f.type === 'blur') { parts.push(`blur(${blur.toFixed(2)}px)`); continue; }
    const a = Math.max(0, Math.min(1, f.alpha * Math.min(1, f.strength)));
    const col = rgba(f.color, a);
    if (f.type === 'dropShadow') {
      const ang = (f.angle * Math.PI) / 180;
      parts.push(`drop-shadow(${(Math.cos(ang) * f.distance * s).toFixed(2)}px ${(Math.sin(ang) * f.distance * s).toFixed(2)}px ${blur.toFixed(2)}px ${col})`);
    } else {
      const n = f.strength > 1.5 ? 2 : 1;
      for (let i = 0; i < n; i++) parts.push(`drop-shadow(0px 0px ${blur.toFixed(2)}px ${col})`);
    }
  }
  return parts.join(' ') || 'none';
}

function filterPad(filters: FilterDef[] | undefined, s: number): number {
  let pad = 2;
  for (const f of filters ?? []) pad = Math.max(pad, (Math.max(f.blurX, f.blurY) + (f.type === 'dropShadow' ? f.distance : 0)) * s * 1.5 + 4);
  return pad;
}

/** Renders a movie clip with filters / blend mode through an offscreen buffer. */
function renderWithEffects(ctx: Ctx2D, el: SymbolInstance, tl: Timeline, frame: number, m: Matrix, ct: ColorTransform, env: RenderEnv, fctx: FrameContext, depth: number): boolean {
  const b = timelineBounds(tl, frame, m, env.lib, fctx);
  if (isEmptyRect(b)) return true;
  const s = scaleFactor(m);
  const pad = filterPad(el.filters, s);
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const x0 = Math.floor(Math.max(-pad, b.x - pad)), y0 = Math.floor(Math.max(-pad, b.y - pad));
  const x1 = Math.ceil(Math.min(cw + pad, b.x + b.w + pad)), y1 = Math.ceil(Math.min(ch + pad, b.y + b.h + pad));
  const W = x1 - x0, H = y1 - y0;
  if (W <= 0 || H <= 0) return true;
  if (W * H > 4096 * 4096) return false;
  const off = borrowCanvas(W, H);
  const octx = off.getContext('2d') as Ctx2D;
  renderTimeline(octx, tl, frame, multiply({ a: 1, b: 0, c: 0, d: 1, tx: -x0, ty: -y0 }, m), ct, env, fctx, depth);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (el.filters && el.filters.length) ctx.filter = filterCss(el.filters, s);
  const op = el.blendMode ? BLEND_OPS[el.blendMode] : undefined;
  if (op) ctx.globalCompositeOperation = op;
  ctx.drawImage(off as CanvasImageSource, x0, y0);
  ctx.restore();
  returnCanvas(off);
  return true;
}

function renderTimelineForced(ctx: Ctx2D, tl: Timeline, frame: number, m: Matrix, ct: ColorTransform, env: RenderEnv, fctx: FrameContext, depth: number, forceFill?: string) {
  if (!forceFill) { renderTimeline(ctx, tl, frame, m, ct, env, fctx, depth); return; }
  const tlLen = timelineFrameCount(tl);
  for (let i = tl.layers.length - 1; i >= 0; i--) {
    const layer = tl.layers[i];
    if (layer.type === 'folder' || layer.type === 'guide' || layer.type === 'mask') continue;
    renderLayer(ctx, tl, layer, frame, m, ct, { ...env, outlines: false }, fctx, depth, tlLen, forceFill);
  }
}

function renderTimelineOutline(ctx: Ctx2D, tl: Timeline, frame: number, m: Matrix, env: RenderEnv, fctx: FrameContext, depth: number, color: string) {
  if (depth > MAX_DEPTH) return;
  const tlLen = timelineFrameCount(tl);
  for (let i = tl.layers.length - 1; i >= 0; i--) {
    const layer = tl.layers[i];
    if (layer.type === 'folder' || (layer.type === 'guide' && !env.showGuides)) continue;
    const r = resolveLayerFrame(layer, frame);
    if (!r) continue;
    const sub = childContext(fctx, r.frame.start, r.frame.duration, tlLen, r.offset);
    for (const el of r.elements) renderElement(ctx, el, m, IDENTITY_CT, env, sub, depth, color);
  }
}

function drawMissing(ctx: Ctx2D, m: Matrix) {
  setCtx(ctx, m);
  ctx.strokeStyle = '#FF0000';
  ctx.lineWidth = 1 / scaleFactor(m);
  ctx.strokeRect(-10, -10, 20, 20);
  ctx.beginPath();
  ctx.moveTo(-10, -10); ctx.lineTo(10, 10); ctx.moveTo(10, -10); ctx.lineTo(-10, 10);
  ctx.stroke();
}

/** Renders a full scene frame into a context of size (w,h) scaled by `scale`. */
export function renderFrameImage(
  ctx: Ctx2D, tl: Timeline, frame: number, opts: {
    scale: number; offsetX?: number; offsetY?: number; background: string | null; env: RenderEnv; elapsed?: number;
  },
) {
  const w = ctx.canvas.width, h = ctx.canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, w, h);
  }
  const m: Matrix = { a: opts.scale, b: 0, c: 0, d: opts.scale, tx: -(opts.offsetX ?? 0) * opts.scale, ty: -(opts.offsetY ?? 0) * opts.scale };
  renderTimeline(ctx, tl, frame, m, IDENTITY_CT, opts.env, { offset: frame, elapsed: opts.elapsed ?? frame, spanAll: true, playback: opts.env.playback });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export { IDENTITY };
