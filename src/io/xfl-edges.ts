// XFL <Edge edges="..."> encoding/decoding.
//
// Format (reverse engineered; see xfl2svg and SWF spec):
//   "!" x y            moveTo
//   "|" or "/" x y     lineTo
//   "[" or "]" cx cy x y quadratic curveTo
//   "S" digit          selection marker (ignored)
// Numbers are twips (1/20 px), either decimal or "#" signed 32-bit fixed
// point hex ("#4A.8" -> 0x00004A80 / 256 twips).
// fillStyle0 is the fill on the left of the edge direction, fillStyle1 on the right.

import { OP_L, OP_M, OP_Q, OP_Z, type PathData, type Point } from '../core/types';
import { flatten, polygonArea, toQuadPath, visit } from '../core/path';

export function parseEdgeNumber(tok: string): number {
  if (tok[0] === '#') {
    const [ip, fp = ''] = tok.slice(1).split('.');
    const hex = ip.padStart(6, '0') + fp.padEnd(2, '0').slice(0, 2);
    let v = parseInt(hex, 16);
    if (v & 0x80000000) v = v - 0x100000000; // signed 32-bit
    return v / 256 / 20;
  }
  return parseFloat(tok) / 20;
}

export type EdgeSeg =
  | { t: 'L'; x0: number; y0: number; x: number; y: number }
  | { t: 'Q'; x0: number; y0: number; cx: number; cy: number; x: number; y: number };

/** Parses an edge string into chains of connected segments. */
export function parseEdges(s: string): EdgeSeg[][] {
  const tokens = s.match(/[!|/[\]]|S\d|#[0-9A-Fa-f]+(?:\.[0-9A-Fa-f]+)?|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) || [];
  const chains: EdgeSeg[][] = [];
  let chain: EdgeSeg[] | null = null;
  let cx = 0, cy = 0;
  let i = 0;
  const nextNum = () => {
    while (i < tokens.length && tokens[i][0] === 'S') i++;
    const t = tokens[i++];
    return t === undefined ? NaN : parseEdgeNumber(t);
  };
  while (i < tokens.length) {
    const t = tokens[i++];
    if (t === '!') {
      const x = nextNum(), y = nextNum();
      if (Number.isNaN(x) || Number.isNaN(y)) break;
      if (!chain || Math.abs(x - cx) > 1e-9 || Math.abs(y - cy) > 1e-9) {
        chain = [];
        chains.push(chain);
      }
      cx = x; cy = y;
    } else if (t === '|' || t === '/') {
      const x = nextNum(), y = nextNum();
      if (Number.isNaN(x) || Number.isNaN(y)) break;
      if (!chain) { chain = []; chains.push(chain); }
      chain.push({ t: 'L', x0: cx, y0: cy, x, y });
      cx = x; cy = y;
    } else if (t === '[' || t === ']') {
      const qx = nextNum(), qy = nextNum(), x = nextNum(), y = nextNum();
      if ([qx, qy, x, y].some(Number.isNaN)) break;
      if (!chain) { chain = []; chains.push(chain); }
      chain.push({ t: 'Q', x0: cx, y0: cy, cx: qx, cy: qy, x, y });
      cx = x; cy = y;
    }
    // "S#" markers and stray numbers are skipped
  }
  return chains.filter((c) => c.length > 0);
}

export function reverseChain(c: EdgeSeg[]): EdgeSeg[] {
  return c.slice().reverse().map((s) => (s.t === 'L'
    ? { t: 'L', x0: s.x, y0: s.y, x: s.x0, y: s.y0 }
    : { t: 'Q', x0: s.x, y0: s.y, cx: s.cx, cy: s.cy, x: s.x0, y: s.y0 }));
}

const key = (x: number, y: number) => `${Math.round(x * 20)},${Math.round(y * 20)}`;

/** Joins edge chains into closed loops (for fills) and returns path data. */
export function chainsToFillPath(chains: EdgeSeg[][]): PathData {
  const unused = new Set<number>(chains.map((_, i) => i));
  const byStart = new Map<string, number[]>();
  chains.forEach((c, i) => {
    const k = key(c[0].x0, c[0].y0);
    const arr = byStart.get(k);
    if (arr) arr.push(i); else byStart.set(k, [i]);
  });
  const d: number[] = [];
  const take = (k: string): number | undefined => {
    const arr = byStart.get(k);
    if (!arr) return undefined;
    while (arr.length) {
      const i = arr.pop()!;
      if (unused.has(i)) return i;
    }
    return undefined;
  };
  for (let i = 0; i < chains.length; i++) {
    if (!unused.has(i)) continue;
    unused.delete(i);
    const startK = key(chains[i][0].x0, chains[i][0].y0);
    const loop: EdgeSeg[] = [...chains[i]];
    let guard = 0;
    while (guard++ < 100000) {
      const last = loop[loop.length - 1];
      const ek = key(last.x, last.y);
      if (ek === startK) break;
      const nx = take(ek);
      if (nx === undefined) break;
      unused.delete(nx);
      loop.push(...chains[nx]);
    }
    d.push(OP_M, loop[0].x0, loop[0].y0);
    for (const s of loop) {
      if (s.t === 'L') d.push(OP_L, s.x, s.y);
      else d.push(OP_Q, s.cx, s.cy, s.x, s.y);
    }
    d.push(OP_Z);
  }
  return d;
}

export function chainsToStrokePath(chains: EdgeSeg[][]): PathData {
  const d: number[] = [];
  let px = NaN, py = NaN;
  for (const c of chains) {
    if (Math.abs(c[0].x0 - px) > 1e-9 || Math.abs(c[0].y0 - py) > 1e-9) d.push(OP_M, c[0].x0, c[0].y0);
    for (const s of c) {
      if (s.t === 'L') d.push(OP_L, s.x, s.y);
      else d.push(OP_Q, s.cx, s.cy, s.x, s.y);
    }
    const last = c[c.length - 1];
    px = last.x; py = last.y;
  }
  return d;
}

// ---------------- encoding ----------------

const tw = (v: number) => String(Math.round(v * 20));

/**
 * Encodes path data (any commands) to an XFL edge string. Subpaths that are
 * closed get an explicit closing line.
 */
export function encodeEdges(d: PathData): string {
  const q = toQuadPath(d, 0.05);
  let s = '';
  let sx = 0, sy = 0, cx = 0, cy = 0;
  let open = false;
  visit(q, {
    M: (x, y) => { s += `!${tw(x)} ${tw(y)}`; sx = cx = x; sy = cy = y; open = true; },
    L: (x, y) => { s += `|${tw(x)} ${tw(y)}`; cx = x; cy = y; },
    Q: (a, b, x, y) => { s += `[${tw(a)} ${tw(b)} ${tw(x)} ${tw(y)}`; cx = x; cy = y; },
    C: () => { /* not present after toQuadPath */ },
    Z: () => {
      if (open && (tw(cx) !== tw(sx) || tw(cy) !== tw(sy))) s += `|${tw(sx)} ${tw(sy)}`;
      cx = sx; cy = sy;
    },
  });
  return s;
}

/**
 * Determines which side of the edges the fill lies on. Returns 1 (right,
 * fillStyle1) for clockwise outer contours in y-down space, otherwise 0.
 */
export function fillSide(d: PathData): 0 | 1 {
  const polys = flatten(d, 1);
  let best = 0;
  let bestAbs = -1;
  for (const p of polys) {
    const a = polygonArea(p.pts as Point[]);
    if (Math.abs(a) > bestAbs) { bestAbs = Math.abs(a); best = a; }
  }
  return best >= 0 ? 1 : 0;
}

export { OP_Z };
