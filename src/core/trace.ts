// Raster <-> vector helpers used by the Brush, Paint Bucket and Eraser tools:
//  * traceBinary: turns a binary mask into closed outline loops (holes included)
//  * simplify / fitCubics: turns noisy polylines into smooth cubic Béziers
import type { PathData, Point } from './types';
import { OP_C, OP_L, OP_M, OP_Z } from './types';

/**
 * Traces pixel boundaries of a binary mask (1 = inside). Loops are returned in
 * pixel-corner coordinates. Outer boundaries are clockwise (y-down) and holes
 * counter-clockwise, so the result fills correctly with the non-zero rule.
 */
export function traceBinary(mask: Uint8Array, w: number, h: number): Point[][] {
  const W = w + 1; // vertex grid width
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  // outgoing edges per vertex: up to 2 (saddle points)
  const out = new Map<number, number[]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = y0 * W + x0;
    const v = y1 * W + x1;
    const arr = out.get(k);
    if (arr) arr.push(v); else out.set(k, [v]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);           // top: left -> right
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);   // right: top -> bottom
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);   // bottom: right -> left
      if (!at(x - 1, y)) add(x, y + 1, x, y);           // left: bottom -> top
    }
  }
  const loops: Point[][] = [];
  for (const [startKey] of out) {
    let arr = out.get(startKey);
    while (arr && arr.length) {
      const loop: Point[] = [];
      let cur = startKey;
      let prevDir = -1;
      let guard = 0;
      while (guard++ < 4 * w * h + 8) {
        const edges = out.get(cur);
        if (!edges || edges.length === 0) break;
        let pick = 0;
        if (edges.length > 1 && prevDir >= 0) {
          // at saddles prefer turning right to keep loops simple
          let bestScore = -Infinity;
          for (let i = 0; i < edges.length; i++) {
            const d = dirOf(cur, edges[i], W);
            const score = ((d - prevDir + 4) % 4 === 1) ? 2 : ((d - prevDir + 4) % 4 === 0 ? 1 : 0);
            if (score > bestScore) { bestScore = score; pick = i; }
          }
        }
        const next = edges.splice(pick, 1)[0];
        if (edges.length === 0) out.delete(cur);
        loop.push({ x: cur % W, y: Math.floor(cur / W) });
        prevDir = dirOf(cur, next, W);
        cur = next;
        if (cur === startKey) break;
      }
      if (loop.length >= 4) loops.push(removeCollinear(loop));
      arr = out.get(startKey);
    }
  }
  return loops;
}

function dirOf(a: number, b: number, W: number): number {
  const ax = a % W, ay = Math.floor(a / W), bx = b % W, by = Math.floor(b / W);
  if (bx > ax) return 0; // right
  if (by > ay) return 1; // down
  if (bx < ax) return 2; // left
  return 3;              // up
}

function removeCollinear(pts: Point[]): Point[] {
  const out: Point[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Smooths pixel staircases: short (1px) edges are replaced by their midpoints
 * while corners between two long edges stay sharp.
 */
export function smoothStairs(loop: Point[]): Point[] {
  const n = loop.length;
  if (n < 4) return loop;
  const isLong = (i: number) => {
    const a = loop[i % n], b = loop[(i + 1) % n];
    return Math.abs(b.x - a.x) + Math.abs(b.y - a.y) > 1.5;
  };
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    if (!isLong(i)) out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    else if (isLong(i - 1 + n)) out.push(a);
  }
  return out.length >= 3 ? out : loop;
}

/** RDP simplification for closed loops (no repeated end point). */
export function simplifyClosed(pts: Point[], eps: number): Point[] {
  if (pts.length < 4) return pts.slice();
  let k = 0, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > best) { best = d; k = i; }
  }
  const a = simplifyRDP(pts.slice(0, k + 1), eps);
  const b = simplifyRDP(pts.slice(k).concat([pts[0]]), eps);
  return a.concat(b.slice(1, -1));
}

export function simplifyRDP(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      // degenerate base line (closed run): use distance to the point instead
      const d = len < 1e-9 ? Math.hypot(p.x - a.x, p.y - a.y) : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------- Schneider curve fitting ----------------
type V = Point;
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const addv = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: V, s: number): V => ({ x: a.x * s, y: a.y * s });
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y;
const len = (a: V) => Math.hypot(a.x, a.y);
const norm = (a: V): V => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };

