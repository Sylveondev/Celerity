// Planar-map shapes: the "merge drawing model" used by Animate/Flash.
//
// A merge shape is a set of non-crossing edges (lines and quadratic curves).
// Each edge records the fill on its left (f0) and right (f1) side and an
// optional stroke. Drawing on top of an existing shape inserts the new edges,
// splits everything at intersections and relabels both sides of every edge by
// sampling the combined result, so overlapping shapes fuse (same colour) or
// cut each other (different colour) exactly like Animate.
//
// Edge tuple: [x0, y0, cx, cy, x1, y1, isCurve, f0, f1, st]; style indices are
// 1-based (0 = none). Straight lines store their midpoint as control point so
// every edge can be treated as a quadratic Bézier.
import type { Fill, Matrix, PathData, ShapePath, Stroke, Point } from './types';
import { OP_L, OP_M, OP_Q, OP_Z } from './types';
import { visit, cubicToQuads } from './path';

export type PEdge = number[];
export interface Planar { fills: Fill[]; strokes: Stroke[]; edges: PEdge[] }

const X0 = 0, Y0 = 1, CX = 2, CY = 3, X1 = 4, Y1 = 5, QF = 6, F0 = 7, F1 = 8, ST = 9;
const EPS = 1e-3;        // vertex snapping / coincidence (px)
const SIDE = 0.015;      // side sampling distance (px)

export function emptyPlanar(): Planar { return { fills: [], strokes: [], edges: [] }; }

// ---------------------------------------------------------------------------
// Segment math (all segments are quadratic Béziers)
// ---------------------------------------------------------------------------
type Seg = number[]; // at least 7 entries: x0 y0 cx cy x1 y1 q

const ptAt = (s: Seg, t: number): Point => {
  const m = 1 - t;
  return { x: m * m * s[X0] + 2 * m * t * s[CX] + t * t * s[X1], y: m * m * s[Y0] + 2 * m * t * s[CY] + t * t * s[Y1] };
};
const dAt = (s: Seg, t: number): Point => ({
  x: 2 * (1 - t) * (s[CX] - s[X0]) + 2 * t * (s[X1] - s[CX]),
  y: 2 * (1 - t) * (s[CY] - s[Y0]) + 2 * t * (s[Y1] - s[CY]),
});

function lineSeg(x0: number, y0: number, x1: number, y1: number): Seg {
  return [x0, y0, (x0 + x1) / 2, (y0 + y1) / 2, x1, y1, 0];
}

function splitSeg(s: Seg, t: number): [Seg, Seg] {
  const ax = s[X0] + (s[CX] - s[X0]) * t, ay = s[Y0] + (s[CY] - s[Y0]) * t;
  const bx = s[CX] + (s[X1] - s[CX]) * t, by = s[CY] + (s[Y1] - s[CY]) * t;
  const mx = ax + (bx - ax) * t, my = ay + (by - ay) * t;
  return [[s[X0], s[Y0], ax, ay, mx, my, s[QF]], [mx, my, bx, by, s[X1], s[Y1], s[QF]]];
}

/** Sub-segment for parameter range [t0, t1]. */
function subSeg(s: Seg, t0: number, t1: number): Seg {
  if (t0 <= 0 && t1 >= 1) return s.slice(0, 7);
  let r = s;
  if (t0 > 0) r = splitSeg(r, t0)[1];
  if (t1 < 1) r = splitSeg(r, (t1 - t0) / (1 - t0))[0];
  return r.slice(0, 7);
}

function bbox(s: Seg): [number, number, number, number] {
  return [Math.min(s[X0], s[CX], s[X1]), Math.min(s[Y0], s[CY], s[Y1]), Math.max(s[X0], s[CX], s[X1]), Math.max(s[Y0], s[CY], s[Y1])];
}

function segLen(s: Seg): number {
  return (Math.hypot(s[CX] - s[X0], s[CY] - s[Y0]) + Math.hypot(s[X1] - s[CX], s[Y1] - s[CY]) + Math.hypot(s[X1] - s[X0], s[Y1] - s[Y0])) / 2;
}

function isFlat(s: Seg, tol: number): boolean {
  const dx = s[X1] - s[X0], dy = s[Y1] - s[Y0];
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return Math.hypot(s[CX] - s[X0], s[CY] - s[Y0]) < tol;
  return Math.abs(dy * s[CX] - dx * s[CY] + s[X1] * s[Y0] - s[Y1] * s[X0]) / l < tol;
}

/** Parameter of the point on the segment closest to (x, y). */
export function closestT(s: Seg, x: number, y: number): { t: number; d: number } {
  let best = 0, bd = Infinity;
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const p = ptAt(s, t);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  let t = best;
  for (let k = 0; k < 8; k++) {
    const p = ptAt(s, t), d1 = dAt(s, t);
    const d2x = 2 * (s[X1] - 2 * s[CX] + s[X0]), d2y = 2 * (s[Y1] - 2 * s[CY] + s[Y0]);
    const f = (p.x - x) * d1.x + (p.y - y) * d1.y;
    const fp = d1.x * d1.x + d1.y * d1.y + (p.x - x) * d2x + (p.y - y) * d2y;
    if (Math.abs(fp) < 1e-12) break;
    const nt = Math.max(0, Math.min(1, t - f / fp));
    if (Math.abs(nt - t) < 1e-10) { t = nt; break; }
    t = nt;
  }
  const p = ptAt(s, t);
  return { t, d: Math.hypot(p.x - x, p.y - y) };
}

function lineLine(ax0: number, ay0: number, ax1: number, ay1: number, bx0: number, by0: number, bx1: number, by1: number): [number, number] | null {
  const dax = ax1 - ax0, day = ay1 - ay0, dbx = bx1 - bx0, dby = by1 - by0;
  const den = dax * dby - day * dbx;
  if (Math.abs(den) < 1e-14) return null;
  const s = ((bx0 - ax0) * dby - (by0 - ay0) * dbx) / den;
  const t = ((bx0 - ax0) * day - (by0 - ay0) * dax) / den;
  return [s, t];
}

