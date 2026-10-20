import type { Element, Matrix, Rect, Timeline, ShapePath } from './types';
import { apply, emptyRect, invert, isEmptyRect, multiply, scaleFactor, transformRect, unionRect, inflateRect } from './matrix';
import { pathBounds, toPath2D } from './path';
import { resolveLayerFrame, timelineFrameCount } from './timeline';
import { childContext, getBitmap, getSymbol, instanceFrame, layoutText, type FrameContext, type LibIndex } from './symbols';

const AUTHOR_CTX: FrameContext = { offset: 0, elapsed: 0, spanAll: true, playback: false };

/** World-space bounds of an element (m = parent matrix). */
export function elementBounds(el: Element, m: Matrix, lib: LibIndex, fctx: FrameContext = AUTHOR_CTX, depth = 0): Rect {
  const mm = multiply(m, el.matrix);
  switch (el.type) {
    case 'shape': {
      let r = emptyRect();
      for (const p of el.paths) r = unionRect(r, pathRect(p, mm));
      return r;
    }
    case 'group': {
      let r = emptyRect();
      for (const c of el.children) r = unionRect(r, elementBounds(c, mm, lib, fctx, depth));
      return r;
    }
    case 'symbol': {
      const sym = getSymbol(lib, el.libraryItem);
      if (!sym || depth > 24) return transformRect(mm, { x: -10, y: -10, w: 20, h: 20 });
      const f = instanceFrame(el, sym, fctx);
      const r = timelineBounds(sym.timeline, f, mm, lib, { ...fctx, offset: f }, depth + 1);
      return isEmptyRect(r) ? transformRect(mm, { x: 0, y: 0, w: 0, h: 0 }) : r;
    }
    case 'bitmap': {
      const b = getBitmap(lib, el.libraryItem);
      return transformRect(mm, { x: 0, y: 0, w: b?.width ?? 20, h: b?.height ?? 20 });
    }
    case 'text': {
      const lay = layoutText(el);
      return transformRect(mm, { x: 0, y: 0, w: lay.width, h: lay.height });
    }
    case 'video':
      return transformRect(mm, { x: 0, y: 0, w: el.width, h: el.height });
  }
}

function pathRect(p: ShapePath, m: Matrix): Rect {
  const r = pathBounds(p.d, m);
  if (p.stroke && !isEmptyRect(r)) return inflateRect(r, (Math.max(p.stroke.width, 0.5) * scaleFactor(m)) / 2);
  return r;
}

export function timelineBounds(tl: Timeline, frame: number, m: Matrix, lib: LibIndex, fctx: FrameContext = AUTHOR_CTX, depth = 0, includeHidden = true): Rect {
  let r = emptyRect();
  const len = timelineFrameCount(tl);
  for (const layer of tl.layers) {
    if (layer.type === 'guide' || layer.type === 'folder') continue;
    if (!includeHidden && !layer.visible) continue;
    const rf = resolveLayerFrame(layer, frame);
    if (!rf) continue;
    const sub = childContext(fctx, rf.frame.start, rf.frame.duration, len, rf.offset);
    for (const el of rf.elements) r = unionRect(r, elementBounds(el, m, lib, sub, depth));
  }
  return r;
}

export function elementsBounds(els: Element[], m: Matrix, lib: LibIndex): Rect {
  let r = emptyRect();
  for (const e of els) r = unionRect(r, elementBounds(e, m, lib));
  return r;
}

// ---------------- hit testing ----------------
let hitCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
function hctx() {
  if (!hitCtx) {
    hitCtx = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(1, 1).getContext('2d')!
      : document.createElement('canvas').getContext('2d')!;
  }
  return hitCtx;
}