export type Bez = [V, V, V, V];

function bezPt(b: Bez, t: number): V {
  const mt = 1 - t;
  const k0 = mt * mt * mt, k1 = 3 * mt * mt * t, k2 = 3 * mt * t * t, k3 = t * t * t;
  return { x: k0 * b[0].x + k1 * b[1].x + k2 * b[2].x + k3 * b[3].x, y: k0 * b[0].y + k1 * b[1].y + k2 * b[2].y + k3 * b[3].y };
}
function bezD1(b: Bez, t: number): V {
  const mt = 1 - t;
  return {
    x: 3 * mt * mt * (b[1].x - b[0].x) + 6 * mt * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * mt * mt * (b[1].y - b[0].y) + 6 * mt * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  };
}
function bezD2(b: Bez, t: number): V {
  const mt = 1 - t;
  return {
    x: 6 * mt * (b[2].x - 2 * b[1].x + b[0].x) + 6 * t * (b[3].x - 2 * b[2].x + b[1].x),
    y: 6 * mt * (b[2].y - 2 * b[1].y + b[0].y) + 6 * t * (b[3].y - 2 * b[2].y + b[1].y),
  };
}

function chordParams(pts: V[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(pts: V[], u: number[], t1: V, t2: V): Bez {
  const first = pts[0], last = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i], mt = 1 - t;
    const b1 = 3 * mt * mt * t, b2 = 3 * mt * t * t;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const b0 = mt * mt * mt, b3 = t * t * t;
    const tmp = sub(pts[i], addv(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alpha1 = 0, alpha2 = 0;
  if (Math.abs(det) > 1e-12) {
    alpha1 = (x0 * c11 - c01 * x1) / det;
    alpha2 = (c00 * x1 - x0 * c01) / det;
  }
  const segLen = len(sub(last, first));
  const eps = 1e-6 * segLen;
  // fall back to the heuristic when the least-squares solution is degenerate
  // or wildly overshoots (which produces loops far away from the points)
  let maxDist = 0;
  for (const p of pts) maxDist = Math.max(maxDist, len(sub(p, first)));
  const limit = Math.max(segLen, maxDist) * 2;
  if (!(alpha1 >= eps && alpha2 >= eps && alpha1 <= limit && alpha2 <= limit)) {
    const d = segLen / 3;
    return [first, addv(first, mul(t1, d)), addv(last, mul(t2, d)), last];
  }
  return [first, addv(first, mul(t1, alpha1)), addv(last, mul(t2, alpha2)), last];
}

function reparam(b: Bez, pts: V[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bezPt(b, t), pts[i]);
    const d1 = bezD1(b, t), d2 = bezD2(b, t);
    const num = dot(d, d1);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - num / den));
  });
}

function maxError(pts: V[], b: Bez, u: number[]): [number, number] {
  let max = 0, split = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len(sub(bezPt(b, u[i]), pts[i]));
    if (d > max) { max = d; split = i; }
  }
  return [max, split];
}

