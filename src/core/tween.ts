import type { ColorEffect, Element, Fill, Frame, Matrix, PathData, ShapeElement, ShapePath, Stroke, SymbolInstance } from './types';
import { apply, compose, decompose, invert, multiply } from './matrix';
import { lerp, lerpColor, effectToTransform, defaultColorEffect } from './util';
import {
  cubicLength, polygonArea, splitCubic, subpathsToPath, toCubicSubpaths, transformPath, reverseSubpath,
  type CubicSeg, type Subpath, OP_SIZE,
} from './path';

/** Animate's classic tween easing (-100 = ease in, 100 = ease out). */
export function easeT(t: number, ease: number): number {
  if (!ease) return t;
  const e = Math.max(-100, Math.min(100, ease)) / 100;
  if (e > 0) return t * (1 - e) + t * (2 - t) * e; // ease out
  const k = -e;
  return t * (1 - k) + t * t * k; // ease in
}

function normAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function interpolateMatrix(
  m0: Matrix, m1: Matrix, t: number,
  rotate: Frame['rotate'] = 'auto', times = 0,
  tp: { x: number; y: number } = { x: 0, y: 0 },
): Matrix {
  const d0 = decompose(m0), d1 = decompose(m1);
  let dSkewX = normAngle(d1.skewX - d0.skewX);
  let dSkewY = normAngle(d1.skewY - d0.skewY);
  if (rotate === 'none') {
    // no rotation: keep the shortest path anyway (Animate behaviour when "none" still blends to target)
  } else if (rotate === 'cw' || rotate === 'ccw') {
    const extra = Math.PI * 2 * Math.max(0, times);
    if (rotate === 'cw') {
      if (dSkewY < 0) { dSkewY += Math.PI * 2; dSkewX += Math.PI * 2; }
      dSkewY += extra; dSkewX += extra;
    } else {
      if (dSkewY > 0) { dSkewY -= Math.PI * 2; dSkewX -= Math.PI * 2; }
      dSkewY -= extra; dSkewX -= extra;
    }
  }
  const lin = compose({
    x: 0, y: 0,
    scaleX: lerp(d0.scaleX, d1.scaleX, t),
    scaleY: lerp(d0.scaleY, d1.scaleY, t),
    skewX: d0.skewX + dSkewX * t,
    skewY: d0.skewY + dSkewY * t,
  });
  // interpolate the transformation point position linearly in parent space
  const p0 = apply(m0, tp.x, tp.y), p1 = apply(m1, tp.x, tp.y);
  const px = lerp(p0.x, p1.x, t), py = lerp(p0.y, p1.y, t);
  const q = apply(lin, tp.x, tp.y);
  lin.tx = px - q.x;
  lin.ty = py - q.y;
  return lin;
}

function lerpEffect(a: ColorEffect, b: ColorEffect, t: number): ColorEffect {
  if (a.mode === 'none' && b.mode === 'none') return a;
  const ta = effectToTransform(a), tb = effectToTransform(b);
  const ct = {
    rm: lerp(ta.rm, tb.rm, t), gm: lerp(ta.gm, tb.gm, t), bm: lerp(ta.bm, tb.bm, t), am: lerp(ta.am, tb.am, t),
    ro: lerp(ta.ro, tb.ro, t), go: lerp(ta.go, tb.go, t), bo: lerp(ta.bo, tb.bo, t), ao: lerp(ta.ao, tb.ao, t),
  };
  return { ...defaultColorEffect(), mode: 'advanced', advanced: ct };
}

/** Classic tween: matches elements by index and interpolates their transforms/colors. */
export function classicTween(fa: Frame, fb: Frame, t: number): Element[] {
  const te = easeT(t, fa.ease);
  const out: Element[] = [];
  for (let i = 0; i < fa.elements.length; i++) {
    const a = fa.elements[i];
    const b = fb.elements[i];
    if (!b || a.type !== b.type) {
      out.push(a);
      continue;
    }
    const tp = a.type === 'symbol' ? a.transformPoint : { x: 0, y: 0 };
    const m = interpolateMatrix(a.matrix, b.matrix, te, fa.rotate, fa.rotateTimes, tp);
    if (a.type === 'symbol') {
      const bs = b as SymbolInstance;
      out.push({ ...a, matrix: m, color: lerpEffect(a.color, bs.color, te) });
    } else {
      out.push({ ...a, matrix: m } as Element);
    }
  }
  return out;
}

// ---------------- shape tweening ----------------