interface Hit { ta: number; tb: number; x: number; y: number }

/** Intersections between two segments (excluding coincident overlaps). */
function intersect(a: Seg, b: Seg): Hit[] {
  const out: Hit[] = [];
  const add = (ta: number, tb: number) => {
    if (ta < -1e-9 || ta > 1 + 1e-9 || tb < -1e-9 || tb > 1 + 1e-9) return;
    ta = Math.max(0, Math.min(1, ta)); tb = Math.max(0, Math.min(1, tb));
    const p = ptAt(a, ta), q = ptAt(b, tb);
    if (Math.hypot(p.x - q.x, p.y - q.y) > 0.05) return;
    for (const h of out) if (Math.abs(h.ta - ta) < 1e-6 && Math.abs(h.tb - tb) < 1e-6) return;
    out.push({ ta, tb, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  };
  const rec = (a0: number, a1: number, sa: Seg, b0: number, b1: number, sb: Seg, depth: number) => {
    if (out.length > 8) return;
    const ba = bbox(sa), bb = bbox(sb);
    if (ba[0] > bb[2] + 1e-9 || bb[0] > ba[2] + 1e-9 || ba[1] > bb[3] + 1e-9 || bb[1] > ba[3] + 1e-9) return;
    const flatA = isFlat(sa, 1e-4), flatB = isFlat(sb, 1e-4);
    if ((flatA && flatB) || depth > 40) {
      const r = lineLine(sa[X0], sa[Y0], sa[X1], sa[Y1], sb[X0], sb[Y0], sb[X1], sb[Y1]);
      if (r && r[0] >= -1e-6 && r[0] <= 1 + 1e-6 && r[1] >= -1e-6 && r[1] <= 1 + 1e-6) {
        add(a0 + (a1 - a0) * r[0], b0 + (b1 - b0) * r[1]);
      }
      return;
    }
    if (!flatA && (flatB || segLen(sa) >= segLen(sb))) {
      const [p, q] = splitSeg(sa, 0.5), am = (a0 + a1) / 2;
      rec(a0, am, p, b0, b1, sb, depth + 1);
      rec(am, a1, q, b0, b1, sb, depth + 1);
    } else {
      const [p, q] = splitSeg(sb, 0.5), bm = (b0 + b1) / 2;
      rec(a0, a1, sa, b0, bm, p, depth + 1);
      rec(a0, a1, sa, bm, b1, q, depth + 1);
    }
  };
  rec(0, 1, a, 0, 1, b, 0);
  return out;
}

/** Detects coincident (overlapping) segments; returns split params on each. */
function overlap(a: Seg, b: Seg): { ta: number[]; tb: number[] } | null {
  const ta: number[] = [], tb: number[] = [];
  let hits = 0;
  for (const [x, y] of [[b[X0], b[Y0]], [b[X1], b[Y1]]]) {
    const c = closestT(a, x, y);
    if (c.d < EPS * 5) { ta.push(c.t); hits++; }
  }
  for (const [x, y] of [[a[X0], a[Y0]], [a[X1], a[Y1]]]) {
    const c = closestT(b, x, y);
    if (c.d < EPS * 5) { tb.push(c.t); hits++; }
  }
  if (hits < 2) return null;
  // the overlapping portion's midpoint must lie on both curves
  const params = ta.length >= 2 ? ta : [...ta, ...(tb.length ? [closestT(a, ptAt(b, tb[0]).x, ptAt(b, tb[0]).y).t] : [])];
  if (params.length < 2) return null;
  const lo = Math.min(...params), hi = Math.max(...params);
  if (hi - lo < 1e-6) return null;
  for (const f of [0.25, 0.5, 0.75]) {
    const p = ptAt(a, lo + (hi - lo) * f);
    if (closestT(b, p.x, p.y).d > EPS * 5) return null;
  }
  return { ta, tb };
}

// ---------------------------------------------------------------------------
// Point-in-region (exact winding against lines/quads)
// ---------------------------------------------------------------------------
export class Region {
  private pieces: number[][] = []; // monotone-in-y quads
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  constructor(segs: Seg[]) {
    for (const s of segs) {
      const b = bbox(s);
      this.minX = Math.min(this.minX, b[0]); this.minY = Math.min(this.minY, b[1]);
      this.maxX = Math.max(this.maxX, b[2]); this.maxY = Math.max(this.maxY, b[3]);
      const den = s[Y0] - 2 * s[CY] + s[Y1];
      const te = Math.abs(den) > 1e-12 ? (s[Y0] - s[CY]) / den : -1;
      if (te > 1e-9 && te < 1 - 1e-9) { const [p, q] = splitSeg(s, te); this.pieces.push(p, q); }
      else this.pieces.push(s.slice(0, 7));
    }
  }
  get empty() { return this.pieces.length === 0; }
  private buckets: number[][][] | null = null;
  private bucketH = 1;
  /** Pieces grouped by horizontal bands so point queries only test nearby curves. */
  private index() {
    const n = Math.max(1, Math.min(512, Math.ceil(this.pieces.length / 4)));
    this.bucketH = (this.maxY - this.minY) / n || 1;
    const b: number[][][] = Array.from({ length: n }, () => []);
    for (const s of this.pieces) {
      const y0 = Math.min(s[Y0], s[Y1]), y1 = Math.max(s[Y0], s[Y1]);
      const i0 = Math.max(0, Math.floor((y0 - this.minY) / this.bucketH)), i1 = Math.min(n - 1, Math.floor((y1 - this.minY) / this.bucketH));
      for (let i = i0; i <= i1; i++) b[i].push(s);
    }
    this.buckets = b;
  }
  winding(px: number, py: number): number {
    if (px > this.maxX || py < this.minY || py > this.maxY) return 0;
    if (!this.buckets) {
      if (this.pieces.length > 24) this.index();
    }
    const list = this.buckets ? this.buckets[Math.min(this.buckets.length - 1, Math.max(0, Math.floor((py - this.minY) / this.bucketH)))] : this.pieces;
    let w = 0;
    for (const s of list) {
      const ya = s[Y0], yb = s[Y1];
      if (ya === yb) continue;
      const up = yb > ya;
      if (up ? !(ya <= py && py < yb) : !(yb <= py && py < ya)) continue;
      if (Math.max(s[X0], s[CX], s[X1]) < px) continue;
      const a = s[Y0] - 2 * s[CY] + s[Y1], b = 2 * (s[CY] - s[Y0]), c = s[Y0] - py;
      let t: number;
      if (Math.abs(a) < 1e-12) t = -c / b;
      else {
        const disc = Math.max(0, b * b - 4 * a * c);
        const sq = Math.sqrt(disc);
        const t1 = (-b + sq) / (2 * a), t2 = (-b - sq) / (2 * a);
        t = t1 >= -1e-9 && t1 <= 1 + 1e-9 ? t1 : t2;
      }
      t = Math.max(0, Math.min(1, t));
      const m = 1 - t;
      const x = m * m * s[X0] + 2 * m * t * s[CX] + t * t * s[X1];
      if (x > px) w += up ? 1 : -1;
    }
    return w;
  }
  contains(px: number, py: number) { return this.winding(px, py) !== 0; }
}

/** Converts path data into closed (for fills) or open subpaths of quad segments. */
export function pathToSegs(d: PathData, closeAll: boolean): Seg[][] {
  const out: Seg[][] = [];
  let cur: Seg[] = [];
  let sx = 0, sy = 0, cx = 0, cy = 0;
  const close = () => {
    if (Math.hypot(cx - sx, cy - sy) > 1e-9) cur.push(lineSeg(cx, cy, sx, sy));
    cx = sx; cy = sy;
  };
  const flush = (closing: boolean) => {
    if (closing) close();
    if (cur.length) out.push(cur);
    cur = [];
  };
  visit(d, {
    M: (x, y) => { flush(closeAll); sx = cx = x; sy = cy = y; },
    L: (x, y) => { if (Math.hypot(x - cx, y - cy) > 1e-9) cur.push(lineSeg(cx, cy, x, y)); cx = x; cy = y; },
    Q: (qx, qy, x, y) => { cur.push([cx, cy, qx, qy, x, y, 1]); cx = x; cy = y; },
    C: (ax, ay, bx, by, x, y) => {
      for (const q of cubicToQuads({ x0: cx, y0: cy, c1x: ax, c1y: ay, c2x: bx, c2y: by, x, y }, 0.05)) {
        cur.push([cx, cy, q[0], q[1], q[2], q[3], 1]);
        cx = q[2]; cy = q[3];
      }
      cx = x; cy = y;
    },
    Z: () => { flush(true); },
  });
  flush(closeAll);
  return out;
}

export function pathRegion(d: PathData): Region {
  return new Region(pathToSegs(d, true).flat());
}

/** Fill regions of a planar shape, one per style (fill on the right of every edge). */
function fillRegions(p: Planar): Region[] {
  const per: Seg[][] = p.fills.map(() => []);
  for (const e of p.edges) {
    if (e[F1] > 0) per[e[F1] - 1]?.push(e);
    if (e[F0] > 0) per[e[F0] - 1]?.push(reverse(e));
  }
  return per.map((s) => new Region(s));
}

function reverse(e: Seg): Seg {
  return [e[X1], e[Y1], e[CX], e[CY], e[X0], e[Y0], e[QF]];
}

function planarFillAt(p: Planar, regions: Region[], x: number, y: number): Fill | null {
  for (let i = regions.length - 1; i >= 0; i--) if (regions[i].contains(x, y)) return p.fills[i];
  return null;
}

// ---------------------------------------------------------------------------
// Arrangement: split at intersections, snap vertices, merge duplicates
// ---------------------------------------------------------------------------
interface AEdge {
  s: Seg;
  baseStroke: Stroke | null;
  topStroke: Stroke | null;
  fromBase: boolean;
  fromTop: boolean;
}

const vkey = (x: number, y: number) => `${Math.round(x / EPS)},${Math.round(y / EPS)}`;

function arrange(input: AEdge[]): AEdge[] {
  const n = input.length;
  const splits: { t: number; x: number; y: number }[][] = input.map(() => []);
  const boxes = input.map((e) => bbox(e.s));
  // sweep over x to limit pair tests
  const order = input.map((_, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const bi = boxes[i];
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      const bj = boxes[j];
      if (bj[0] > bi[2] + EPS) break;
      if (bj[1] > bi[3] + EPS || bi[1] > bj[3] + EPS) continue;
      const a = input[i].s, b = input[j].s;
      const ov = overlap(a, b);
      if (ov) {
        for (const t of ov.ta) { const p = ptAt(a, t); splits[i].push({ t, x: p.x, y: p.y }); }
        for (const t of ov.tb) { const p = ptAt(b, t); splits[j].push({ t, x: p.x, y: p.y }); }
        continue;
      }
      for (const h of intersect(a, b)) {
        splits[i].push({ t: h.ta, x: h.x, y: h.y });
        splits[j].push({ t: h.tb, x: h.x, y: h.y });
      }
    }
  }
  const pieces: AEdge[] = [];
  for (let i = 0; i < n; i++) {
    const e = input[i];
    const sp = splits[i].filter((s) => s.t > 1e-7 && s.t < 1 - 1e-7).sort((a, b) => a.t - b.t);
    const uniq: typeof sp = [];
    for (const s of sp) if (!uniq.length || s.t - uniq[uniq.length - 1].t > 1e-7) uniq.push(s);
    let prevT = 0;
    let prevPt = { x: e.s[X0], y: e.s[Y0] };
    const all = [...uniq, { t: 1, x: e.s[X1], y: e.s[Y1] }];
    for (const s of all) {
      const seg = subSeg(e.s, prevT, s.t);
      seg[X0] = prevPt.x; seg[Y0] = prevPt.y; seg[X1] = s.x; seg[Y1] = s.y;
      if (seg[QF] === 0) { seg[CX] = (seg[X0] + seg[X1]) / 2; seg[CY] = (seg[Y0] + seg[Y1]) / 2; }
      pieces.push({ ...e, s: seg });
      prevT = s.t;
      prevPt = { x: s.x, y: s.y };
    }
  }
  // snap vertices
  const canon = new Map<string, Point>();
  const snap = (x: number, y: number): Point => {
    const k = vkey(x, y);
    let p = canon.get(k);
    if (!p) {
      // look in neighbouring cells too (values straddling a cell boundary)
      const kx = Math.round(x / EPS), ky = Math.round(y / EPS);
      for (let dx = -1; dx <= 1 && !p; dx++) for (let dy = -1; dy <= 1 && !p; dy++) p = canon.get(`${kx + dx},${ky + dy}`);
      if (!p) { p = { x, y }; canon.set(k, p); } else canon.set(k, p);
    }
    return p;
  };
  const out = new Map<string, AEdge>();
  for (const e of pieces) {
    const a = snap(e.s[X0], e.s[Y0]), b = snap(e.s[X1], e.s[Y1]);
    e.s[X0] = a.x; e.s[Y0] = a.y; e.s[X1] = b.x; e.s[Y1] = b.y;
    if (e.s[QF] === 0) { e.s[CX] = (a.x + b.x) / 2; e.s[CY] = (a.y + b.y) / 2; }
    if (a === b && segLen(e.s) < EPS * 4) continue;
    const ka = vkey(a.x, a.y), kb = vkey(b.x, b.y);
    const ck = `${Math.round(e.s[CX] / 0.01)},${Math.round(e.s[CY] / 0.01)}`;
    const key = ka < kb ? `${ka}|${kb}|${ck}` : `${kb}|${ka}|${ck}`;
    const ex = out.get(key);
    if (ex) {
      ex.fromBase ||= e.fromBase;
      ex.fromTop ||= e.fromTop;
      ex.baseStroke ||= e.baseStroke;
      ex.topStroke ||= e.topStroke;
    } else out.set(key, e);
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Generic combine
// ---------------------------------------------------------------------------
interface CombineSpec {
  topEdges: { s: Seg; stroke: Stroke | null }[];
  /** Resulting fill at a point, given base and top fills there. */
  fill(x: number, y: number, base: Fill | null): Fill | null;
  /** Resulting stroke for an edge. */
  stroke(e: AEdge, mid: Point, left: Point, right: Point): Stroke | null;
  /** Limits relabelling to base edges near this box (others keep their labels). */
  affects: [number, number, number, number] | null;
}

const fkey = (f: Fill | null) => (f ? JSON.stringify(f) : '');
const skey = (s: Stroke | null) => (s ? JSON.stringify(s) : '');

function combine(base: Planar | null, spec: CombineSpec): Planar {
  const b = base ?? emptyPlanar();
  const regions = fillRegions(b);
  const baseFill = (x: number, y: number) => planarFillAt(b, regions, x, y);
  const near: AEdge[] = [];
  const far: PEdge[] = [];
  const box = spec.affects;
  for (const e of b.edges) {
    const bb = bbox(e);
    if (box && (bb[0] > box[2] + 1 || bb[2] < box[0] - 1 || bb[1] > box[3] + 1 || bb[3] < box[1] - 1)) { far.push(e); continue; }
    near.push({ s: e.slice(0, 7), baseStroke: e[ST] > 0 ? b.strokes[e[ST] - 1] ?? null : null, topStroke: null, fromBase: true, fromTop: false });
  }
  for (const t of spec.topEdges) near.push({ s: t.s.slice(0, 7), baseStroke: null, topStroke: t.stroke, fromBase: false, fromTop: true });
  const arranged = arrange(near);

  const fills: Fill[] = [], strokes: Stroke[] = [];
  const fIdx = new Map<string, number>(), sIdx = new Map<string, number>();
  const fillIndex = (f: Fill | null) => {
    if (!f) return 0;
    const k = fkey(f);
    let i = fIdx.get(k);
    if (i === undefined) { fills.push(f); i = fills.length; fIdx.set(k, i); }
    return i;
  };
  const strokeIndex = (s: Stroke | null) => {
    if (!s) return 0;
    const k = skey(s);
    let i = sIdx.get(k);
    if (i === undefined) { strokes.push(s); i = strokes.length; sIdx.set(k, i); }
    return i;
  };
  const edges: PEdge[] = [];
  for (const e of far) {
    const f0 = fillIndex(e[F0] > 0 ? b.fills[e[F0] - 1] : null);
    const f1 = fillIndex(e[F1] > 0 ? b.fills[e[F1] - 1] : null);
    const st = strokeIndex(e[ST] > 0 ? b.strokes[e[ST] - 1] : null);
    if (f0 === f1 && !st) continue;
    edges.push([...e.slice(0, 7), f0, f1, st]);
  }
  for (const e of arranged) {
    const m = ptAt(e.s, 0.5);
    const d = dAt(e.s, 0.5);
    let l = Math.hypot(d.x, d.y);
    let dx = d.x, dy = d.y;
    if (l < 1e-12) { dx = e.s[X1] - e.s[X0]; dy = e.s[Y1] - e.s[Y0]; l = Math.hypot(dx, dy) || 1; }
    const nx = -dy / l, ny = dx / l; // right-hand normal (y-down)
    const side = Math.min(SIDE, segLen(e.s) * 0.1 + 1e-4);
    const right = { x: m.x + nx * side, y: m.y + ny * side };
    const left = { x: m.x - nx * side, y: m.y - ny * side };
    const f1 = fillIndex(spec.fill(right.x, right.y, baseFill(right.x, right.y)));
    const f0 = fillIndex(spec.fill(left.x, left.y, baseFill(left.x, left.y)));
    const st = strokeIndex(spec.stroke(e, m, left, right));
    if (f0 === f1 && !st) continue;
    edges.push([...e.s.slice(0, 7), f0, f1, st]);
  }
  return simplify({ fills, strokes, edges });
}

/** Joins collinear consecutive straight edges with identical labels. */
function simplify(p: Planar): Planar {
  // vertex degree map
  const deg = new Map<string, number[]>();
  p.edges.forEach((e, i) => {
    for (const k of [vkey(e[X0], e[Y0]), vkey(e[X1], e[Y1])]) {
      const a = deg.get(k);
      if (a) a.push(i); else deg.set(k, [i]);
    }
  });
  const dead = new Set<number>();
  const edges = p.edges.map((e) => e.slice());
  for (const [, list] of deg) {
    if (list.length !== 2) continue;
    const [i, j] = list;
    if (i === j || dead.has(i) || dead.has(j)) continue;
    const a = edges[i], b = edges[j];
    if (a[QF] || b[QF]) continue;
    // orient so that a ends where b starts
    let A = a, B = b;
    const ka1 = vkey(A[X1], A[Y1]), kb0 = vkey(B[X0], B[Y0]);
    if (ka1 !== kb0) {
      const rb = [B[X1], B[Y1], B[CX], B[CY], B[X0], B[Y0], 0, B[F1], B[F0], B[ST]];
      if (vkey(A[X1], A[Y1]) === vkey(rb[X0], rb[Y0])) B = rb;
      else {
        const ra = [A[X1], A[Y1], A[CX], A[CY], A[X0], A[Y0], 0, A[F1], A[F0], A[ST]];
        if (vkey(ra[X1], ra[Y1]) === vkey(B[X0], B[Y0])) A = ra;
        else if (vkey(ra[X1], ra[Y1]) === vkey(rb[X0], rb[Y0])) { A = ra; B = rb; } else continue;
      }
    }
    if (A[F0] !== B[F0] || A[F1] !== B[F1] || A[ST] !== B[ST]) continue;
    const cross = (A[X1] - A[X0]) * (B[Y1] - B[Y0]) - (A[Y1] - A[Y0]) * (B[X1] - B[X0]);
    const dot = (A[X1] - A[X0]) * (B[X1] - B[X0]) + (A[Y1] - A[Y0]) * (B[Y1] - B[Y0]);
    if (Math.abs(cross) > 1e-6 * (segLen(A) * segLen(B) + 1e-9) || dot <= 0) continue;
    const merged = [A[X0], A[Y0], (A[X0] + B[X1]) / 2, (A[Y0] + B[Y1]) / 2, B[X1], B[Y1], 0, A[F0], A[F1], A[ST]];
    edges[i] = merged;
    dead.add(j);
    // keep the degree map consistent for the far endpoint of b
    const kfar = vkey(B[X1], B[Y1]);
    const lst = deg.get(kfar);
    if (lst) { const idx = lst.indexOf(j); if (idx >= 0) lst[idx] = i; }
  }
  return compactStyles({ fills: p.fills, strokes: p.strokes, edges: edges.filter((_, i) => !dead.has(i)) });
}

function compactStyles(p: Planar): Planar {
  const fUsed = new Map<number, number>(), sUsed = new Map<number, number>();
  const fills: Fill[] = [], strokes: Stroke[] = [];
  const mf = (i: number) => {
    if (!i) return 0;
    let n = fUsed.get(i);
    if (n === undefined) { fills.push(p.fills[i - 1]); n = fills.length; fUsed.set(i, n); }
    return n;
  };
  const ms = (i: number) => {
    if (!i) return 0;
    let n = sUsed.get(i);
    if (n === undefined) { strokes.push(p.strokes[i - 1]); n = strokes.length; sUsed.set(i, n); }
    return n;
  };
  const edges = p.edges.filter((e) => !(e[F0] === e[F1] && !e[ST])).map((e) => [...e.slice(0, 7), mf(e[F0]), mf(e[F1]), ms(e[ST])]);
  return { fills, strokes, edges };
}

function segsBox(segs: Seg[]): [number, number, number, number] | null {
  if (!segs.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) { const b = bbox(s); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

/** Draws `top` paths onto `base` ("over": top wins; "under": base wins, e.g. paint behind). */
export function mergePaths(base: Planar | null, paths: ShapePath[], mode: 'over' | 'under' = 'over'): Planar {
  let p = base;
  for (const path of paths) {
    const fillSegs = path.fill ? pathToSegs(path.d, true) : [];
    const strokeSegs = path.stroke ? pathToSegs(path.d, false) : [];
    const region = path.fill ? new Region(fillSegs.flat()) : null;
    const fill = path.fill;
    const topEdges = [
      ...fillSegs.flat().map((s) => ({ s, stroke: null as Stroke | null })),
      ...strokeSegs.flat().map((s) => ({ s, stroke: path.stroke })),
    ];
    const box = segsBox(topEdges.map((t) => t.s));
    if (!box) continue;
    p = combine(p, {
      topEdges,
      affects: box,
      fill: (x, y, bf) => {
        const tf = region && region.contains(x, y) ? fill : null;
        return mode === 'over' ? tf ?? bf : bf ?? tf;
      },
      stroke: (e, _m, l, r) => {
        if (e.topStroke && (mode === 'over' || !e.baseStroke)) return e.topStroke;
        if (e.baseStroke) {
          // a filled shape drawn on top removes the strokes it covers
          if (mode === 'over' && region && region.contains(l.x, l.y) && region.contains(r.x, r.y)) return null;
          return e.baseStroke;
        }
        return null;
      },
    });
  }
  return p ?? emptyPlanar();
}

/** Merges another planar shape on top (or under) `base`. */
export function mergePlanar(base: Planar | null, top: Planar, mode: 'over' | 'under' = 'over'): Planar {
  if (!base || !base.edges.length) return top.edges.length ? simplify(top) : emptyPlanar();
  const tRegions = fillRegions(top);
  const topEdges = top.edges.map((e) => ({ s: e.slice(0, 7), stroke: e[ST] > 0 ? top.strokes[e[ST] - 1] : null }));
  const box = segsBox(topEdges.map((t) => t.s));
  if (!box) return base;
  return combine(base, {
    topEdges,
    affects: box,
    fill: (x, y, bf) => {
      const tf = planarFillAt(top, tRegions, x, y);
      return mode === 'over' ? tf ?? bf : bf ?? tf;
    },
    stroke: (e, _m, l, r) => {
      if (e.topStroke && (mode === 'over' || !e.baseStroke)) return e.topStroke;
      if (e.baseStroke) {
        if (mode === 'over' && planarFillAt(top, tRegions, l.x, l.y) && planarFillAt(top, tRegions, r.x, r.y)) return null;
        return e.baseStroke;
      }
      return null;
    },
  });
}

export interface RegionOp { fills: boolean; strokes: boolean }

/** Removes everything inside `region` (eraser, cut). */
export function erasePlanar(base: Planar, region: PathData, op: RegionOp = { fills: true, strokes: true }): Planar {
  const segs = pathToSegs(region, true).flat();
  const R = new Region(segs);
  return combine(base, {
    topEdges: segs.map((s) => ({ s, stroke: null })),
    affects: segsBox(segs),
    fill: (x, y, bf) => (op.fills && R.contains(x, y) ? null : bf),
    stroke: (e, m) => (e.baseStroke && !(op.strokes && R.contains(m.x, m.y)) ? e.baseStroke : null),
  });
}

/** Keeps only what is inside `region` (copy / lift of a selection). */
export function extractPlanar(base: Planar, region: PathData, includeStrokes: boolean): Planar {
  const segs = pathToSegs(region, true).flat();
  const R = new Region(segs);
  return combine(base, {
    topEdges: segs.map((s) => ({ s, stroke: null })),
    affects: null,
    fill: (x, y, bf) => (R.contains(x, y) ? bf : null),
    stroke: (e, m) => (includeStrokes && e.baseStroke && R.contains(m.x, m.y) ? e.baseStroke : null),
  });
}

/** Replaces the fill inside `region` (paint bucket / colour change). */
export function recolorPlanar(base: Planar, region: PathData, fill: Fill | null, onlyFilled: boolean): Planar {
  const segs = pathToSegs(region, true).flat();
  const R = new Region(segs);
  const regions = fillRegions(base);
  const res = combine(base, {
    topEdges: segs.map((s) => ({ s, stroke: null })),
    affects: segsBox(segs),
    fill: (x, y, bf) => (R.contains(x, y) && (!onlyFilled || bf) ? fill : bf),
    stroke: (e) => e.baseStroke,
  });
  void regions;
  return res;
}

export function transformPlanar(p: Planar, m: Matrix): Planar {
  const sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
  const tp = (x: number, y: number) => [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty];
  const flip = m.a * m.d - m.b * m.c < 0;
  return {
    fills: p.fills.map((f) => (f.kind === 'solid' ? f : { ...f, matrix: mul(m, f.matrix) })),
    strokes: p.strokes.map((s) => ({ ...s, width: s.width * sc })),
    edges: p.edges.map((e) => {
      const [a, b] = tp(e[X0], e[Y0]), [c, d] = tp(e[CX], e[CY]), [x, y] = tp(e[X1], e[Y1]);
      // a mirroring transform swaps the left/right sides
      return [a, b, c, d, x, y, e[QF], flip ? e[F1] : e[F0], flip ? e[F0] : e[F1], e[ST]];
    }),
  };
}

function mul(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b, b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d, d: m1.b * m2.c + m1.d * m2.d,
    tx: m1.a * m2.tx + m1.c * m2.ty + m1.tx, ty: m1.b * m2.tx + m1.d * m2.ty + m1.ty,
  };
}

// ---------------------------------------------------------------------------
// Faces & stroke chains (for selection, bucket, ink bottle)
// ---------------------------------------------------------------------------
interface Half { e: number; fwd: boolean; from: string; to: string; ang: number; next?: number }

function halfAngle(s: Seg, fwd: boolean): number {
  const t = fwd ? 0.05 : 0.95;
  const o = fwd ? { x: s[X0], y: s[Y0] } : { x: s[X1], y: s[Y1] };
  let p = ptAt(s, t);
  if (Math.hypot(p.x - o.x, p.y - o.y) < 1e-9) p = fwd ? { x: s[X1], y: s[Y1] } : { x: s[X0], y: s[Y0] };
  return Math.atan2(p.y - o.y, p.x - o.x);
}

interface Cycle { halves: number[]; area: number; region: Region; segs: Seg[] }

function cycles(p: Planar): { halves: Half[]; cycles: Cycle[] } {
  const halves: Half[] = [];
  p.edges.forEach((e, i) => {
    const a = vkey(e[X0], e[Y0]), b = vkey(e[X1], e[Y1]);
    halves.push({ e: i, fwd: true, from: a, to: b, ang: halfAngle(e, true) });
    halves.push({ e: i, fwd: false, from: b, to: a, ang: halfAngle(e, false) });
  });
  const out = new Map<string, number[]>();
  halves.forEach((h, i) => { const l = out.get(h.from); if (l) l.push(i); else out.set(h.from, [i]); });
  for (const l of out.values()) l.sort((a, b) => halves[a].ang - halves[b].ang);
  halves.forEach((h, i) => {
    const twin = i ^ 1;
    const list = out.get(h.to)!;
    const k = list.indexOf(twin);
    h.next = list[(k - 1 + list.length) % list.length];
  });
  const seen = new Uint8Array(halves.length);
  const cyc: Cycle[] = [];
  for (let i = 0; i < halves.length; i++) {
    if (seen[i]) continue;
    const hs: number[] = [];
    let j = i, guard = 0;
    while (!seen[j] && guard++ < halves.length + 1) { seen[j] = 1; hs.push(j); j = halves[j].next!; }
    const segs = hs.map((k) => { const e = p.edges[halves[k].e]; return halves[k].fwd ? e.slice(0, 7) : reverse(e); });
    // signed area (y-down: positive = clockwise = bounded face on the right)
    let area = 0;
    for (const s of segs) {
      for (let q = 0; q < 8; q++) {
        const a = ptAt(s, q / 8), b = ptAt(s, (q + 1) / 8);
        area += a.x * b.y - b.x * a.y;
      }
    }
    cyc.push({ halves: hs, area: area / 2, region: new Region(segs), segs });
  }
  return { halves, cycles: cyc };
}

function segsToPath(loops: Seg[][]): PathData {
  const d: number[] = [];
  for (const loop of loops) {
    if (!loop.length) continue;
    d.push(OP_M, loop[0][X0], loop[0][Y0]);
    for (const s of loop) {
      if (s[QF]) d.push(OP_Q, s[CX], s[CY], s[X1], s[Y1]); else d.push(OP_L, s[X1], s[Y1]);
    }
    d.push(OP_Z);
  }
  return d;
}

export interface Face { region: PathData; edges: number[]; fill: Fill | null }

/** The face (closed area bounded by edges) containing a point, or null. */
export function faceAt(p: Planar, x: number, y: number): Face | null {
  if (!p.edges.length) return null;
  const { halves, cycles: cs } = cycles(p);
  let best: Cycle | null = null;
  for (const c of cs) if (c.area > 1e-6 && c.region.contains(x, y) && (!best || c.area < best.area)) best = c;
  if (!best) return null;
  const holes: Cycle[] = [];
  for (const c of cs) {
    if (c.area >= -1e-6) continue;
    // sample just outside the component boundary (the right side of a CCW cycle)
    const s = c.segs[0];
    const m = ptAt(s, 0.5), dv = dAt(s, 0.5);
    const l = Math.hypot(dv.x, dv.y) || 1;
    const sx = m.x - (dv.y / l) * SIDE, sy = m.y + (dv.x / l) * SIDE;
    let encl: Cycle | null = null;
    for (const q of cs) if (q.area > 1e-6 && q.region.contains(sx, sy) && (!encl || q.area < encl.area)) encl = q;
    if (encl === best) holes.push(c);
  }
  const edges = [...new Set([...best.halves, ...holes.flatMap((h) => h.halves)].map((h) => halves[h].e))];
  const regions = fillRegions(p);
  // sample the face's fill just inside its outer boundary
  const s0 = best.segs[0];
  const m0 = ptAt(s0, 0.5), d0 = dAt(s0, 0.5);
  const l0 = Math.hypot(d0.x, d0.y) || 1;
  const fill = planarFillAt(p, regions, m0.x - (d0.y / l0) * SIDE, m0.y + (d0.x / l0) * SIDE);
  return { region: segsToPath([best.segs, ...holes.map((h) => h.segs)]), edges, fill };
}

/** Index of the stroked edge nearest to a point within tolerance. */
export function strokeEdgeAt(p: Planar, x: number, y: number, tol: number): number {
  let best = -1, bd = Infinity;
  p.edges.forEach((e, i) => {
    if (!e[ST]) return;
    const w = (p.strokes[e[ST] - 1]?.width ?? 1) / 2;
    const b = bbox(e);
    if (x < b[0] - tol - w || x > b[2] + tol + w || y < b[1] - tol - w || y > b[3] + tol + w) return;
    const c = closestT(e, x, y);
    if (c.d <= tol + w && c.d < bd) { bd = c.d; best = i; }
  });
  return best;
}

/** Connected run of stroked edges through vertices where exactly two strokes meet. */
export function strokeChain(p: Planar, start: number, all = false): number[] {
  const at = new Map<string, number[]>();
  p.edges.forEach((e, i) => {
    if (!e[ST]) return;
    for (const k of [vkey(e[X0], e[Y0]), vkey(e[X1], e[Y1])]) { const l = at.get(k); if (l) l.push(i); else at.set(k, [i]); }
  });
  const seen = new Set<number>([start]);
  const stack = [start];
  while (stack.length) {
    const i = stack.pop()!;
    const e = p.edges[i];
    for (const k of [vkey(e[X0], e[Y0]), vkey(e[X1], e[Y1])]) {
      const l = at.get(k) ?? [];
      if (!all && l.length !== 2) continue;
      for (const j of l) if (!seen.has(j) && (all || p.edges[j][ST] === e[ST])) { seen.add(j); stack.push(j); }
    }
  }
  return [...seen];
}

export function setEdgeStrokes(p: Planar, idx: number[], stroke: Stroke | null): Planar {
  const set = new Set(idx);
  const strokes = [...p.strokes];
  let si = 0;
  if (stroke) {
    const k = skey(stroke);
    si = strokes.findIndex((s) => skey(s) === k) + 1;
    if (!si) { strokes.push(stroke); si = strokes.length; }
  }
  return simplify({ fills: p.fills, strokes, edges: p.edges.map((e, i) => (set.has(i) ? [...e.slice(0, 9), si] : e)) });
}

/** A planar shape containing only the given stroked edges. */
export function extractEdges(p: Planar, idx: number[]): Planar {
  const set = new Set(idx);
  return compactStyles({ fills: p.fills, strokes: p.strokes, edges: p.edges.filter((_, i) => set.has(i)).map((e) => [...e.slice(0, 7), 0, 0, e[ST]]) });
}

/** Moves the vertex at (x,y) (all edges meeting there). */
export function moveVertex(p: Planar, x: number, y: number, nx: number, ny: number): Planar {
  const k = vkey(x, y);
  return {
    ...p,
    edges: p.edges.map((e) => {
      const r = e.slice();
      if (vkey(e[X0], e[Y0]) === k) { r[X0] = nx; r[Y0] = ny; }
      if (vkey(e[X1], e[Y1]) === k) { r[X1] = nx; r[Y1] = ny; }
      if (!r[QF]) { r[CX] = (r[X0] + r[X1]) / 2; r[CY] = (r[Y0] + r[Y1]) / 2; }
      return r;
    }),
  };
}

/** Bends an edge so that it passes through (x, y) at parameter t (selection-tool drag). */
export function bendEdge(p: Planar, index: number, t: number, x: number, y: number): Planar {
  t = Math.max(0.1, Math.min(0.9, t));
  const e = p.edges[index];
  const m = 1 - t;
  const cx = (x - m * m * e[X0] - t * t * e[X1]) / (2 * t * m);
  const cy = (y - m * m * e[Y0] - t * t * e[Y1]) / (2 * t * m);
  const edges = p.edges.slice();
  edges[index] = [e[X0], e[Y0], cx, cy, e[X1], e[Y1], 1, e[F0], e[F1], e[ST]];
  return { ...p, edges };
}

/** Re-runs the arrangement so the shape is planar again after free edits. */
export function normalizePlanar(p: Planar): Planar {
  // relabel by treating the current geometry as authoritative fills (nonzero of each style)
  const regions = fillRegions(p);
  return combine(emptyPlanar(), {
    topEdges: p.edges.map((e) => ({ s: e.slice(0, 7), stroke: e[ST] > 0 ? p.strokes[e[ST] - 1] : null })),
    affects: null,
    fill: (x, y) => planarFillAt(p, regions, x, y),
    stroke: (e) => e.topStroke,
  });
}

export function nearestEdge(p: Planar, x: number, y: number, tol: number): { index: number; t: number; d: number } | null {
  let best: { index: number; t: number; d: number } | null = null;
  p.edges.forEach((e, i) => {
    const b = bbox(e);
    if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) return;
    const c = closestT(e, x, y);
    if (c.d <= tol && (!best || c.d < best.d)) best = { index: i, t: c.t, d: c.d };
  });
  return best;
}

export function vertexNear(p: Planar, x: number, y: number, tol: number): Point | null {
  for (const e of p.edges) {
    if (Math.hypot(e[X0] - x, e[Y0] - y) <= tol) return { x: e[X0], y: e[Y0] };
    if (Math.hypot(e[X1] - x, e[Y1] - y) <= tol) return { x: e[X1], y: e[Y1] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering paths
// ---------------------------------------------------------------------------
const pathCache = new WeakMap<Planar, ShapePath[]>();

function joinLoops(segs: Seg[]): Seg[][] {
  const byStart = new Map<string, number[]>();
  segs.forEach((s, i) => { const k = vkey(s[X0], s[Y0]); const l = byStart.get(k); if (l) l.push(i); else byStart.set(k, [i]); });
  const used = new Uint8Array(segs.length);
  const loops: Seg[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const loop = [segs[i]];
    const startK = vkey(segs[i][X0], segs[i][Y0]);
    for (let guard = 0; guard < segs.length; guard++) {
      const last = loop[loop.length - 1];
      const k = vkey(last[X1], last[Y1]);
      if (k === startK) break;
      const cand = byStart.get(k)?.find((j) => !used[j]);
      if (cand === undefined) break;
      used[cand] = 1;
      loop.push(segs[cand]);
    }
    loops.push(loop);
  }
  return loops;
}

export function planarToPaths(p: Planar): ShapePath[] {
  const hit = pathCache.get(p);
  if (hit) return hit;
  const out: ShapePath[] = [];
  p.fills.forEach((fill, i) => {
    const s = i + 1;
    const segs: Seg[] = [];
    for (const e of p.edges) {
      if (e[F1] === s && e[F0] !== s) segs.push(e.slice(0, 7));
      else if (e[F0] === s && e[F1] !== s) segs.push(reverse(e));
    }
    if (segs.length) out.push({ fill, stroke: null, d: segsToPath(joinLoops(segs)) });
  });
  p.strokes.forEach((stroke, i) => {
    const s = i + 1;
    const segs = p.edges.filter((e) => e[ST] === s).map((e) => e.slice(0, 7));
    if (!segs.length) return;
    // chain strokes so joins render smoothly
    const d: number[] = [];
    const remaining = new Set(segs.map((_, k) => k));
    const byStart = new Map<string, number[]>();
    segs.forEach((g, k) => {
      for (const key of [vkey(g[X0], g[Y0]), vkey(g[X1], g[Y1])]) { const l = byStart.get(key); if (l) l.push(k); else byStart.set(key, [k]); }
    });
    while (remaining.size) {
      const first = remaining.values().next().value as number;
      remaining.delete(first);
      const chain: Seg[] = [segs[first]];
      // extend forward
      for (;;) {
        const last = chain[chain.length - 1];
        const k = vkey(last[X1], last[Y1]);
        const nx = byStart.get(k)?.find((j) => remaining.has(j));
        if (nx === undefined) break;
        remaining.delete(nx);
        const g = segs[nx];
        chain.push(vkey(g[X0], g[Y0]) === k ? g : reverse(g));
      }
      d.push(OP_M, chain[0][X0], chain[0][Y0]);
      for (const g of chain) { if (g[QF]) d.push(OP_Q, g[CX], g[CY], g[X1], g[Y1]); else d.push(OP_L, g[X1], g[Y1]); }
      const a = chain[0], z = chain[chain.length - 1];
      if (chain.length > 1 && vkey(a[X0], a[Y0]) === vkey(z[X1], z[Y1])) d.push(OP_Z);
    }
    out.push({ fill: null, stroke, d });
  });
  pathCache.set(p, out);
  return out;
}

export function planarFromPaths(paths: ShapePath[]): Planar {
  return mergePaths(null, paths, 'over');
}

export { OP_L, OP_M, OP_Q, OP_Z };

/** Replaces the style tables (null removes a style) and merges styles that became identical. */
export function restylePlanar(p: Planar, fills: (Fill | null)[], strokes: (Stroke | null)[]): Planar {
  const fMap: number[] = [], sMap: number[] = [];
  const nf: Fill[] = [], ns: Stroke[] = [];
  const fk = new Map<string, number>(), sk = new Map<string, number>();
  fills.forEach((f, i) => {
    if (!f) { fMap[i + 1] = 0; return; }
    const k = fkey(f);
    let n = fk.get(k);
    if (n === undefined) { nf.push(f); n = nf.length; fk.set(k, n); }
    fMap[i + 1] = n;
  });
  strokes.forEach((s, i) => {
    if (!s) { sMap[i + 1] = 0; return; }
    const k = skey(s);
    let n = sk.get(k);
    if (n === undefined) { ns.push(s); n = ns.length; sk.set(k, n); }
    sMap[i + 1] = n;
  });
  return simplify({
    fills: nf, strokes: ns,
    edges: p.edges.map((e) => [...e.slice(0, 7), e[F0] ? fMap[e[F0]] ?? 0 : 0, e[F1] ? fMap[e[F1]] ?? 0 : 0, e[ST] ? sMap[e[ST]] ?? 0 : 0]),
  });
}