function fitCubic(pts: V[], t1: V, t2: V, err: number, out: Bez[], depth: number) {
  if (pts.length === 2) {
    const d = len(sub(pts[1], pts[0])) / 3;
    out.push([pts[0], addv(pts[0], mul(t1, d)), addv(pts[1], mul(t2, d)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let bez = generateBezier(pts, u, t1, t2);
  let [e, split] = maxError(pts, bez, u);
  if (e < err) { out.push(bez); return; }
  if (e < err * 4) {
    for (let i = 0; i < 12; i++) {
      u = reparam(bez, pts, u);
      bez = generateBezier(pts, u, t1, t2);
      [e, split] = maxError(pts, bez, u);
      if (e < err) { out.push(bez); return; }
    }
  }
  if (depth > 40 || pts.length < 3) { out.push(bez); return; }
  split = Math.max(1, Math.min(pts.length - 2, split));
  const tc = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts.slice(0, split + 1), t1, tc, err, out, depth + 1);
  fitCubic(pts.slice(split), mul(tc, -1), t2, err, out, depth + 1);
}

/** Fits cubic Béziers to an open polyline. */
export function fitCurve(pts: V[], err: number): Bez[] {
  const clean: V[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) clean.push(p);
  }
  if (clean.length < 2) return [];
  const out: Bez[] = [];
  const t1 = norm(sub(clean[1], clean[0]));
  const t2 = norm(sub(clean[clean.length - 2], clean[clean.length - 1]));
  fitCubic(clean, t1, t2, err, out, 0);
  return out;
}

/** Indices of sharp corners in a polyline (angle change > threshold). */
export function findCorners(pts: V[], closed: boolean, thresholdDeg = 70): number[] {
  const out: number[] = [];
  const n = pts.length;
  const cos = Math.cos((thresholdDeg * Math.PI) / 180);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const d1 = norm(sub(b, a)), d2 = norm(sub(c, b));
    if (dot(d1, d2) < cos) out.push(i);
  }
  return out;
}

/** Converts a closed polygon loop into a smooth path (corners kept sharp). */
export function fitClosedLoop(loop: V[], err: number, d: number[]) {
  if (loop.length < 3) return;
  const corners = findCorners(loop, true);
  let pts = loop;
  if (corners.length) {
    const s = corners[0];
    pts = loop.slice(s).concat(loop.slice(0, s));
  }
  pts = pts.concat([pts[0]]);
  const cornerSet = new Set(findCorners(pts.slice(0, -1), true));
  const pieces: V[][] = [];
  let cur: V[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    cur.push(pts[i]);
    if (cornerSet.has(i) && i < pts.length - 1) { pieces.push(cur); cur = [pts[i]]; }
  }
  pieces.push(cur);
  d.push(OP_M, pts[0].x, pts[0].y);
  for (const piece of pieces) {
    if (piece.length === 2) { d.push(OP_L, piece[1].x, piece[1].y); continue; }
    if (!corners.length && piece === pieces[0]) {
      // smooth closed loop: use symmetric tangent at the seam
      const n = piece.length;
      const tSeam = norm(sub(piece[1], piece[n - 2]));
      const out: Bez[] = [];
      fitCubic(piece, tSeam, mul(tSeam, -1), err, out, 0);
      for (const b of out) d.push(OP_C, b[1].x, b[1].y, b[2].x, b[2].y, b[3].x, b[3].y);
      continue;
    }
    for (const b of fitCurve(piece, err)) d.push(OP_C, b[1].x, b[1].y, b[2].x, b[2].y, b[3].x, b[3].y);
  }
  d.push(OP_Z);
}

/**
 * Converts mask loops (pixel coords) into a vector path in world coordinates:
 * world = pixel / scale + origin.
 */
export function loopsToPath(loops: Point[][], scale: number, ox: number, oy: number, err = 0.6): PathData {
  const d: number[] = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const smooth = smoothStairs(loop);
    const simplified = simplifyClosed(smooth, 0.35);
    if (simplified.length < 3) continue;
    const world = simplified.map((p) => ({ x: p.x / scale + ox, y: p.y / scale + oy }));
    fitClosedLoop(world, err / scale, d);
  }
  return d;
}

/** Freehand polyline -> smooth open/closed path (pencil "smooth" mode). */
export function smoothPolyline(pts: V[], err: number, closed: boolean): PathData {
  const d: number[] = [];
  if (pts.length === 0) return d;
  if (pts.length === 1) return [OP_M, pts[0].x, pts[0].y, OP_L, pts[0].x + 0.01, pts[0].y];
  if (closed) {
    fitClosedLoop(simplifyClosed(pts, err * 0.25), err, d);
    return d;
  }
  const simplified = simplifyRDP(pts, err * 0.25);
  const corners = new Set(findCorners(simplified, false));
  d.push(OP_M, simplified[0].x, simplified[0].y);
  let piece: V[] = [simplified[0]];
  for (let i = 1; i < simplified.length; i++) {
    piece.push(simplified[i]);
    if (corners.has(i) || i === simplified.length - 1) {
      if (piece.length === 2) d.push(OP_L, piece[1].x, piece[1].y);
      else for (const b of fitCurve(piece, err)) d.push(OP_C, b[1].x, b[1].y, b[2].x, b[2].y, b[3].x, b[3].y);
      piece = [simplified[i]];
    }
  }
  return d;
}

/** Pencil "straighten" mode: polyline after aggressive simplification. */
export function straightenPolyline(pts: V[], eps: number): PathData {
  const s = simplifyRDP(pts, eps);
  const d: number[] = [];
  s.forEach((p, i) => d.push(i === 0 ? OP_M : OP_L, p.x, p.y));
  return d;
}