function lerpFill(a: Fill | null, b: Fill | null, t: number): Fill | null {
  if (!a && !b) return null;
  if (!a) a = b!.kind === 'solid' ? { ...b!, alpha: 0 } as Fill : b;
  if (!b) b = a!.kind === 'solid' ? { ...a!, alpha: 0 } as Fill : a;
  if (a!.kind === 'solid' && b!.kind === 'solid') {
    return { kind: 'solid', color: lerpColor(a!.color, b!.color, t), alpha: lerp(a!.alpha, b!.alpha, t) };
  }
  if (a!.kind !== 'solid' && b!.kind !== 'solid' && a!.kind === b!.kind && a!.stops.length === b!.stops.length) {
    return {
      kind: a!.kind,
      spread: a!.spread,
      matrix: {
        a: lerp(a!.matrix.a, b!.matrix.a, t), b: lerp(a!.matrix.b, b!.matrix.b, t),
        c: lerp(a!.matrix.c, b!.matrix.c, t), d: lerp(a!.matrix.d, b!.matrix.d, t),
        tx: lerp(a!.matrix.tx, b!.matrix.tx, t), ty: lerp(a!.matrix.ty, b!.matrix.ty, t),
      },
      stops: a!.stops.map((s, i) => ({
        offset: lerp(s.offset, b!.stops[i].offset, t),
        color: lerpColor(s.color, b!.stops[i].color, t),
        alpha: lerp(s.alpha, b!.stops[i].alpha, t),
      })),
    };
  }
  return t < 0.5 ? a : b;
}

function lerpStroke(a: Stroke | null, b: Stroke | null, t: number): Stroke | null {
  if (!a && !b) return null;
  if (!a) a = { ...b!, width: 0, alpha: 0 };
  if (!b) b = { ...a!, width: 0, alpha: 0 };
  return {
    ...a!,
    color: lerpColor(a!.color, b!.color, t),
    alpha: lerp(a!.alpha, b!.alpha, t),
    width: lerp(a!.width, b!.width, t),
  };
}

function sameStructure(a: PathData, b: PathData): boolean {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length) {
    if (a[i] !== b[i]) return false;
    const s = OP_SIZE[a[i]];
    if (s === undefined) return false;
    i += s;
  }
  return true;
}

function lerpArrays(a: PathData, b: PathData, t: number): PathData {
  const out = new Array(a.length);
  let i = 0;
  while (i < a.length) {
    const op = a[i];
    out[i] = op;
    const s = OP_SIZE[op];
    for (let k = 1; k < s; k++) out[i + k] = a[i + k] + (b[i + k] - a[i + k]) * t;
    i += s;
  }
  return out;
}

function subpathCentroid(sp: Subpath): { x: number; y: number } {
  let x = sp.sx, y = sp.sy, n = 1;
  for (const s of sp.segs) { x += s.x; y += s.y; n++; }
  return { x: x / n, y: y / n };
}

function degenerateLike(sp: Subpath, at: { x: number; y: number }): Subpath {
  return {
    sx: at.x, sy: at.y, closed: sp.closed,
    segs: sp.segs.map(() => ({ x0: at.x, y0: at.y, c1x: at.x, c1y: at.y, c2x: at.x, c2y: at.y, x: at.x, y: at.y })),
  };
}

function subdivideTo(sp: Subpath, count: number): Subpath {
  const segs = sp.segs.slice();
  if (segs.length === 0) {
    const p = { x0: sp.sx, y0: sp.sy, c1x: sp.sx, c1y: sp.sy, c2x: sp.sx, c2y: sp.sy, x: sp.sx, y: sp.sy };
    while (segs.length < count) segs.push({ ...p });
    return { ...sp, segs };
  }
  while (segs.length < count) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < segs.length; i++) {
      const l = cubicLength(segs[i]);
      if (l > bestLen) { bestLen = l; best = i; }
    }
    const [a, b] = splitCubic(segs[best], 0.5);
    segs.splice(best, 1, a, b);
  }
  return { ...sp, segs };
}

function rotateClosed(sp: Subpath, start: number): Subpath {
  if (!sp.closed || start === 0 || sp.segs.length === 0) return sp;
  const segs = sp.segs.slice(start).concat(sp.segs.slice(0, start));
  return { sx: segs[0].x0, sy: segs[0].y0, closed: true, segs };
}

function subpathArea(sp: Subpath): number {
  const pts = [{ x: sp.sx, y: sp.sy }, ...sp.segs.map((s) => ({ x: s.x, y: s.y }))];
  return polygonArea(pts);
}

function alignPair(a: Subpath, b: Subpath): [Subpath, Subpath] {
  if (a.closed && b.closed && Math.sign(subpathArea(a)) !== Math.sign(subpathArea(b)) && subpathArea(b) !== 0) {
    b = reverseSubpath(b);
  }
  const n = Math.max(a.segs.length, b.segs.length, 1);
  a = subdivideTo(a, n);
  b = subdivideTo(b, n);
  if (a.closed && b.closed) {
    // choose rotation of b minimizing total point distance
    let best = 0, bestD = Infinity;
    for (let r = 0; r < n; r++) {
      let dsum = 0;
      for (let i = 0; i < n; i++) {
        const sa = a.segs[i], sb = b.segs[(i + r) % n];
        dsum += Math.hypot(sa.x - sb.x, sa.y - sb.y);
      }
      if (dsum < bestD) { bestD = dsum; best = r; }
    }
    b = rotateClosed(b, best);
  }
  return [a, b];
}

