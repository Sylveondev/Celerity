import { OP_C, OP_L, OP_M, OP_Q, OP_Z, type Matrix, type PathData, type Point, type Rect } from './types';
import { emptyRect } from './matrix';

export const OP_SIZE = [3, 3, 5, 7, 1];

export interface PathVisitor {
  M(x: number, y: number): void;
  L(x: number, y: number): void;
  Q(cx: number, cy: number, x: number, y: number): void;
  C(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  Z(): void;
}

export function visit(d: PathData, v: PathVisitor) {
  let i = 0;
  const n = d.length;
  while (i < n) {
    const op = d[i];
    switch (op) {
      case OP_M: v.M(d[i + 1], d[i + 2]); i += 3; break;
      case OP_L: v.L(d[i + 1], d[i + 2]); i += 3; break;
      case OP_Q: v.Q(d[i + 1], d[i + 2], d[i + 3], d[i + 4]); i += 5; break;
      case OP_C: v.C(d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6]); i += 7; break;
      case OP_Z: v.Z(); i += 1; break;
      default: return; // corrupt data: stop safely
    }
  }
}

// ---------- Path2D cache ----------
const p2dCache = new WeakMap<PathData, Path2D>();

export function toPath2D(d: PathData): Path2D {
  let p = p2dCache.get(d);
  if (p) return p;
  p = new Path2D();
  const path = p;
  visit(d, {
    M: (x, y) => path.moveTo(x, y),
    L: (x, y) => path.lineTo(x, y),
    Q: (cx, cy, x, y) => path.quadraticCurveTo(cx, cy, x, y),
    C: (a, b, c, e, x, y) => path.bezierCurveTo(a, b, c, e, x, y),
    Z: () => path.closePath(),
  });
  p2dCache.set(d, p);
  return p;
}

export function traceCtx(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, d: PathData) {
  visit(d, {
    M: (x, y) => ctx.moveTo(x, y),
    L: (x, y) => ctx.lineTo(x, y),
    Q: (cx, cy, x, y) => ctx.quadraticCurveTo(cx, cy, x, y),
    C: (a, b, c, e, x, y) => ctx.bezierCurveTo(a, b, c, e, x, y),
    Z: () => ctx.closePath(),
  });
}

// ---------- transforms ----------
export function transformPath(d: PathData, m: Matrix): PathData {
  const out: number[] = new Array(d.length);
  let i = 0;
  while (i < d.length) {
    const op = d[i];
    out[i] = op;
    const size = OP_SIZE[op];
    if (size === undefined) break;
    for (let k = 1; k < size; k += 2) {
      const x = d[i + k], y = d[i + k + 1];
      out[i + k] = m.a * x + m.c * y + m.tx;
      out[i + k + 1] = m.b * x + m.d * y + m.ty;
    }
    i += size;
  }
  return out;
}

// ---------- bounds ----------
function quadExtrema(p0: number, p1: number, p2: number, cb: (t: number) => void) {
  const den = p0 - 2 * p1 + p2;
  if (Math.abs(den) > 1e-12) {
    const t = (p0 - p1) / den;
    if (t > 0 && t < 1) cb(t);
  }
}
function cubicExtrema(p0: number, p1: number, p2: number, p3: number, cb: (t: number) => void) {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) {
      const t = -c / b;
      if (t > 0 && t < 1) cb(t);
    }
    return;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  const s = Math.sqrt(disc);
  const t1 = (-b + s) / (2 * a), t2 = (-b - s) / (2 * a);
  if (t1 > 0 && t1 < 1) cb(t1);
  if (t2 > 0 && t2 < 1) cb(t2);
}