/** Tests a world-space point against an element. tol = tolerance in world px. */
export function hitElement(el: Element, m: Matrix, x: number, y: number, lib: LibIndex, tol = 3, fctx: FrameContext = AUTHOR_CTX, depth = 0): boolean {
  const mm = multiply(m, el.matrix);
  switch (el.type) {
    case 'shape': {
      const inv = invert(mm);
      const p = apply(inv, x, y);
      const s = scaleFactor(mm);
      const ctx = hctx();
      for (let i = el.paths.length - 1; i >= 0; i--) {
        const sp = el.paths[i];
        const p2 = toPath2D(sp.d);
        if (sp.fill && ctx.isPointInPath(p2, p.x, p.y, 'nonzero')) return true;
        const w = (sp.stroke ? Math.max(sp.stroke.width, 0.5) : 0) + (tol * 2) / s;
        if (sp.stroke || !sp.fill) {
          ctx.lineWidth = w;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          if (ctx.isPointInStroke(p2, p.x, p.y)) return true;
        }
      }
      return false;
    }
    case 'group':
      for (let i = el.children.length - 1; i >= 0; i--) if (hitElement(el.children[i], mm, x, y, lib, tol, fctx, depth)) return true;
      return false;
    case 'symbol': {
      const sym = getSymbol(lib, el.libraryItem);
      if (!sym || depth > 24) {
        const r = transformRect(mm, { x: -10, y: -10, w: 20, h: 20 });
        return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
      }
      const f = instanceFrame(el, sym, fctx);
      return hitTimeline(sym.timeline, f, mm, x, y, lib, tol, { ...fctx, offset: f }, depth + 1) !== null;
    }
    case 'bitmap': {
      const b = getBitmap(lib, el.libraryItem);
      const p = apply(invert(mm), x, y);
      return p.x >= 0 && p.y >= 0 && p.x <= (b?.width ?? 20) && p.y <= (b?.height ?? 20);
    }
    case 'text': {
      const lay = layoutText(el);
      const p = apply(invert(mm), x, y);
      return p.x >= 0 && p.y >= 0 && p.x <= lay.width && p.y <= lay.height;
    }
    case 'video': {
      const p = apply(invert(mm), x, y);
      return p.x >= 0 && p.y >= 0 && p.x <= el.width && p.y <= el.height;
    }
  }
}

export function hitTimeline(tl: Timeline, frame: number, m: Matrix, x: number, y: number, lib: LibIndex, tol: number, fctx: FrameContext, depth: number): Element | null {
  const len = timelineFrameCount(tl);
  for (const layer of tl.layers) {
    if (layer.type === 'guide' || layer.type === 'folder' || !layer.visible) continue;
    const rf = resolveLayerFrame(layer, frame);
    if (!rf) continue;
    const sub = childContext(fctx, rf.frame.start, rf.frame.duration, len, rf.offset);
    for (let i = rf.elements.length - 1; i >= 0; i--) {
      if (hitElement(rf.elements[i], m, x, y, lib, tol, sub, depth)) return rf.elements[i];
    }
  }
  return null;
}

/** Index of the shape path hit at a point (for bucket / ink / eyedropper). */
export function hitShapePath(el: Element, m: Matrix, x: number, y: number, tol = 3): { index: number; on: 'fill' | 'stroke' } | null {
  if (el.type !== 'shape') return null;
  const mm = multiply(m, el.matrix);
  const p = apply(invert(mm), x, y);
  const s = scaleFactor(mm);
  const ctx = hctx();
  for (let i = el.paths.length - 1; i >= 0; i--) {
    const sp = el.paths[i];
    const p2 = toPath2D(sp.d);
    if (sp.stroke) {
      ctx.lineWidth = Math.max(sp.stroke.width, 0.5) + (tol * 2) / s;
      if (ctx.isPointInStroke(p2, p.x, p.y)) return { index: i, on: 'stroke' };
    }
    if (sp.fill && ctx.isPointInPath(p2, p.x, p.y, 'nonzero')) return { index: i, on: 'fill' };
  }
  return null;
}

export function pointInPathLocal(d: number[], x: number, y: number): boolean {
  return hctx().isPointInPath(toPath2D(d), x, y, 'nonzero');
}