interface Prepared { a: Subpath[]; b: Subpath[] }
const morphCache = new WeakMap<PathData, WeakMap<PathData, Prepared>>();

function prepareMorph(da: PathData, db: PathData): Prepared {
  let inner = morphCache.get(da);
  if (!inner) { inner = new WeakMap(); morphCache.set(da, inner); }
  const hit = inner.get(db);
  if (hit) return hit;
  const sa = toCubicSubpaths(da), sb = toCubicSubpaths(db);
  const n = Math.max(sa.length, sb.length);
  const outA: Subpath[] = [], outB: Subpath[] = [];
  for (let i = 0; i < n; i++) {
    let a = sa[i], b = sb[i];
    if (!a) a = degenerateLike(b, subpathCentroid(b));
    if (!b) b = degenerateLike(a, subpathCentroid(a));
    const [pa, pb] = alignPair(a, b);
    outA.push(pa); outB.push(pb);
  }
  const prep = { a: outA, b: outB };
  inner.set(db, prep);
  return prep;
}

export function morphPath(da: PathData, db: PathData, t: number): PathData {
  if (t <= 0) return da;
  if (t >= 1) return db;
  if (sameStructure(da, db)) return lerpArrays(da, db, t);
  const p = prepareMorph(da, db);
  const sps: Subpath[] = p.a.map((a, i) => {
    const b = p.b[i];
    const segs: CubicSeg[] = a.segs.map((s, k) => {
      const q = b.segs[k];
      return {
        x0: lerp(s.x0, q.x0, t), y0: lerp(s.y0, q.y0, t),
        c1x: lerp(s.c1x, q.c1x, t), c1y: lerp(s.c1y, q.c1y, t),
        c2x: lerp(s.c2x, q.c2x, t), c2y: lerp(s.c2y, q.c2y, t),
        x: lerp(s.x, q.x, t), y: lerp(s.y, q.y, t),
      };
    });
    return { sx: lerp(a.sx, b.sx, t), sy: lerp(a.sy, b.sy, t), closed: a.closed && b.closed, segs };
  });
  return subpathsToPath(sps);
}

// Transformed paths are cached per (path, matrix) so morph preparation can be
// cached by identity across frames of the same tween.
const xfCache = new WeakMap<PathData, { key: string; d: PathData }>();
function transformPathCached(d: PathData, m: Matrix): PathData {
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0) return d;
  const key = `${m.a},${m.b},${m.c},${m.d},${m.tx},${m.ty}`;
  const hit = xfCache.get(d);
  if (hit && hit.key === key) return hit.d;
  const out = transformPath(d, m);
  xfCache.set(d, { key, d: out });
  return out;
}

function flattenShapes(els: Element[]): ShapePath[] {
  const out: ShapePath[] = [];
  for (const e of els) {
    if (e.type !== 'shape') continue;
    for (const p of e.paths) out.push({ fill: p.fill, stroke: p.stroke, d: transformPathCached(p.d, e.matrix) });
  }
  return out;
}

export function shapeTween(fa: Frame, fb: Frame, t: number, id: string): Element[] {
  const te = easeT(t, fa.ease);
  const pa = flattenShapes(fa.elements), pb = flattenShapes(fb.elements);
  const others = fa.elements.filter((e) => e.type !== 'shape');
  if (pa.length === 0 || pb.length === 0) return fa.elements;
  const n = Math.max(pa.length, pb.length);
  const paths: ShapePath[] = [];
  for (let i = 0; i < n; i++) {
    const a = pa[i], b = pb[i];
    if (a && b) {
      paths.push({ fill: lerpFill(a.fill, b.fill, te), stroke: lerpStroke(a.stroke, b.stroke, te), d: morphPath(a.d, b.d, te) });
    } else if (a) {
      paths.push({ fill: lerpFill(a.fill, null, te), stroke: lerpStroke(a.stroke, null, te), d: a.d });
    } else if (b) {
      paths.push({ fill: lerpFill(null, b.fill, te), stroke: lerpStroke(null, b.stroke, te), d: b.d });
    }
  }
  const shape: ShapeElement = { type: 'shape', id, matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, paths };
  if (fa.elements.some((e) => e.type === 'shape' && e.planar)) shape.fromRaw = true;
  return [...others, shape];
}

/** Whether a classic tween between two keyframes is valid (Animate shows a dashed line otherwise). */
export function classicTweenValid(fa: Frame, fb: Frame | undefined): boolean {
  if (!fb) return false;
  if (fa.elements.length === 0 || fb.elements.length === 0) return false;
  return fa.elements.some((a, i) => {
    const b = fb.elements[i];
    return !!b && a.type === b.type;
  });
}

export function shapeTweenValid(fa: Frame, fb: Frame | undefined): boolean {
  if (!fb) return false;
  return fa.elements.some((e) => e.type === 'shape') && fb.elements.some((e) => e.type === 'shape');
}

export { invert, multiply };