export function pathBounds(d: PathData, m?: Matrix): Rect {
  const src = m ? transformPath(d, m) : d;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  let cx = 0, cy = 0, sx = 0, sy = 0;
  visit(src, {
    M: (x, y) => { add(x, y); cx = sx = x; cy = sy = y; },
    L: (x, y) => { add(x, y); cx = x; cy = y; },
    Q: (qx, qy, x, y) => {
      const x0 = cx, y0 = cy;
      add(x, y);
      const ev = (t: number) => {
        const mt = 1 - t;
        add(mt * mt * x0 + 2 * mt * t * qx + t * t * x, mt * mt * y0 + 2 * mt * t * qy + t * t * y);
      };
      quadExtrema(x0, qx, x, ev);
      quadExtrema(y0, qy, y, ev);
      cx = x; cy = y;
    },
    C: (ax, ay, bx, by, x, y) => {
      const x0 = cx, y0 = cy;
      add(x, y);
      const ev = (t: number) => {
        const mt = 1 - t;
        const k0 = mt * mt * mt, k1 = 3 * mt * mt * t, k2 = 3 * mt * t * t, k3 = t * t * t;
        add(k0 * x0 + k1 * ax + k2 * bx + k3 * x, k0 * y0 + k1 * ay + k2 * by + k3 * y);
      };
      cubicExtrema(x0, ax, bx, x, ev);
      cubicExtrema(y0, ay, by, y, ev);
      cx = x; cy = y;
    },
    Z: () => { cx = sx; cy = sy; },
  });
  if (minX === Infinity) return emptyRect();
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ---------- builders ----------
const K = 0.5522847498307936; // 4/3*(sqrt(2)-1)

export function rectPath(x: number, y: number, w: number, h: number, r = 0): PathData {
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 0) return [OP_M, x, y, OP_L, x + w, y, OP_L, x + w, y + h, OP_L, x, y + h, OP_Z];
  const k = r * (1 - K);
  return [
    OP_M, x + r, y,
    OP_L, x + w - r, y,
    OP_C, x + w - k, y, x + w, y + k, x + w, y + r,
    OP_L, x + w, y + h - r,
    OP_C, x + w, y + h - k, x + w - k, y + h, x + w - r, y + h,
    OP_L, x + r, y + h,
    OP_C, x + k, y + h, x, y + h - k, x, y + h - r,
    OP_L, x, y + r,
    OP_C, x, y + k, x + k, y, x + r, y,
    OP_Z,
  ];
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathData {
  rx = Math.abs(rx); ry = Math.abs(ry);
  const kx = rx * K, ky = ry * K;
  return [
    OP_M, cx + rx, cy,
    OP_C, cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry,
    OP_C, cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy,
    OP_C, cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry,
    OP_C, cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy,
    OP_Z,
  ];
}

export function polyStarPath(cx: number, cy: number, r: number, sides: number, star: boolean, innerRatio: number, rot = -Math.PI / 2): PathData {
  sides = Math.max(3, Math.min(32, Math.round(sides)));
  const pts: Point[] = [];
  const n = star ? sides * 2 : sides;
  for (let i = 0; i < n; i++) {
    const a = rot + (i * Math.PI * 2) / n;
    const rr = star && i % 2 === 1 ? r * innerRatio : r;
    pts.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
  }
  return polylinePath(pts, true);
}

export function polylinePath(pts: Point[], closed: boolean): PathData {
  const d: number[] = [];
  pts.forEach((p, i) => d.push(i === 0 ? OP_M : OP_L, p.x, p.y));
  if (closed && pts.length > 2) d.push(OP_Z);
  return d;
}

// ---------- flattening ----------
export interface Polyline { pts: Point[]; closed: boolean }

export function flatten(d: PathData, tol = 0.25): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  const steps = (len: number) => Math.max(2, Math.min(256, Math.ceil(Math.sqrt(len / Math.max(tol, 0.01)) * 1.5)));
  visit(d, {
    M: (x, y) => {
      cur = { pts: [{ x, y }], closed: false };
      out.push(cur);
      cx = sx = x; cy = sy = y;
    },
    L: (x, y) => {
      if (!cur) { cur = { pts: [{ x: cx, y: cy }], closed: false }; out.push(cur); }
      cur.pts.push({ x, y }); cx = x; cy = y;
    },
    Q: (qx, qy, x, y) => {
      if (!cur) { cur = { pts: [{ x: cx, y: cy }], closed: false }; out.push(cur); }
      const len = Math.hypot(qx - cx, qy - cy) + Math.hypot(x - qx, y - qy);
      const n = steps(len);
      for (let i = 1; i <= n; i++) {
        const t = i / n, mt = 1 - t;
        cur.pts.push({ x: mt * mt * cx + 2 * mt * t * qx + t * t * x, y: mt * mt * cy + 2 * mt * t * qy + t * t * y });
      }
      cx = x; cy = y;
    },
    C: (ax, ay, bx, by, x, y) => {
      if (!cur) { cur = { pts: [{ x: cx, y: cy }], closed: false }; out.push(cur); }
      const len = Math.hypot(ax - cx, ay - cy) + Math.hypot(bx - ax, by - ay) + Math.hypot(x - bx, y - by);
      const n = steps(len);
      for (let i = 1; i <= n; i++) {
        const t = i / n, mt = 1 - t;
        const k0 = mt * mt * mt, k1 = 3 * mt * mt * t, k2 = 3 * mt * t * t, k3 = t * t * t;
        cur.pts.push({ x: k0 * cx + k1 * ax + k2 * bx + k3 * x, y: k0 * cy + k1 * ay + k2 * by + k3 * y });
      }
      cx = x; cy = y;
    },
    Z: () => {
      if (cur) cur.closed = true;
      cx = sx; cy = sy;
      cur = null;
    },
  });
  return out.filter((p) => p.pts.length > 0);
}

