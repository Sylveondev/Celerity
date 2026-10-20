// Helpers for merge-drawing-model shapes and part selections.
import type { Element, PathData, ShapeElement, ShapePath } from './types';
import { OP_M, OP_Z } from './types';
import {
  emptyPlanar, erasePlanar, extractEdges, restylePlanar, extractPlanar, mergePlanar, planarToPaths, setEdgeStrokes, closestT, type Planar,
} from './planar';

/** Prefix of selection ids that refer to a part of a merge shape (`~<shape id>`). */
export const SUB = '~';

/** A selected part of a merge shape. */
export interface SubSel {
  all: boolean;
  region: PathData | null;   // selected area (fills inside it)
  strokes: boolean;          // region also selects the strokes inside it
  edges: number[];           // explicitly selected stroke edges
  sig: string;               // planar signature the edge indices refer to
}

export function isMerge(el: Element | null | undefined): el is ShapeElement & { planar: Planar } {
  return !!el && el.type === 'shape' && !!el.planar && !el.lifted;
}

export function planarSig(p: Planar): string {
  let h = 0;
  for (const e of p.edges) h = (h * 31 + e[0] * 7 + e[1] * 13 + e[4] * 17 + e[5] * 19 + e[7] + e[8] * 3 + e[9] * 5) % 1e9;
  return `${p.edges.length}:${h.toFixed(3)}`;
}

export function subAll(p: Planar): SubSel {
  return { all: true, region: null, strokes: true, edges: [], sig: planarSig(p) };
}

export function partOf(p: Planar, s: SubSel): Planar {
  if (s.all) return p;
  let part = s.region ? extractPlanar(p, s.region, s.strokes) : emptyPlanar();
  if (s.edges.length) part = mergePlanar(part, extractEdges(p, s.edges));
  return part;
}

export function removePart(p: Planar, s: SubSel): Planar {
  if (s.all) return emptyPlanar();
  let r = p;
  if (s.edges.length) r = setEdgeStrokes(r, s.edges, null);
  if (s.region) r = erasePlanar(r, s.region, { fills: true, strokes: s.strokes });
  return r;
}

/** Union of two part selections of the same shape. */
export function unionSub(a: SubSel, b: SubSel): SubSel {
  if (a.all || b.all) return { ...a, all: true };
  const region = a.region && b.region ? [...a.region, ...b.region] : a.region ?? b.region;
  return { all: false, region, strokes: a.strokes || b.strokes, edges: [...new Set([...a.edges, ...b.edges])], sig: a.sig };
}

/** Builds a selection of `whole` covering the given parts (after they were merged into it). */
export function subFromParts(whole: Planar, parts: Planar[]): SubSel {
  const region: number[] = [];
  const strokeSegs: number[][] = [];
  for (const part of parts) {
    for (const sp of planarToPaths(part)) if (sp.fill) region.push(...sp.d);
    for (const e of part.edges) if (e[9]) strokeSegs.push(e);
  }
  const edges: number[] = [];
  if (strokeSegs.length) {
    whole.edges.forEach((e, i) => {
      if (!e[9]) return;
      const mx = 0.25 * e[0] + 0.5 * e[2] + 0.25 * e[4], my = 0.25 * e[1] + 0.5 * e[3] + 0.25 * e[5];
      for (const s of strokeSegs) {
        if (mx < Math.min(s[0], s[2], s[4]) - 0.1 || mx > Math.max(s[0], s[2], s[4]) + 0.1) continue;
        if (my < Math.min(s[1], s[3], s[5]) - 0.1 || my > Math.max(s[1], s[3], s[5]) + 0.1) continue;
        if (closestT(s, mx, my).d < 0.05) { edges.push(i); break; }
      }
    });
  }
  return { all: false, region: region.length ? region : null, strokes: false, edges, sig: planarSig(whole) };
}

export function mergeShapeElement(id: string, p: Planar): ShapeElement {
  return { type: 'shape', id, matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, planar: p, paths: planarToPaths(p) };
}

/** Applies a per-path style change to a shape (drawing object or raw shape). */
export function mapShapeStyles(el: ShapeElement, fn: (p: ShapePath) => ShapePath) {
  if (!el.planar) { el.paths = el.paths.map(fn).filter((p) => p.fill || p.stroke); return; }
  const P = el.planar;
  const paths = planarToPaths(P);
  const fills = P.fills.map((f) => fn({ fill: f, stroke: null, d: paths.find((q) => q.fill === f)?.d ?? [OP_M, 0, 0, OP_Z] }).fill);
  const strokes = P.strokes.map((s) => fn({ fill: null, stroke: s, d: [] }).stroke);
  el.planar = restylePlanar(P, fills, strokes);
  el.paths = planarToPaths(el.planar);
}