export function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// ---------- segment model used by tweening and export ----------
export interface CubicSeg { x0: number; y0: number; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }
export interface Subpath { segs: CubicSeg[]; closed: boolean; sx: number; sy: number }

/** Converts any path into subpaths made only of cubic segments. */
export function toCubicSubpaths(d: PathData): Subpath[] {
  const out: Subpath[] = [];
  let cur: Subpath | null = null;
  let cx = 0, cy = 0;
  const ensure = () => {
    if (!cur) { cur = { segs: [], closed: false, sx: cx, sy: cy }; out.push(cur); }
    return cur;
  };
  visit(d, {
    M: (x, y) => { cur = { segs: [], closed: false, sx: x, sy: y }; out.push(cur); cx = x; cy = y; },
    L: (x, y) => {
      ensure().segs.push({ x0: cx, y0: cy, c1x: cx + (x - cx) / 3, c1y: cy + (y - cy) / 3, c2x: cx + (2 * (x - cx)) / 3, c2y: cy + (2 * (y - cy)) / 3, x, y });
      cx = x; cy = y;
    },
    Q: (qx, qy, x, y) => {
      ensure().segs.push({ x0: cx, y0: cy, c1x: cx + (2 / 3) * (qx - cx), c1y: cy + (2 / 3) * (qy - cy), c2x: x + (2 / 3) * (qx - x), c2y: y + (2 / 3) * (qy - y), x, y });
      cx = x; cy = y;
    },
    C: (ax, ay, bx, by, x, y) => {
      ensure().segs.push({ x0: cx, y0: cy, c1x: ax, c1y: ay, c2x: bx, c2y: by, x, y });
      cx = x; cy = y;
    },
    Z: () => {
      const c = cur as Subpath | null;
      if (c) {
        if (Math.hypot(cx - c.sx, cy - c.sy) > 1e-6) {
          const x = c.sx, y = c.sy;
          c.segs.push({ x0: cx, y0: cy, c1x: cx + (x - cx) / 3, c1y: cy + (y - cy) / 3, c2x: cx + (2 * (x - cx)) / 3, c2y: cy + (2 * (y - cy)) / 3, x, y });
          cx = x; cy = y;
        }
        c.closed = true;
      }
      cur = null;
    },
  });
  return out;
}

export function subpathsToPath(sps: Subpath[]): PathData {
  const d: number[] = [];
  for (const sp of sps) {
    d.push(OP_M, sp.sx, sp.sy);
    for (const s of sp.segs) d.push(OP_C, s.c1x, s.c1y, s.c2x, s.c2y, s.x, s.y);
    if (sp.closed) d.push(OP_Z);
  }
  return d;
}

export function splitCubic(s: CubicSeg, t: number): [CubicSeg, CubicSeg] {
  const lx = (a: number, b: number) => a + (b - a) * t;
  const x01 = lx(s.x0, s.c1x), y01 = lx(s.y0, s.c1y);
  const x12 = lx(s.c1x, s.c2x), y12 = lx(s.c1y, s.c2y);
  const x23 = lx(s.c2x, s.x), y23 = lx(s.c2y, s.y);
  const x012 = lx(x01, x12), y012 = lx(y01, y12);
  const x123 = lx(x12, x23), y123 = lx(y12, y23);
  const xm = lx(x012, x123), ym = lx(y012, y123);
  return [
    { x0: s.x0, y0: s.y0, c1x: x01, c1y: y01, c2x: x012, c2y: y012, x: xm, y: ym },
    { x0: xm, y0: ym, c1x: x123, c1y: y123, c2x: x23, c2y: y23, x: s.x, y: s.y },
  ];
}

export function cubicLength(s: CubicSeg): number {
  // chord/polygon average approximation, good enough for subdivision heuristics
  const chord = Math.hypot(s.x - s.x0, s.y - s.y0);
  const poly = Math.hypot(s.c1x - s.x0, s.c1y - s.y0) + Math.hypot(s.c2x - s.c1x, s.c2y - s.c1y) + Math.hypot(s.x - s.c2x, s.y - s.c2y);
  return (chord + poly) / 2;
}

/**
 * Approximates a cubic with quadratic segments (needed for SWF and XFL edges,
 * which only support quadratic curves). Returns [cx, cy, x, y] tuples.
 */
export function cubicToQuads(s: CubicSeg, tol = 0.1): number[][] {
  const out: number[][] = [];
  const rec = (c: CubicSeg, depth: number) => {
    // Candidate control point: average of the two tangent-intersection estimates
    const qx = (3 * (c.c1x + c.c2x) - c.x0 - c.x) / 4;
    const qy = (3 * (c.c1y + c.c2y) - c.y0 - c.y) / 4;
    // Error estimate (from the cubic-to-quad error bound)
    const ex = c.x - 3 * c.c2x + 3 * c.c1x - c.x0;
    const ey = c.y - 3 * c.c2y + 3 * c.c1y - c.y0;
    const err = (Math.sqrt(3) / 36) * Math.hypot(ex, ey);
    if (err <= tol || depth >= 6) {
      out.push([qx, qy, c.x, c.y]);
      return;
    }
    const [a, b] = splitCubic(c, 0.5);
    rec(a, depth + 1);
    rec(b, depth + 1);
  };
  rec(s, 0);
  return out;
}

/** Returns the path with only M, L, Q, Z commands (cubics approximated). */
export function toQuadPath(d: PathData, tol = 0.1): PathData {
  const out: number[] = [];
  let cx = 0, cy = 0;
  visit(d, {
    M: (x, y) => { out.push(OP_M, x, y); cx = x; cy = y; },
    L: (x, y) => { out.push(OP_L, x, y); cx = x; cy = y; },
    Q: (qx, qy, x, y) => { out.push(OP_Q, qx, qy, x, y); cx = x; cy = y; },
    C: (ax, ay, bx, by, x, y) => {
      for (const q of cubicToQuads({ x0: cx, y0: cy, c1x: ax, c1y: ay, c2x: bx, c2y: by, x, y }, tol)) out.push(OP_Q, q[0], q[1], q[2], q[3]);
      cx = x; cy = y;
    },
    Z: () => out.push(OP_Z),
  });
  return out;
}

export function pathToSvg(d: PathData, digits = 2): string {
  const f = (n: number) => {
    const s = n.toFixed(digits);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  const parts: string[] = [];
  visit(d, {
    M: (x, y) => parts.push(`M${f(x)} ${f(y)}`),
    L: (x, y) => parts.push(`L${f(x)} ${f(y)}`),
    Q: (a, b, x, y) => parts.push(`Q${f(a)} ${f(b)} ${f(x)} ${f(y)}`),
    C: (a, b, c, e, x, y) => parts.push(`C${f(a)} ${f(b)} ${f(c)} ${f(e)} ${f(x)} ${f(y)}`),
    Z: () => parts.push('Z'),
  });
  return parts.join('');
}

/** Lists anchor points (for subselection). Returns indices into d of x coords. */
export interface PathNode { anchor: number; inCtrl: number | null; outCtrl: number | null }
export function pathNodes(d: PathData): PathNode[] {
  const nodes: PathNode[] = [];
  let i = 0;
  let last: PathNode | null = null;
  while (i < d.length) {
    const op = d[i];
    const size = OP_SIZE[op];
    if (size === undefined) break;
    if (op === OP_M || op === OP_L) {
      last = { anchor: i + 1, inCtrl: null, outCtrl: null };
      nodes.push(last);
    } else if (op === OP_Q) {
      if (last) last.outCtrl = i + 1;
      last = { anchor: i + 3, inCtrl: i + 1, outCtrl: null };
      nodes.push(last);
    } else if (op === OP_C) {
      if (last) last.outCtrl = i + 1;
      last = { anchor: i + 5, inCtrl: i + 3, outCtrl: null };
      nodes.push(last);
    } else if (op === OP_Z) {
      last = null;
    }
    i += size;
  }
  return nodes;
}

export function isClosedPath(d: PathData): boolean {
  return d.length > 0 && d[d.length - 1] === OP_Z;
}

/** Reverses each subpath (used for hole orientation). */
export function reverseSubpath(sp: Subpath): Subpath {
  const segs = sp.segs.slice().reverse().map((s) => ({ x0: s.x, y0: s.y, c1x: s.c2x, c1y: s.c2y, c2x: s.c1x, c2y: s.c1y, x: s.x0, y: s.y0 }));
  const sx = segs.length ? segs[0].x0 : sp.sx;
  const sy = segs.length ? segs[0].y0 : sp.sy;
  return { segs, closed: sp.closed, sx, sy };
}

export function lineToPath(x1: number, y1: number, x2: number, y2: number): PathData {
  return [OP_M, x1, y1, OP_L, x2, y2];
}
