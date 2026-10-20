// Drawing and editing tools (Animate-compatible behaviour and shortcuts).
import type { Element, Fill, Matrix, PathData, Point, Rect, ShapeElement, ShapePath, Stroke, TextElement, GroupElement, SymbolInstance } from '../core/types';
import { OP_C, OP_L, OP_M, OP_Z } from '../core/types';
import {
  apply, aboutPoint, invert, multiply, normRect, rectsIntersect, rotate, translate, transformRect, isEmptyRect, inflateRect, setCtx, scaleFactor, unionRect, emptyRect,
} from '../core/matrix';
import {
  ellipsePath, lineToPath, pathBounds, pathNodes, polyStarPath, rectPath, toPath2D, transformPath, flatten, OP_SIZE,
} from '../core/path';
import { elementBounds, elementsBounds, hitShapePath, hitElement } from '../core/geometry';
import {
  bendEdge, erasePlanar, planarFromPaths, faceAt, moveVertex, nearestEdge, normalizePlanar, planarToPaths, recolorPlanar, setEdgeStrokes, strokeChain,
  strokeEdgeAt, vertexNear, type Planar,
} from '../core/planar';
import { SUB, isMerge, planarSig, type SubSel } from '../core/merge';
import { loopsToPath, simplifyRDP, smoothPolyline, straightenPolyline, traceBinary } from '../core/trace';
import { cloneElements, uid, rgba } from '../core/util';
import { layoutText } from '../core/symbols';
import { renderElement } from '../core/render';
import { IDENTITY_CT } from '../core/util';
import { store, ui, setUI, addRecentColor, type ToolId } from './state';
import type { Stage } from './stage';

export interface ToolEvent {
  x: number; y: number; sx: number; sy: number;
  shift: boolean; alt: boolean; mod: boolean;
  button: number; pressure: number; isPen: boolean; detail: number;
  native: MouseEvent | PointerEvent;
  pressed?: boolean;
}

type Ctx2D = CanvasRenderingContext2D;

export interface Tool {
  cursor(stage: Stage): string;
  down?(e: ToolEvent, stage: Stage): void;
  move?(e: ToolEvent, stage: Stage): void;
  up?(e: ToolEvent, stage: Stage): void;
  dblclick?(e: ToolEvent, stage: Stage): void;
  key?(e: KeyboardEvent, stage: Stage): boolean;
  overlay?(ctx: Ctx2D, m: Matrix, stage: Stage): void;
  cancel?(stage: Stage): void;
  contextMenu?(e: ToolEvent, stage: Stage): void;
  deactivate?(stage: Stage): void;
}

const I: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

// ---------------- helpers ----------------
/** A degenerate matrix marks gradients that should be fitted to the shape they are applied to. */
export const FIT_GRADIENT: Matrix = { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 };

export function currentFill(): Fill | null {
  if (ui.fillNone) return null;
  if (ui.fillKind !== 'solid' && ui.fillStops.length >= 2) {
    return { kind: ui.fillKind, stops: ui.fillStops.map((s) => ({ ...s })).sort((a, b) => a.offset - b.offset), matrix: FIT_GRADIENT };
  }
  return { kind: 'solid', color: ui.fillColor, alpha: ui.fillAlpha };
}

/** Fits a gradient to a rectangle (Animate's default gradient placement). */
export function fitGradient(fill: Fill, r: Rect): Fill {
  if (fill.kind === 'solid') return fill;
  const w = Math.max(1, r.w), hh = Math.max(1, r.h);
  return { ...fill, matrix: fill.kind === 'linear'
    ? { a: w / 1638.4, b: 0, c: 0, d: hh / 1638.4, tx: r.x + w / 2, ty: r.y + hh / 2 }
    : { a: Math.max(w, hh) / 1638.4, b: 0, c: 0, d: Math.max(w, hh) / 1638.4, tx: r.x + w / 2, ty: r.y + hh / 2 } };
}

function needsFit(f: Fill | null): boolean {
  return !!f && f.kind !== 'solid' && f.matrix.a * f.matrix.d - f.matrix.b * f.matrix.c === 0;
}
export function currentStroke(): Stroke | null {
  return ui.strokeNone ? null : { color: ui.strokeColor, alpha: ui.strokeAlpha, width: ui.strokeWidth, caps: ui.caps, joints: ui.joints };
}

/** Creates a shape element whose matrix places its bbox top-left. */
export function makeShape(paths: ShapePath[]): ShapeElement {
  let r = emptyRect();
  for (const p of paths) r = unionRect(r, pathBounds(p.d));
  const ox = isEmptyRect(r) ? 0 : r.x, oy = isEmptyRect(r) ? 0 : r.y;
  const t = translate(-ox, -oy);
  return {
    type: 'shape', id: uid(), matrix: translate(ox, oy),
    paths: paths.map((p) => {
      const d = transformPath(p.d, t);
      return { ...p, d, fill: needsFit(p.fill) ? fitGradient(p.fill!, pathBounds(d)) : p.fill };
    }),
  };
}

/** Adds drawn geometry: a drawing object in Object Drawing mode, otherwise merged into the layer's raw shape. */
export function drawShape(paths: ShapePath[], label = 'Draw') {
  if (ui.objectDrawing) { store.addElement(makeShape(paths)); return; }
  const fitted = paths.map((p) => ({ ...p, fill: needsFit(p.fill) ? fitGradient(p.fill!, pathBounds(p.d)) : p.fill }));
  store.drawMerged(fitted, 'over', label);
}

function strokeOverlay(ctx: Ctx2D, m: Matrix, d: PathData, fill: Fill | null, stroke: Stroke | null) {
  setCtx(ctx, m);
  const p = toPath2D(d);
  if (fill && fill.kind === 'solid') { ctx.fillStyle = rgba(fill.color, fill.alpha); ctx.fill(p); }
  else if (fill && fill.stops.length) { ctx.fillStyle = rgba(fill.stops[0].color, fill.stops[0].alpha * 0.7); ctx.fill(p); }
  if (stroke) {
    ctx.strokeStyle = rgba(stroke.color, stroke.alpha);
    ctx.lineWidth = stroke.width <= 0.05 ? 1 / scaleFactor(m) : stroke.width;
    ctx.lineCap = stroke.caps === 'butt' ? 'butt' : stroke.caps;
    ctx.lineJoin = stroke.joints;
    ctx.stroke(p);
  }
  if (!fill && !stroke) {
    ctx.strokeStyle = '#2E9BFF';
    ctx.lineWidth = 1 / scaleFactor(m);
    ctx.stroke(p);
  }
}

function dashedRect(ctx: Ctx2D, m: Matrix, r: Rect) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const a = apply(m, r.x, r.y), b = apply(m, r.x + r.w, r.y + r.h);
  ctx.strokeStyle = '#2E9BFF';
  ctx.fillStyle = 'rgba(46,155,255,0.08)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
  ctx.fillRect(x, y, w, hh);
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hh));
  ctx.setLineDash([]);
}

function constrain45(x0: number, y0: number, x: number, y: number): Point {
  const dx = x - x0, dy = y - y0;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(dx, dy);
  return { x: x0 + Math.cos(ang) * len, y: y0 + Math.sin(ang) * len };
}

function dragRect(x0: number, y0: number, e: ToolEvent): Rect {
  let dx = e.x - x0, dy = e.y - y0;
  if (e.shift) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  if (e.alt) return { x: x0 - Math.abs(dx), y: y0 - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return normRect(x0, y0, x0 + dx, y0 + dy);
}

/** Bounds of current selection in edit space. */
function selectionBounds(): Rect {
  return elementsBounds(store.selected().map((s) => s.el), I, store.lib);
}

// ---------------- snapping ----------------
interface SnapLines { x: number[]; y: number[] }
let snapGuides: { x: number | null; y: number | null } = { x: null, y: null };

function snapCandidates(exclude: Set<string>): SnapLines {
  const xs: number[] = [], ys: number[] = [];
  if (store.stack.length === 1 && !store.ctx.groupPath.length) {
    const d = store.doc;
    xs.push(0, d.width / 2, d.width);
    ys.push(0, d.height / 2, d.height);
  } else {
    xs.push(0); ys.push(0);
  }
  for (const s of store.selectable()) {
    if (exclude.has(s.el.id) || exclude.has(SUB + s.el.id)) continue;
    const r = elementBounds(s.el, I, store.lib);
    if (isEmptyRect(r)) continue;
    xs.push(r.x, r.x + r.w / 2, r.x + r.w);
    ys.push(r.y, r.y + r.h / 2, r.y + r.h);
  }
  return { x: xs, y: ys };
}

function snapDelta(b: Rect, dx: number, dy: number, lines: SnapLines, tol: number): [number, number] {
  snapGuides = { x: null, y: null };
  if (!ui.snap) return [dx, dy];
  let bestX = tol, sx = 0;
  for (const edge of [b.x, b.x + b.w / 2, b.x + b.w]) {
    for (const l of lines.x) {
      const d = l - (edge + dx);
      if (Math.abs(d) < bestX) { bestX = Math.abs(d); sx = d; snapGuides.x = l; }
    }
  }
  let bestY = tol, sy = 0;
  for (const edge of [b.y, b.y + b.h / 2, b.y + b.h]) {
    for (const l of lines.y) {
      const d = l - (edge + dy);
      if (Math.abs(d) < bestY) { bestY = Math.abs(d); sy = d; snapGuides.y = l; }
    }
  }
  return [dx + sx, dy + sy];
}

function drawSnapGuides(ctx: Ctx2D, m: Matrix, stage: Stage) {
  if (snapGuides.x === null && snapGuides.y === null) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = '#FF3DA5';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  if (snapGuides.x !== null) {
    const p = apply(m, snapGuides.x, 0);
    ctx.moveTo(Math.round(p.x) + 0.5, 0); ctx.lineTo(Math.round(p.x) + 0.5, stage.canvas.height);
  }
  if (snapGuides.y !== null) {
    const p = apply(m, 0, snapGuides.y);
    ctx.moveTo(0, Math.round(p.y) + 0.5); ctx.lineTo(stage.canvas.width, Math.round(p.y) + 0.5);
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

// ---------------- Selection tool (V) ----------------
interface MoveDrag { kind: 'move'; x0: number; y0: number; originals: Map<string, Matrix>; bounds: Rect; lines: SnapLines; started: boolean; dup: boolean }
interface MarqueeDrag { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; additive: boolean; base: string[] }
interface BendDrag { kind: 'bend'; elId: string; layerId: string; x0: number; y0: number; started: boolean; edge: number; t: number; vertex: Point | null; orig: Planar; shift: boolean }

let selDrag: MoveDrag | MarqueeDrag | BendDrag | null = null;

// ---------------- merge shape (raw shape) picking ----------------
type MergeEl = ShapeElement & { planar: Planar };

/** Part of a raw shape under a point: a stroke segment or the fill area (double-click adds connected strokes). */
function pickPart(el: MergeEl, lx: number, ly: number, tol: number, dbl: boolean): SubSel | null {
  const p = el.planar;
  const sig = planarSig(p);
  const se = strokeEdgeAt(p, lx, ly, tol);
  if (se >= 0) return { all: false, region: null, strokes: false, edges: strokeChain(p, se, dbl), sig };
  const face = faceAt(p, lx, ly);
  if (face && face.fill) {
    let edges: number[] = [];
    if (dbl) {
      const set = new Set<number>();
      for (const i of face.edges) if (p.edges[i][9]) for (const j of strokeChain(p, i, true)) set.add(j);
      edges = [...set];
    }
    return { all: false, region: face.region, strokes: false, edges, sig };
  }
  return null;
}

function localTol(el: Element, stage: Stage, px = 4) {
  return (px * stage.pxSize) / (scaleFactor(el.matrix) || 1);
}

/** Whether a point is on the currently selected part of a raw shape. */
function onSelectedPart(el: MergeEl, x: number, y: number, stage: Stage): boolean {
  const v = store.selected().find((s) => s.el.id === SUB + el.id);
  return !!v && hitElement(v.el, I, x, y, store.lib, 3 * stage.pxSize);
}

function selectPartAt(el: MergeEl, x: number, y: number, stage: Stage, additive: boolean, dbl: boolean): boolean {
  const lp = apply(invert(el.matrix), x, y);
  const pick = pickPart(el, lp.x, lp.y, localTol(el, stage, 3), dbl);
  if (pick) { store.selectParts([{ elId: el.id, sel: pick }], additive); return true; }
  return false;
}

function mergeEditable(elId: string, layerId: string): MergeEl | null {
  const layer = store.timeline().layers.find((l) => l.id === layerId) ?? store.layer();
  if (!layer) return null;
  const list = store.editableElements(layer);
  const el = list?.find((e) => e.id === elId);
  return isMerge(el) ? el : null;
}

export function beginMoveSelection(x0: number, y0: number, duplicate: boolean): MoveDrag {
  return { kind: 'move', x0, y0, originals: new Map(), bounds: selectionBounds(), lines: snapCandidates(new Set(store.selection)), started: false, dup: duplicate };
}

const selectTool: Tool = {
  cursor: () => 'default',
  down(e, stage) {
    const hit = stage.hitTest(e.x, e.y);
    if (hit && isMerge(hit.el)) {
      const el = hit.el;
      if (store.selection.includes(SUB + el.id) && onSelectedPart(el, e.x, e.y, stage) && !e.shift) {
        selDrag = beginMoveSelection(e.x, e.y, e.alt);
        return;
      }
      const lp = apply(invert(el.matrix), e.x, e.y);
      const tol = localTol(el, stage);
      const v = vertexNear(el.planar, lp.x, lp.y, tol * 1.3);
      const ne = nearestEdge(el.planar, lp.x, lp.y, tol);
      if (v || ne) {
        selDrag = { kind: 'bend', elId: el.id, layerId: hit.layer!.id, x0: e.x, y0: e.y, started: false, edge: ne?.index ?? -1, t: ne?.t ?? 0.5, vertex: v, orig: el.planar, shift: e.shift };
        return;
      }
      if (selectPartAt(el, e.x, e.y, stage, e.shift, false)) selDrag = beginMoveSelection(e.x, e.y, e.alt);
      else if (!e.shift) store.clearSelection();
      return;
    }
    if (hit) {
      const isSel = store.selection.includes(hit.el.id);
      if (e.shift) {
        store.select([hit.el.id], true);
        if (!store.selection.includes(hit.el.id)) { selDrag = null; return; }
      } else if (!isSel) {
        store.select([hit.el.id]);
      }
      selDrag = beginMoveSelection(e.x, e.y, e.alt);
    } else {
      if (!e.shift) store.clearSelection();
      selDrag = { kind: 'marquee', x0: e.x, y0: e.y, x1: e.x, y1: e.y, additive: e.shift, base: [...store.selection] };
    }
  },
  move(e, stage) {
    if (!e.pressed || !selDrag) return;
    if (selDrag.kind === 'marquee') {
      selDrag.x1 = e.x; selDrag.y1 = e.y;
      return;
    }
    if (selDrag.kind === 'bend') {
      const b = selDrag;
      if (!b.started) {
        if (Math.hypot(e.x - b.x0, e.y - b.y0) < 3 * stage.pxSize) return;
        b.started = true;
        store.beginLive();
        store.selection = [];
        store.subSel.clear();
      }
      const el = mergeEditable(b.elId, b.layerId);
      if (!el) return;
      const lp = apply(invert(el.matrix), e.x, e.y);
      el.planar = b.vertex ? moveVertex(b.orig, b.vertex.x, b.vertex.y, lp.x, lp.y) : bendEdge(b.orig, b.edge, b.t, lp.x, lp.y);
      el.paths = planarToPaths(el.planar);
      store.emit('doc');
      return;
    }
    const d = selDrag;
    let dx = e.x - d.x0, dy = e.y - d.y0;
    if (!d.started) {
      if (Math.hypot(dx, dy) < 3 * stage.pxSize) return;
      d.started = true;
      store.beginLive();
      if (d.dup) {
        // Alt+drag duplicates the selection and drags the copies
        const ms = store.mutableSelection();
        const newIds: string[] = [];
        for (const s of ms) {
          const c = cloneElements([s.el])[0];
          s.list.splice(s.list.indexOf(s.el) + 1, 0, c);
          newIds.push(c.id);
        }
        store.selection = newIds;
      }
      for (const s of store.mutableSelection()) d.originals.set(s.el.id, s.el.matrix);
    }
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    [dx, dy] = snapDelta(d.bounds, dx, dy, d.lines, 6 * stage.pxSize);
    for (const s of store.mutableSelection()) {
      const o = d.originals.get(s.el.id);
      if (o) s.el.matrix = { ...o, tx: o.tx + dx, ty: o.ty + dy };
    }
    store.emit('doc');
  },
  up(e, stage) {
    const d = selDrag;
    selDrag = null;
    snapGuides = { x: null, y: null };
    if (!d) return;
    if (d.kind === 'bend') {
      if (d.started) {
        const el = mergeEditable(d.elId, d.layerId);
        if (el) { el.planar = normalizePlanar(el.planar); el.paths = planarToPaths(el.planar); }
        store.commitLive('Reshape');
        return;
      }
      // a click (no drag) selects the stroke segment or fill under the cursor
      const f = store.findElement(d.elId);
      if (f && isMerge(f.el) && selectPartAt(f.el, d.x0, d.y0, stage, d.shift, false)) return;
      if (!d.shift) store.clearSelection();
      return;
    }
    if (d.kind === 'marquee') {
      const r = normRect(d.x0, d.y0, d.x1, d.y1);
      if (r.w < 1 && r.h < 1) return;
      const ids: string[] = [];
      const parts: { elId: string; sel: SubSel }[] = [];
      for (const s of store.selectable()) {
        const b = elementBounds(s.el, I, store.lib);
        if (isEmptyRect(b) || !rectsIntersect(r, b)) continue;
        if (isMerge(s.el)) {
          const whole = r.x <= b.x && r.y <= b.y && r.x + r.w >= b.x + b.w && r.y + r.h >= b.y + b.h;
          const region = transformPath(rectPath(r.x, r.y, r.w, r.h), invert(s.el.matrix));
          parts.push({ elId: s.el.id, sel: { all: whole, region: whole ? null : region, strokes: true, edges: [], sig: planarSig(s.el.planar) } });
        } else ids.push(s.el.id);
      }
      if (parts.length) store.selectParts(parts, d.additive, ids);
      else store.select(d.additive ? [...new Set([...d.base, ...ids])] : ids);
      return;
    }
    if (d.started) store.commitLive(d.dup ? 'Duplicate' : 'Move');
    else if (!e.shift) {
      // plain click on an already-selected element within a multi-selection selects just it
      const hit = stage.hitTest(e.x, e.y);
      if (hit && store.selection.length > 1) store.select([hit.el.id]);
    }
  },
  dblclick(e, stage) {
    const hit = stage.hitTest(e.x, e.y);
    if (!hit) { store.exitContext(); return; }
    if (isMerge(hit.el)) { selectPartAt(hit.el, e.x, e.y, stage, e.shift, true); return; }
    enterElement(hit.el, hit.layer!.id, stage);
  },
  overlay(ctx, m, stage) {
    if (selDrag?.kind === 'marquee') dashedRect(ctx, m, normRect(selDrag.x0, selDrag.y0, selDrag.x1, selDrag.y1));
    drawSnapGuides(ctx, m, stage);
  },
  cancel() {
    if (store.isLive) store.cancelLive();
    selDrag = null;
  },
};

export function enterElement(el: Element, layerId: string, stage: Stage) {
  if (el.type === 'symbol') {
    store.enterSymbol(el.libraryItem, multiply(store.groupMatrix(), el.matrix), true);
  } else if (el.type === 'group') {
    store.enterGroup(el as GroupElement, layerId);
  } else if (el.type === 'text') {
    editText(stage, el as TextElement);
  }
}

// ---------------- Subselection tool (A) ----------------
interface NodeDrag { elId: string; pathIndex: number; idx: number; isCtrl: boolean; started: boolean; x0: number; y0: number; orig: PathData; linked: number[] }
let nodeDrag: NodeDrag | null = null;

function nodeAt(stage: Stage, x: number, y: number): { el: ShapeElement; pathIndex: number; idx: number; isCtrl: boolean } | null {
  const tol = 5 * stage.pxSize;
  for (const s of store.selected()) {
    if (s.el.type !== 'shape') continue;
    const el = s.el;
    for (let pi = el.paths.length - 1; pi >= 0; pi--) {
      const d = el.paths[pi].d;
      for (const n of pathNodes(d)) {
        for (const [idx, isCtrl] of [[n.anchor, false], [n.inCtrl, true], [n.outCtrl, true]] as [number | null, boolean][]) {
          if (idx === null) continue;
          const p = apply(el.matrix, d[idx], d[idx + 1]);
          if (Math.hypot(p.x - x, p.y - y) <= tol) return { el, pathIndex: pi, idx, isCtrl };
        }
      }
    }
  }
  return null;
}

/** Indices of coordinates that move together with an anchor (its control points and duplicate closing points). */
function linkedIndices(d: PathData, anchor: number): number[] {
  const out: number[] = [];
  for (const n of pathNodes(d)) {
    if (n.anchor === anchor) {
      if (n.inCtrl !== null) out.push(n.inCtrl);
      if (n.outCtrl !== null) out.push(n.outCtrl);
    }
  }
  // closed subpath where the last anchor duplicates the first
  const x = d[anchor], y = d[anchor + 1];
  for (const n of pathNodes(d)) {
    if (n.anchor !== anchor && Math.abs(d[n.anchor] - x) < 1e-9 && Math.abs(d[n.anchor + 1] - y) < 1e-9) {
      out.push(n.anchor);
      if (n.inCtrl !== null) out.push(n.inCtrl);
      if (n.outCtrl !== null) out.push(n.outCtrl);
    }
  }
  return [...new Set(out)];
}

// raw shapes: vertices and curve control points of the planar edges
let rawSub: { elId: string; layerId: string } | null = null;
interface RawDrag { elId: string; layerId: string; vertex: Point | null; edge: number; x0: number; y0: number; started: boolean; orig: Planar }
let rawDrag: RawDrag | null = null;

function rawSubEl(): MergeEl | null {
  if (!rawSub) return null;
  const f = store.findElement(rawSub.elId);
  return f && isMerge(f.el) ? f.el : null;
}

function rawNodeAt(stage: Stage, x: number, y: number): RawDrag | null {
  const el = rawSubEl();
  if (!el || !rawSub) return null;
  const lp = apply(invert(el.matrix), x, y);
  const tol = localTol(el, stage, 5);
  const p = el.planar;
  for (let i = 0; i < p.edges.length; i++) {
    const e = p.edges[i];
    if (e[6] && Math.hypot(e[2] - lp.x, e[3] - lp.y) <= tol) return { elId: el.id, layerId: rawSub.layerId, vertex: null, edge: i, x0: x, y0: y, started: false, orig: p };
  }
  const v = vertexNear(p, lp.x, lp.y, tol);
  if (v) return { elId: el.id, layerId: rawSub.layerId, vertex: v, edge: -1, x0: x, y0: y, started: false, orig: p };
  return null;
}

const subselectTool: Tool = {
  cursor: () => 'default',
  down(e, stage) {
    const rn = rawNodeAt(stage, e.x, e.y);
    if (rn) { rawDrag = rn; return; }
    const node = nodeAt(stage, e.x, e.y);
    if (node) {
      const d = node.el.paths[node.pathIndex].d;
      nodeDrag = { elId: node.el.id, pathIndex: node.pathIndex, idx: node.idx, isCtrl: node.isCtrl, started: false, x0: e.x, y0: e.y, orig: d, linked: node.isCtrl ? [] : linkedIndices(d, node.idx) };
      return;
    }
    const hit = stage.hitTest(e.x, e.y);
    if (hit && isMerge(hit.el)) {
      rawSub = { elId: hit.el.id, layerId: hit.layer!.id };
      store.clearSelection();
      stage.requestRender();
      return;
    }
    rawSub = null;
    if (hit) store.select([hit.el.id], e.shift);
    else if (!e.shift) store.clearSelection();
  },
  move(e, stage) {
    if (e.pressed && rawDrag) {
      const r = rawDrag;
      if (!r.started) {
        if (Math.hypot(e.x - r.x0, e.y - r.y0) < 2 * stage.pxSize) return;
        r.started = true;
        store.beginLive();
      }
      const el = mergeEditable(r.elId, r.layerId);
      if (!el) return;
      const lp = apply(invert(el.matrix), e.x, e.y);
      if (r.vertex) el.planar = moveVertex(r.orig, r.vertex.x, r.vertex.y, lp.x, lp.y);
      else {
        const edges = r.orig.edges.slice();
        const ed = edges[r.edge].slice();
        ed[2] = lp.x; ed[3] = lp.y;
        edges[r.edge] = ed;
        el.planar = { ...r.orig, edges };
      }
      el.paths = planarToPaths(el.planar);
      store.emit('doc');
      return;
    }
    if (!e.pressed || !nodeDrag) return;
    const nd = nodeDrag;
    if (!nd.started) {
      if (Math.hypot(e.x - nd.x0, e.y - nd.y0) < 2 * stage.pxSize) return;
      nd.started = true;
      store.beginLive();
    }
    const ms = store.mutableSelection().find((s) => s.el.id === nd.elId);
    if (!ms || ms.el.type !== 'shape') return;
    const el = ms.el;
    const inv = invert(el.matrix);
    const p0 = apply(inv, nd.x0, nd.y0), p1 = apply(inv, e.x, e.y);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const d = nd.orig.slice();
    d[nd.idx] += dx; d[nd.idx + 1] += dy;
    for (const k of nd.linked) { d[k] += dx; d[k + 1] += dy; }
    el.paths = el.paths.map((p, i) => (i === nd.pathIndex ? { ...p, d } : p));
    store.emit('doc');
  },
  up() {
    if (rawDrag?.started) {
      const el = mergeEditable(rawDrag.elId, rawDrag.layerId);
      if (el) { el.planar = normalizePlanar(el.planar); el.paths = planarToPaths(el.planar); }
      store.commitLive('Edit Points');
    }
    rawDrag = null;
    if (nodeDrag?.started) store.commitLive('Edit Points');
    nodeDrag = null;
  },
  dblclick(e, stage) {
    const hit = stage.hitTest(e.x, e.y);
    if (hit) enterElement(hit.el, hit.layer!.id, stage);
  },
  overlay(ctx, m) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const raw = rawSubEl();
    if (raw) {
      const mm = multiply(m, raw.matrix);
      setCtx(ctx, mm);
      ctx.strokeStyle = '#2E9BFF';
      ctx.lineWidth = 1 / scaleFactor(mm);
      ctx.beginPath();
      for (const ed of raw.planar.edges) {
        ctx.moveTo(ed[0], ed[1]);
        if (ed[6]) ctx.quadraticCurveTo(ed[2], ed[3], ed[4], ed[5]); else ctx.lineTo(ed[4], ed[5]);
      }
      ctx.stroke();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const seen = new Set<string>();
      for (const ed of raw.planar.edges) {
        if (ed[6]) {
          const c = apply(mm, ed[2], ed[3]);
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2E9BFF';
          ctx.beginPath(); ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        for (const [x, y] of [[ed[0], ed[1]], [ed[4], ed[5]]]) {
          const k = `${x.toFixed(2)},${y.toFixed(2)}`;
          if (seen.has(k)) continue;
          seen.add(k);
          const a = apply(mm, x, y);
          ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2E9BFF';
          ctx.fillRect(Math.round(a.x) - 3, Math.round(a.y) - 3, 6, 6);
          ctx.strokeRect(Math.round(a.x) - 3.5, Math.round(a.y) - 3.5, 7, 7);
        }
      }
    }
    for (const s of store.selected()) {
      if (s.el.type !== 'shape' || s.el.planar) continue;
      const mm = multiply(m, s.el.matrix);
      for (const p of s.el.paths) {
        setCtx(ctx, mm);
        ctx.strokeStyle = '#2E9BFF';
        ctx.lineWidth = 1 / scaleFactor(mm);
        ctx.stroke(toPath2D(p.d));
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const d = p.d;
        for (const n of pathNodes(d)) {
          const a = apply(mm, d[n.anchor], d[n.anchor + 1]);
          for (const ci of [n.inCtrl, n.outCtrl]) {
            if (ci === null) continue;
            const c = apply(mm, d[ci], d[ci + 1]);
            ctx.strokeStyle = 'rgba(46,155,255,0.7)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.stroke();
            ctx.fillStyle = '#fff';
            ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#2E9BFF'; ctx.stroke();
          }
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#2E9BFF';
          ctx.fillRect(Math.round(a.x) - 3, Math.round(a.y) - 3, 6, 6);
          ctx.strokeRect(Math.round(a.x) - 3.5, Math.round(a.y) - 3.5, 7, 7);
        }
      }
    }
  },
  cancel() { if (store.isLive) store.cancelLive(); nodeDrag = null; rawDrag = null; },
  deactivate() { rawSub = null; },
};

// ---------------- Free Transform tool (Q) ----------------
interface TBox { corners: Point[]; pivot: Point } // corners: tl, tr, br, bl (edit space)
type HandleKind = 'scale' | 'rotate' | 'skew' | 'move' | 'pivot';
interface THandle { kind: HandleKind; index: number } // index: 0..7 for scale (corners 0-3, edges 4-7)
interface TDrag { handle: THandle; box: TBox; start: Point; originals: Map<string, Matrix>; started: boolean; pivot: Point }
let tDrag: TDrag | null = null;
let customPivot: { key: string; p: Point } | null = null;

function selKey() { return store.selection.join(',') + '@' + store.frame; }

function transformBox(): TBox | null {
  const sel = store.selected();
  if (!sel.length) return null;
  let corners: Point[];
  if (sel.length === 1 && sel[0].el.type !== 'shape') {
    const el = sel[0].el;
    const inner = elementBounds({ ...el, matrix: I } as Element, I, store.lib);
    if (isEmptyRect(inner)) return null;
    corners = [
      apply(el.matrix, inner.x, inner.y), apply(el.matrix, inner.x + inner.w, inner.y),
      apply(el.matrix, inner.x + inner.w, inner.y + inner.h), apply(el.matrix, inner.x, inner.y + inner.h),
    ];
  } else if (sel.length === 1) {
    const el = sel[0].el;
    const inner = elementBounds({ ...el, matrix: I } as Element, I, store.lib);
    if (isEmptyRect(inner)) return null;
    corners = [
      apply(el.matrix, inner.x, inner.y), apply(el.matrix, inner.x + inner.w, inner.y),
      apply(el.matrix, inner.x + inner.w, inner.y + inner.h), apply(el.matrix, inner.x, inner.y + inner.h),
    ];
  } else {
    const r = selectionBounds();
    if (isEmptyRect(r)) return null;
    corners = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  }
  let pivot: Point = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 };
  if (sel.length === 1 && sel[0].el.type === 'symbol') {
    const s = sel[0].el as SymbolInstance;
    pivot = apply(s.matrix, s.transformPoint.x, s.transformPoint.y);
  } else if (customPivot && customPivot.key === selKey()) {
    pivot = customPivot.p;
  }
  return { corners, pivot };
}

function handlePoints(b: TBox): Point[] {
  const c = b.corners;
  const mid = (a: Point, q: Point) => ({ x: (a.x + q.x) / 2, y: (a.y + q.y) / 2 });
  return [c[0], c[1], c[2], c[3], mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[3]), mid(c[3], c[0])];
}

function findHandle(b: TBox, x: number, y: number, px: number): THandle | null {
  if (Math.hypot(b.pivot.x - x, b.pivot.y - y) < 6 * px) return { kind: 'pivot', index: -1 };
  const hp = handlePoints(b);
  for (let i = 0; i < 8; i++) if (Math.hypot(hp[i].x - x, hp[i].y - y) < 6 * px) return { kind: 'scale', index: i };
  // inside?
  const inside = pointInQuad(b.corners, x, y);
  // near edges -> skew
  for (let i = 0; i < 4; i++) {
    const a = b.corners[i], q = b.corners[(i + 1) % 4];
    if (distToSeg(x, y, a, q) < 4 * px) return { kind: 'skew', index: i };
  }
  if (inside) return { kind: 'move', index: -1 };
  for (let i = 0; i < 4; i++) if (Math.hypot(b.corners[i].x - x, b.corners[i].y - y) < 22 * px) return { kind: 'rotate', index: i };
  return null;
}

function pointInQuad(c: Point[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    if ((c[i].y > y) !== (c[j].y > y) && x < ((c[j].x - c[i].x) * (y - c[i].y)) / (c[j].y - c[i].y) + c[i].x) inside = !inside;
  }
  return inside;
}
function distToSeg(x: number, y: number, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** Basis matrix of the box: maps (u,v) in [0..1]^2 to edit space. */
function boxBasis(b: TBox): Matrix {
  const [c0, c1, , c3] = b.corners;
  return { a: c1.x - c0.x, b: c1.y - c0.y, c: c3.x - c0.x, d: c3.y - c0.y, tx: c0.x, ty: c0.y };
}

function computeTransform(d: TDrag, e: ToolEvent): Matrix {
  const B = boxBasis(d.box);
  const Binv = invert(B);
  const h = d.handle;
  if (h.kind === 'move') {
    let dx = e.x - d.start.x, dy = e.y - d.start.y;
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    return translate(dx, dy);
  }
  if (h.kind === 'rotate') {
    const p = d.pivot;
    let a = Math.atan2(e.y - p.y, e.x - p.x) - Math.atan2(d.start.y - p.y, d.start.x - p.x);
    if (e.shift) a = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
    return aboutPoint(rotate(a), p.x, p.y);
  }
  // work in box-local (u,v) space
  const s = apply(Binv, d.start.x, d.start.y);
  const c = apply(Binv, e.x, e.y);
  if (h.kind === 'skew') {
    // edges: 0 top, 1 right, 2 bottom, 3 left; skew relative to opposite edge (or center with alt)
    let S: Matrix;
    if (h.index === 0 || h.index === 2) {
      const anchorV = e.alt ? 0.5 : h.index === 0 ? 1 : 0;
      const denom = (h.index === 0 ? 0 : 1) - anchorV;
      const k = denom !== 0 ? (c.x - s.x) / denom : 0;
      S = { a: 1, b: 0, c: k, d: 1, tx: -k * anchorV, ty: 0 };
    } else {
      const anchorU = e.alt ? 0.5 : h.index === 1 ? 0 : 1;
      const denom = (h.index === 1 ? 1 : 0) - anchorU;
      const k = denom !== 0 ? (c.y - s.y) / denom : 0;
      S = { a: 1, b: k, c: 0, d: 1, tx: 0, ty: -k * anchorU };
    }
    return multiply(B, multiply(S, Binv));
  }
  // scale: handle positions in uv: corners (0,0),(1,0),(1,1),(0,1); edges (.5,0),(1,.5),(.5,1),(0,.5)
  const uv = [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]][h.index];
  let anchor: Point;
  if (e.alt) anchor = apply(Binv, d.pivot.x, d.pivot.y);
  else anchor = { x: 1 - uv[0], y: 1 - uv[1] };
  const affectX = uv[0] !== 0.5, affectY = uv[1] !== 0.5;
  let sx = affectX && Math.abs(s.x - anchor.x) > 1e-9 ? (c.x - anchor.x) / (s.x - anchor.x) : 1;
  let sy = affectY && Math.abs(s.y - anchor.y) > 1e-9 ? (c.y - anchor.y) / (s.y - anchor.y) : 1;
  if (e.shift && affectX && affectY) {
    const k = Math.max(Math.abs(sx), Math.abs(sy));
    sx = Math.sign(sx || 1) * k; sy = Math.sign(sy || 1) * k;
  }
  if (!Number.isFinite(sx) || Math.abs(sx) < 1e-4) sx = sx < 0 ? -1e-4 : 1e-4;
  if (!Number.isFinite(sy) || Math.abs(sy) < 1e-4) sy = sy < 0 ? -1e-4 : 1e-4;
  const S: Matrix = { a: sx, b: 0, c: 0, d: sy, tx: anchor.x * (1 - sx), ty: anchor.y * (1 - sy) };
  return multiply(B, multiply(S, Binv));
}

const HANDLE_CURSORS = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'];

const transformTool: Tool = {
  cursor: () => 'default',
  down(e, stage) {
    const box = transformBox();
    const px = stage.pxSize;
    const h = box ? findHandle(box, e.x, e.y, px) : null;
    if (!box || !h) {
      const hit = stage.hitTest(e.x, e.y);
      if (hit) {
        if (isMerge(hit.el)) {
          if (!(store.selection.includes(SUB + hit.el.id) && onSelectedPart(hit.el, e.x, e.y, stage))) selectPartAt(hit.el, e.x, e.y, stage, e.shift, true);
        } else if (!store.selection.includes(hit.el.id)) store.select([hit.el.id], e.shift);
        const nb = transformBox();
        if (nb) tDrag = { handle: { kind: 'move', index: -1 }, box: nb, start: { x: e.x, y: e.y }, originals: new Map(), started: false, pivot: nb.pivot };
      } else {
        if (!e.shift) store.clearSelection();
        selDrag = { kind: 'marquee', x0: e.x, y0: e.y, x1: e.x, y1: e.y, additive: e.shift, base: [...store.selection] };
      }
      return;
    }
    tDrag = { handle: h, box, start: { x: e.x, y: e.y }, originals: new Map(), started: false, pivot: box.pivot };
  },
  move(e, stage) {
    if (!e.pressed) {
      const box = transformBox();
      const h = box ? findHandle(box, e.x, e.y, stage.pxSize) : null;
      stage.canvas.style.cursor = !h ? 'default' : h.kind === 'scale' ? HANDLE_CURSORS[h.index] : h.kind === 'rotate' ? 'alias' : h.kind === 'skew' ? 'col-resize' : h.kind === 'pivot' ? 'crosshair' : 'move';
      return;
    }
    if (selDrag?.kind === 'marquee') { selectTool.move!(e, stage); return; }
    const d = tDrag;
    if (!d) return;
    if (d.handle.kind === 'pivot') {
      const sel = store.selected();
      if (sel.length === 1 && sel[0].el.type === 'symbol') {
        if (!d.started) { d.started = true; store.beginLive(); }
        const ms = store.mutableSelection()[0];
        if (ms && ms.el.type === 'symbol') {
          const lp = apply(invert(ms.el.matrix), e.x, e.y);
          ms.el.transformPoint = { x: lp.x, y: lp.y };
          store.emit('doc');
        }
      } else {
        customPivot = { key: selKey(), p: { x: e.x, y: e.y } };
        stage.requestRender();
      }
      return;
    }
    if (!d.started) {
      if (Math.hypot(e.x - d.start.x, e.y - d.start.y) < 2 * stage.pxSize) return;
      d.started = true;
      store.beginLive();
      for (const s of store.mutableSelection()) d.originals.set(s.el.id, s.el.matrix);
    }
    const T = computeTransform(d, e);
    for (const s of store.mutableSelection()) {
      const o = d.originals.get(s.el.id);
      if (o) s.el.matrix = multiply(T, o);
    }
    if (customPivot && customPivot.key === selKey()) customPivot = { key: selKey(), p: apply(T, d.pivot.x, d.pivot.y) };
    store.emit('doc');
  },
  up(e, stage) {
    if (selDrag?.kind === 'marquee') { selectTool.up!(e, stage); return; }
    const d = tDrag;
    tDrag = null;
    if (d?.started) {
      if (customPivot) customPivot = { key: selKey(), p: customPivot.p };
      store.commitLive(d.handle.kind === 'rotate' ? 'Rotate' : d.handle.kind === 'scale' ? 'Scale' : d.handle.kind === 'skew' ? 'Skew' : d.handle.kind === 'pivot' ? 'Move Transformation Point' : 'Move');
    }
  },
  dblclick(e, stage) {
    const box = transformBox();
    if (box && Math.hypot(box.pivot.x - e.x, box.pivot.y - e.y) < 6 * stage.pxSize) {
      // reset transformation point to the center
      const sel = store.selected();
      if (sel.length === 1 && sel[0].el.type === 'symbol') {
        store.transact('Reset Transformation Point', () => {
          const ms = store.mutableSelection()[0];
          if (ms && ms.el.type === 'symbol') {
            const b = elementBounds({ ...ms.el, matrix: I }, I, store.lib);
            ms.el.transformPoint = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
          }
        });
      }
      customPivot = null;
      return;
    }
    selectTool.dblclick!(e, stage);
  },
  overlay(ctx, m) {
    if (selDrag?.kind === 'marquee') { dashedRect(ctx, m, normRect(selDrag.x0, selDrag.y0, selDrag.x1, selDrag.y1)); return; }
    const box = transformBox();
    if (!box) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const c = box.corners.map((p) => apply(m, p.x, p.y));
    ctx.strokeStyle = '#2E9BFF';
    ctx.lineWidth = 1;
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    for (const hp of handlePoints({ corners: c, pivot: box.pivot })) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(Math.round(hp.x) - 3.5, Math.round(hp.y) - 3.5, 7, 7);
      ctx.strokeRect(Math.round(hp.x) - 3.5, Math.round(hp.y) - 3.5, 7, 7);
    }
    const pv = apply(m, box.pivot.x, box.pivot.y);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(pv.x, pv.y, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.stroke();
  },
  cancel() { if (store.isLive) store.cancelLive(); tDrag = null; },
};

// ---------------- primitive shape tools ----------------
interface ShapeDrag { x0: number; y0: number; e: ToolEvent | null }
let shapeDrag: ShapeDrag | null = null;

function buildPrimitive(tool: ToolId, x0: number, y0: number, e: ToolEvent): PathData | null {
  switch (tool) {
    case 'line': {
      const p = e.shift ? constrain45(x0, y0, e.x, e.y) : { x: e.x, y: e.y };
      return lineToPath(x0, y0, p.x, p.y);
    }
    case 'rect': {
      const r = dragRect(x0, y0, e);
      if (r.w < 0.5 && r.h < 0.5) return null;
      return rectPath(r.x, r.y, r.w, r.h, ui.rectRadius);
    }
    case 'oval': {
      const r = dragRect(x0, y0, e);
      if (r.w < 0.5 && r.h < 0.5) return null;
      return ellipsePath(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2);
    }
    case 'polystar': {
      const rr = Math.hypot(e.x - x0, e.y - y0);
      if (rr < 0.5) return null;
      let ang = Math.atan2(e.y - y0, e.x - x0);
      if (e.shift) ang = Math.round(ang / (Math.PI / 12)) * (Math.PI / 12);
      return polyStarPath(x0, y0, rr, ui.polySides, ui.polyStar, ui.polyInner, ang);
    }
  }
  return null;
}

function primitiveTool(id: ToolId): Tool {
  return {
    cursor: () => 'crosshair',
    down(e) {
      if (!store.canDraw()) return;
      shapeDrag = { x0: e.x, y0: e.y, e: null };
    },
    move(e) {
      if (e.pressed && shapeDrag) shapeDrag.e = e;
    },
    up(e) {
      const sd = shapeDrag;
      shapeDrag = null;
      if (!sd) return;
      const d = buildPrimitive(id, sd.x0, sd.y0, e);
      if (!d) return;
      const fill = id === 'line' ? null : currentFill();
      let stroke = currentStroke();
      if (id === 'line' && !stroke) stroke = { color: ui.fillColor, alpha: 1, width: ui.strokeWidth, caps: ui.caps, joints: ui.joints };
      if (!fill && !stroke) { store.flash('Both fill and stroke are set to "No color".'); return; }
      drawShape([{ fill, stroke, d }]);
    },
    overlay(ctx, m) {
      if (!shapeDrag?.e) return;
      const d = buildPrimitive(id, shapeDrag.x0, shapeDrag.y0, shapeDrag.e);
      if (!d) return;
      const fill = id === 'line' ? null : currentFill();
      const stroke = currentStroke() ?? (id === 'line' ? { color: ui.fillColor, alpha: 1, width: ui.strokeWidth, caps: ui.caps, joints: ui.joints } : null);
      strokeOverlay(ctx, m, d, fill, stroke);
    },
    cancel() { shapeDrag = null; },
  };
}

// ---------------- Pencil (Y) ----------------
let pencilPts: Point[] | null = null;
let pencilStart: { x: number; y: number; shift: boolean } | null = null;

const pencilTool: Tool = {
  cursor: () => 'crosshair',
  down(e) {
    if (!store.canDraw()) return;
    pencilPts = [{ x: e.x, y: e.y }];
    pencilStart = { x: e.x, y: e.y, shift: e.shift };
  },
  move(e) {
    if (!e.pressed || !pencilPts) return;
    if (pencilStart?.shift) {
      const dx = e.x - pencilStart.x, dy = e.y - pencilStart.y;
      pencilPts = [{ x: pencilStart.x, y: pencilStart.y }, Math.abs(dx) > Math.abs(dy) ? { x: e.x, y: pencilStart.y } : { x: pencilStart.x, y: e.y }];
      return;
    }
    const last = pencilPts[pencilPts.length - 1];
    if (Math.hypot(e.x - last.x, e.y - last.y) > 0.3) pencilPts.push({ x: e.x, y: e.y });
  },
  up(_e, stage) {
    const pts = pencilPts;
    pencilPts = null;
    if (!pts || pts.length === 0) return;
    const stroke = currentStroke() ?? { color: ui.fillColor, alpha: 1, width: ui.strokeWidth, caps: ui.caps, joints: ui.joints };
    const px = stage.pxSize;
    let d: PathData;
    if (pts.length === 1) d = [OP_M, pts[0].x, pts[0].y, OP_L, pts[0].x + 0.05, pts[0].y];
    else if (pencilStart?.shift || pts.length === 2) d = [OP_M, pts[0].x, pts[0].y, OP_L, pts[1].x, pts[1].y];
    else if (ui.pencilMode === 'straighten') d = straightenPolyline(pts, 3 * px);
    else if (ui.pencilMode === 'ink') d = smoothPolyline(pts, 0.6 * px, false);
    else d = smoothPolyline(pts, 2.2 * px, false);
    drawShape([{ fill: null, stroke, d }]);
  },
  overlay(ctx, m) {
    if (!pencilPts || pencilPts.length < 1) return;
    const stroke = currentStroke() ?? { color: ui.fillColor, alpha: 1, width: ui.strokeWidth, caps: 'round', joints: 'round' };
    const d: PathData = [];
    pencilPts.forEach((p, i) => d.push(i ? OP_L : OP_M, p.x, p.y));
    strokeOverlay(ctx, m, d, null, stroke);
  },
  cancel() { pencilPts = null; },
};

// ---------------- raster helpers (brush, bucket, eraser) ----------------
function makeMaskCanvas(w: number, hgt: number) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, hgt) : Object.assign(document.createElement('canvas'), { width: w, height: hgt });
  return c;
}

function maskFromCanvas(c: OffscreenCanvas | HTMLCanvasElement, threshold = 128): Uint8Array {
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const data = x.getImageData(0, 0, c.width, c.height).data;
  const m = new Uint8Array(c.width * c.height);
  for (let i = 0; i < m.length; i++) m[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
  return m;
}

function chooseScale(r: Rect, preferred: number, max = 2400): number {
  const big = Math.max(r.w, r.h, 1);
  return Math.max(0.05, Math.min(preferred, max / big));
}

interface BrushPt { x: number; y: number; w: number }

function paintBrushStroke(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, pts: BrushPt[], color: string) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (pts.length === 1) {
    ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    ctx.lineWidth = (a.w + b.w) / 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
}

function brushPtsToPath(pts: BrushPt[], screenScale: number): PathData {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxW = 0;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); maxW = Math.max(maxW, p.w);
  }
  const pad = maxW / 2 + 2;
  const r = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
  const scale = chooseScale(r, Math.max(2, screenScale * 2));
  const W = Math.ceil(r.w * scale) + 2, H = Math.ceil(r.h * scale) + 2;
  const c = makeMaskCanvas(W, H);
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.setTransform(scale, 0, 0, scale, -r.x * scale + 1, -r.y * scale + 1);
  paintBrushStroke(x, pts, '#000');
  const mask = maskFromCanvas(c);
  const loops = traceBinary(mask, W, H);
  return loopsToPath(loops, scale, r.x - 1 / scale, r.y - 1 / scale, 0.5);
}

// ---------------- Brush (B) ----------------
let brushPts: BrushPt[] | null = null;
const brushTool: Tool = {
  cursor: () => 'crosshair',
  down(e, stage) {
    if (!store.canDraw()) return;
    if (ui.fillNone) { store.flash('Choose a fill color to paint with the brush.'); return; }
    const w = (ui.brushSize * stage.pxSize) * (ui.brushPressure && e.isPen ? Math.max(0.1, e.pressure) : 1);
    brushPts = [{ x: e.x, y: e.y, w }];
  },
  move(e, stage) {
    if (!e.pressed || !brushPts) return;
    const last = brushPts[brushPts.length - 1];
    const w = (ui.brushSize * stage.pxSize) * (ui.brushPressure && e.isPen ? Math.max(0.1, e.pressure) : 1);
    if (Math.hypot(e.x - last.x, e.y - last.y) > stage.pxSize * 0.75) brushPts.push({ x: e.x, y: e.y, w });
  },
  up(_e, stage) {
    const pts = brushPts;
    brushPts = null;
    if (!pts) return;
    const d = brushPtsToPath(pts, 1 / stage.pxSize);
    if (!d.length) return;
    drawShape([{ fill: currentFill(), stroke: null, d }], 'Brush');
  },
  overlay(ctx, m, stage) {
    if (!brushPts) {
      // brush size preview at the cursor
      const lp = stage.lastPointer();
      if (!lp) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const p = apply(m, lp.x, lp.y);
      ctx.strokeStyle = 'rgba(128,128,128,0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, (ui.brushSize * stage.dpr) / 2, 0, Math.PI * 2); ctx.stroke();
      return;
    }
    setCtx(ctx, m);
    const f = currentFill();
    paintBrushStroke(ctx, brushPts, f && f.kind === 'solid' ? rgba(f.color, f.alpha) : f ? rgba(f.stops[0].color, f.stops[0].alpha) : '#888');
  },
  cancel() { brushPts = null; },
};

// ---------------- Pen (P) ----------------
interface PenAnchor { x: number; y: number; hin: Point | null; hout: Point | null }
let pen: { anchors: PenAnchor[]; dragging: boolean; cursor: Point | null; closed: boolean } | null = null;

function penPath(anchors: PenAnchor[], closed: boolean, extra?: Point): PathData {
  const d: PathData = [];
  if (!anchors.length) return d;
  d.push(OP_M, anchors[0].x, anchors[0].y);
  const seg = (a: PenAnchor, b: PenAnchor) => {
    if (a.hout || b.hin) {
      const c1 = a.hout ?? a, c2 = b.hin ?? b;
      d.push(OP_C, c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    } else d.push(OP_L, b.x, b.y);
  };
  for (let i = 1; i < anchors.length; i++) seg(anchors[i - 1], anchors[i]);
  if (extra) seg(anchors[anchors.length - 1], { x: extra.x, y: extra.y, hin: null, hout: null });
  if (closed) { seg(anchors[anchors.length - 1], anchors[0]); d.push(OP_Z); }
  return d;
}

function finishPen(closed: boolean) {
  const p = pen;
  pen = null;
  if (!p || p.anchors.length < 2) return;
  const d = penPath(p.anchors, closed);
  const stroke = currentStroke() ?? (closed ? null : { color: ui.fillColor, alpha: 1, width: ui.strokeWidth, caps: ui.caps, joints: ui.joints });
  const fill = closed ? currentFill() : null;
  if (!fill && !stroke) return;
  drawShape([{ fill, stroke, d }]);
}

const penTool: Tool = {
  cursor: () => 'crosshair',
  down(e, stage) {
    if (!store.canDraw()) return;
    if (!pen) pen = { anchors: [], dragging: false, cursor: null, closed: false };
    const first = pen.anchors[0];
    if (first && pen.anchors.length > 1 && Math.hypot(first.x - e.x, first.y - e.y) < 6 * stage.pxSize) {
      finishPen(true);
      return;
    }
    let p = { x: e.x, y: e.y };
    const last = pen.anchors[pen.anchors.length - 1];
    if (e.shift && last) p = constrain45(last.x, last.y, e.x, e.y);
    pen.anchors.push({ x: p.x, y: p.y, hin: null, hout: null });
    pen.dragging = true;
  },
  move(e) {
    if (!pen) return;
    pen.cursor = { x: e.x, y: e.y };
    if (e.pressed && pen.dragging) {
      const a = pen.anchors[pen.anchors.length - 1];
      if (Math.hypot(e.x - a.x, e.y - a.y) > 0.5) {
        a.hout = { x: e.x, y: e.y };
        a.hin = { x: 2 * a.x - e.x, y: 2 * a.y - e.y };
      }
    }
  },
  up() { if (pen) pen.dragging = false; },
  dblclick() {
    if (pen && pen.anchors.length > 2) pen.anchors.pop(); // remove the duplicate from the second click
    finishPen(false);
  },
  key(e) {
    if (!pen) return false;
    if (e.key === 'Enter' || e.key === 'Escape') { finishPen(false); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { pen.anchors.pop(); if (!pen.anchors.length) pen = null; return true; }
    return false;
  },
  overlay(ctx, m) {
    if (!pen || !pen.anchors.length) return;
    const d = penPath(pen.anchors, false, pen.dragging ? undefined : pen.cursor ?? undefined);
    strokeOverlay(ctx, m, d, null, currentStroke() ?? { color: '#2E9BFF', alpha: 1, width: 1, caps: 'round', joints: 'round' });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const a of pen.anchors) {
      const p = apply(m, a.x, a.y);
      for (const hnd of [a.hin, a.hout]) {
        if (!hnd) continue;
        const q = apply(m, hnd.x, hnd.y);
        ctx.strokeStyle = '#2E9BFF'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        ctx.fillStyle = '#2E9BFF'; ctx.beginPath(); ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2E9BFF';
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6); ctx.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
    }
  },
  deactivate() { finishPen(false); },
  cancel() { pen = null; },
};

// ---------------- Paint Bucket (K) ----------------
function shapeAt(stage: Stage, x: number, y: number): { el: ShapeElement; index: number; on: 'fill' | 'stroke' } | null {
  const layer = store.layer();
  if (!layer) return null;
  const tol = 3 * stage.pxSize;
  const sel = store.selectable().filter((s) => s.layer.id === layer.id);
  for (const s of sel) {
    if (s.el.type !== 'shape') continue;
    const hit = hitShapePath(s.el, I, x, y, tol);
    if (hit) return { el: s.el, index: hit.index, on: hit.on };
  }
  return null;
}

function editShapePath(elId: string, index: number, fn: (p: ShapePath) => ShapePath | null, label: string) {
  store.transact(label, () => {
    const layer = store.layer();
    if (!layer) return;
    const list = store.editableElements(layer);
    const el = list?.find((e) => e.id === elId);
    if (!el || el.type !== 'shape') return;
    const np = fn(el.paths[index]);
    el.paths = np ? el.paths.map((p, i) => (i === index ? np : p)) : el.paths.filter((_, i) => i !== index);
    if (el.planar) { el.planar = planarFromPaths(el.paths); el.paths = planarToPaths(el.planar); }
  });
}

const GAP_PX = { none: 0, small: 2, medium: 4, large: 8 };

function bucketFillArea(stage: Stage, x: number, y: number): boolean {
  const layer = store.layer();
  if (!layer) return false;
  // render the visible region of the current layer's shapes as a mask
  const inv = invert(stage.editToScreen());
  const tl = apply(inv, 0, 0), br = apply(inv, stage.width, stage.height);
  const view = normRect(tl.x, tl.y, br.x, br.y);
  const scale = chooseScale(view, 1 / stage.pxSize, 1600);
  const W = Math.ceil(view.w * scale), H = Math.ceil(view.h * scale);
  if (W < 2 || H < 2) return false;
  const c = makeMaskCanvas(W, H);
  const cx = c.getContext('2d') as CanvasRenderingContext2D;
  const m: Matrix = { a: scale, b: 0, c: 0, d: scale, tx: -view.x * scale, ty: -view.y * scale };
  const env = { lib: store.lib, assets: store.assets, playback: false, includeHidden: false, showGuides: false, outlines: false };
  for (const el of store.displayed(layer)) {
    if (el.type === 'shape') {
      // strokes and fills both bound regions
      renderElement(cx, el, m, IDENTITY_CT, env, { offset: 0, elapsed: 0, spanAll: true, playback: false }, 0, null, '#000000');
    }
  }
  const walls = maskFromCanvas(c, 40);
  const px = Math.floor((x - view.x) * scale), py = Math.floor((y - view.y) * scale);
  if (px < 0 || py < 0 || px >= W || py >= H) return false;
  // close gaps by dilating walls
  const gap = Math.round(GAP_PX[ui.bucketGap]);
  const grown = gap ? dilate(walls, W, H, gap) : walls;
  if (grown[py * W + px]) return false;
  // flood fill
  const fill = new Uint8Array(W * H);
  const stack = [py * W + px];
  fill[py * W + px] = 1;
  let touchesEdge = false;
  while (stack.length) {
    const i = stack.pop()!;
    const ix = i % W, iy = (i / W) | 0;
    if (ix === 0 || iy === 0 || ix === W - 1 || iy === H - 1) touchesEdge = true;
    const nb = [ix > 0 ? i - 1 : -1, ix < W - 1 ? i + 1 : -1, iy > 0 ? i - W : -1, iy < H - 1 ? i + W : -1];
    for (const n of nb) if (n >= 0 && !fill[n] && !grown[n]) { fill[n] = 1; stack.push(n); }
  }
  if (touchesEdge) { store.flash('Area is not closed. Try a larger gap size or close the outline.'); return true; }
  // grow the fill back under the strokes so it meets them seamlessly
  const region = dilate(fill, W, H, gap + 1);
  const loops = traceBinary(region, W, H);
  const d = loopsToPath(loops, scale, view.x, view.y, 0.5);
  if (!d.length) return true;
  if (!ui.objectDrawing) {
    // merge mode: the new fill slides under everything already on the raw shape
    const f = currentFill();
    store.drawMerged([{ fill: f && needsFit(f) ? fitGradient(f, pathBounds(d)) : f, stroke: null, d }], 'under', 'Fill');
    return true;
  }
  const shape = makeShape([{ fill: currentFill(), stroke: null, d }]);
  store.transact('Fill', () => {
    const list = store.editableElements(layer);
    list?.unshift(shape); // fills go below strokes
  });
  return true;
}

/** Paint bucket on a raw shape: fills the enclosed area under the point. */
function bucketMerge(el: MergeEl, x: number, y: number, fill: Fill): boolean {
  const lp = apply(invert(el.matrix), x, y);
  const face = faceAt(el.planar, lp.x, lp.y);
  if (!face) return false;
  const f = needsFit(fill) ? fitGradient(fill, pathBounds(face.region)) : fill;
  if (face.fill && JSON.stringify(face.fill) === JSON.stringify(f)) return true;
  store.editMerge(el.id, 'Fill', (p) => recolorPlanar(p, face.region, f, false));
  return true;
}

function dilate(src: Uint8Array, W: number, H: number, r: number): Uint8Array {
  if (r <= 0) return src;
  let cur = src;
  for (let k = 0; k < r; k++) {
    const out = new Uint8Array(cur);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < W - 1 && cur[i + 1]) || (y > 0 && cur[i - W]) || (y < H - 1 && cur[i + W])) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

const bucketTool: Tool = {
  cursor: () => 'crosshair',
  down(e, stage) {
    if (!store.canDraw()) return;
    const fill = currentFill();
    if (!fill) { store.flash('Choose a fill color first.'); return; }
    const hit = shapeAt(stage, e.x, e.y);
    if (hit && isMerge(hit.el)) {
      if (bucketMerge(hit.el, e.x, e.y, fill)) return;
    } else if (hit && hit.on === 'fill') {
      editShapePath(hit.el.id, hit.index, (p) => ({ ...p, fill: needsFit(fill) ? fitGradient(fill, pathBounds(p.d)) : fill }), 'Fill');
      return;
    }
    if (hit && hit.on === 'stroke' && !isMerge(hit.el)) return;
    // an empty area enclosed by raw-shape strokes
    const curLayer = store.layer();
    const raw = curLayer ? store.mergeShapeOf(curLayer) : null;
    if (raw && bucketMerge(raw, e.x, e.y, fill)) return;
    // closed stroke-only path under the cursor: give it a fill
    const layer = store.layer();
    if (layer) {
      for (const s of store.selectable().filter((q) => q.layer.id === layer.id)) {
        if (s.el.type !== 'shape') continue;
        const el = s.el;
        const local = apply(invert(el.matrix), e.x, e.y);
        for (let i = el.paths.length - 1; i >= 0; i--) {
          const p = el.paths[i];
          if (p.fill || !p.d.length || p.d[p.d.length - 1] !== OP_Z) continue;
          const ctx = (makeMaskCanvas(1, 1).getContext('2d') as CanvasRenderingContext2D);
          if (ctx.isPointInPath(toPath2D(p.d), local.x, local.y)) {
            editShapePath(el.id, i, (q) => ({ ...q, fill: needsFit(fill) ? fitGradient(fill, pathBounds(q.d)) : fill }), 'Fill');
            return;
          }
        }
      }
    }
    bucketFillArea(stage, e.x, e.y);
  },
};

// ---------------- Ink Bottle (S) ----------------
const inkTool: Tool = {
  cursor: () => 'crosshair',
  down(e, stage) {
    if (!store.canDraw()) return;
    const stroke = currentStroke();
    if (!stroke) { store.flash('Choose a stroke color first.'); return; }
    const hit = shapeAt(stage, e.x, e.y);
    if (hit && isMerge(hit.el)) {
      const el = hit.el;
      const lp = apply(invert(el.matrix), e.x, e.y);
      const p = el.planar;
      const se = strokeEdgeAt(p, lp.x, lp.y, localTol(el, stage, 3));
      let edges: number[] = [];
      if (se >= 0) edges = strokeChain(p, se, true);
      else {
        const face = faceAt(p, lp.x, lp.y);
        if (face) edges = face.edges;
      }
      if (edges.length) store.editMerge(el.id, 'Ink Bottle', (q) => setEdgeStrokes(q, edges, stroke));
      return;
    }
    if (hit) editShapePath(hit.el.id, hit.index, (p) => ({ ...p, stroke }), 'Ink Bottle');
  },
};

// ---------------- Eyedropper (I) ----------------
const eyedropperTool: Tool = {
  cursor: () => 'copy',
  down(e, stage) {
    const hit = stage.hitTest(e.x, e.y);
    if (hit && hit.el.type === 'shape') {
      const sp = hitShapePath(hit.el, I, e.x, e.y, 3 * stage.pxSize);
      if (sp) {
        const p = hit.el.paths[sp.index];
        if (sp.on === 'stroke' && p.stroke) {
          setUI('strokeColor', p.stroke.color); setUI('strokeAlpha', p.stroke.alpha); setUI('strokeNone', false);
          setUI('strokeWidth', p.stroke.width);
          setUI('tool', 'ink');
          return;
        }
        if (p.fill && p.fill.kind !== 'solid') {
          setUI('fillKind', p.fill.kind); setUI('fillStops', p.fill.stops.map((s) => ({ ...s }))); setUI('fillNone', false);
          setUI('tool', 'bucket');
          return;
        }
        if (p.fill?.kind === 'solid') {
          setUI('fillKind', 'solid');
          setUI('fillColor', p.fill.color); setUI('fillAlpha', p.fill.alpha); setUI('fillNone', false);
          addRecentColor(p.fill.color);
          setUI('tool', 'bucket');
          return;
        }
      }
    }
    if (hit && hit.el.type === 'text') {
      setUI('fillColor', hit.el.color); setUI('fillNone', false);
      return;
    }
    // sample the rendered pixel
    const px = stage.ctx.getImageData(Math.floor(e.sx * stage.dpr), Math.floor(e.sy * stage.dpr), 1, 1).data;
    const hex = '#' + [px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    setUI('fillColor', hex); setUI('fillAlpha', 1); setUI('fillNone', false);
    addRecentColor(hex);
  },
};

// ---------------- Eraser (E) ----------------
let eraserPts: Point[] | null = null;

function eraseWithStroke(stage: Stage, pts: Point[]) {
  const layer = store.layer();
  if (!layer) return;
  const radius = (ui.eraserSize * stage.pxSize) / 2;
  let er = emptyRect();
  for (const p of pts) er = unionRect(er, { x: p.x - radius, y: p.y - radius, w: radius * 2, h: radius * 2 });
  const mode = ui.eraserMode;
  let region: PathData | null = null;
  store.transact('Erase', () => {
    const list = store.editableElements(layer, false);
    if (!list) return;
    for (let k = list.length - 1; k >= 0; k--) {
      const el = list[k];
      const b = elementBounds(el, I, store.lib);
      if (isEmptyRect(b) || !rectsIntersect(b, er)) continue;
      if (mode === 'object') {
        const touched = pts.some((p) => stage.hitTest(p.x, p.y)?.el.id === el.id);
        if (touched) list.splice(k, 1);
        continue;
      }
      if (el.type !== 'shape') continue;
      const inv = invert(el.matrix);
      if (isMerge(el)) {
        region ??= brushPtsToPath(pts.map((p) => ({ x: p.x, y: p.y, w: radius * 2 })), 1 / stage.pxSize);
        if (!region.length) continue;
        el.planar = erasePlanar(el.planar, transformPath(region, inv), { fills: mode !== 'lines', strokes: mode !== 'fills' });
        el.paths = planarToPaths(el.planar);
        if (!el.planar.edges.length) list.splice(k, 1);
        continue;
      }
      const local = pts.map((p) => apply(inv, p.x, p.y));
      const lr = radius / (scaleFactor(el.matrix) || 1);
      const next: ShapePath[] = [];
      for (const p of el.paths) {
        // split combined fill+stroke paths so each part is erased independently
        if (p.fill && (mode === 'normal' || mode === 'fills')) {
          const d = eraseFill(p.d, local, lr, 1 / stage.pxSize * scaleFactor(el.matrix));
          if (d.length) next.push({ fill: p.fill, stroke: null, d });
        } else if (p.fill) next.push({ fill: p.fill, stroke: null, d: p.d });
        if (p.stroke && (mode === 'normal' || mode === 'lines')) {
          const d = eraseStroke(p.d, local, lr + p.stroke.width / 2);
          if (d.length) next.push({ fill: null, stroke: p.stroke, d });
        } else if (p.stroke) next.push({ fill: null, stroke: p.stroke, d: p.d });
      }
      if (next.length) el.paths = next; else list.splice(k, 1);
    }
  });
}

function eraseFill(d: PathData, pts: Point[], radius: number, screenScale: number): PathData {
  const r = inflateRect(pathBounds(d), 2);
  const scale = chooseScale(r, Math.max(2, screenScale * 1.5));
  const W = Math.ceil(r.w * scale) + 2, H = Math.ceil(r.h * scale) + 2;
  const c = makeMaskCanvas(W, H);
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  x.setTransform(scale, 0, 0, scale, -r.x * scale + 1, -r.y * scale + 1);
  x.fillStyle = '#000';
  x.fill(toPath2D(d), 'nonzero');
  x.globalCompositeOperation = 'destination-out';
  paintBrushStroke(x, pts.map((p) => ({ x: p.x, y: p.y, w: radius * 2 })), '#000');
  const mask = maskFromCanvas(c);
  return loopsToPath(traceBinary(mask, W, H), scale, r.x - 1 / scale, r.y - 1 / scale, 0.5);
}

export function eraseStroke(d: PathData, pts: Point[], radius: number): PathData {
  const polys = flatten(d, 0.2);
  const step = Math.max(0.25, radius / 3);
  const near = (p: Point) => {
    if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= radius;
    for (let i = 0; i + 1 < pts.length; i++) if (distToSeg(p.x, p.y, pts[i], pts[i + 1]) <= radius) return true;
    return false;
  };
  const out: PathData = [];
  let removed = false;
  for (const poly of polys) {
    const src = poly.closed ? [...poly.pts, poly.pts[0]] : poly.pts;
    // resample so long straight segments are tested along their length
    const dense: Point[] = [];
    for (let i = 0; i < src.length; i++) {
      if (i > 0) {
        const a = src[i - 1], b = src[i];
        const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / step);
        for (let k = 1; k < n; k++) dense.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
      }
      dense.push(src[i]);
    }
    let run: Point[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const s2 = simplifyRDP(run, 0.1);
        s2.forEach((p, i) => out.push(i ? OP_L : OP_M, p.x, p.y));
      }
      run = [];
    };
    for (const p of dense) {
      if (near(p)) { removed = true; flush(); } else run.push(p);
    }
    flush();
  }
  return removed ? out : d;
}

const eraserTool: Tool = {
  cursor: () => 'crosshair',
  down(e) {
    if (!store.canDraw()) return;
    eraserPts = [{ x: e.x, y: e.y }];
  },
  move(e, stage) {
    if (!e.pressed || !eraserPts) return;
    const last = eraserPts[eraserPts.length - 1];
    if (Math.hypot(e.x - last.x, e.y - last.y) > stage.pxSize) eraserPts.push({ x: e.x, y: e.y });
  },
  up(_e, stage) {
    const pts = eraserPts;
    eraserPts = null;
    if (pts) eraseWithStroke(stage, pts);
  },
  overlay(ctx, m, stage) {
    const r = (ui.eraserSize * stage.dpr) / 2;
    if (eraserPts) {
      setCtx(ctx, m);
      const w = ui.eraserSize * stage.pxSize;
      paintBrushStroke(ctx, eraserPts.map((p) => ({ ...p, w })), 'rgba(255,255,255,0.75)');
    }
    const lp = stage.lastPointer();
    if (!lp) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const p = apply(m, lp.x, lp.y);
    ctx.strokeStyle = 'rgba(80,80,80,0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
  },
  cancel() { eraserPts = null; },
};

// ---------------- Text (T) ----------------
let textDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;

export function editText(stage: Stage, existing: TextElement | null, at?: Point, width = 0) {
  const host = stage.overlayHost;
  host.querySelector('.text-editor')?.remove();
  const el: TextElement = existing ?? {
    type: 'text', id: uid(), matrix: translate(at!.x, at!.y), text: '', font: ui.textFont, size: ui.textSize,
    color: ui.fillColor, alpha: 1, bold: ui.textBold, italic: ui.textItalic, align: ui.textAlign, width, lineSpacing: 0, letterSpacing: 0,
  };
  const m = multiply(stage.editToScreen(), el.matrix);
  const zoom = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = el.text;
  ta.spellcheck = false;
  const lay = layoutText(el);
  Object.assign(ta.style, {
    left: m.tx + 'px', top: m.ty + 'px',
    font: `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : ''}${el.size * zoom}px "${el.font}", sans-serif`,
    color: el.color,
    textAlign: el.align,
    lineHeight: `${(el.size * 1.2 + el.lineSpacing) * zoom}px`,
    letterSpacing: `${el.letterSpacing * zoom}px`,
    padding: `${2 * zoom}px`,
    width: el.width > 0 ? `${el.width * zoom}px` : `${Math.max(40, lay.width * zoom + el.size * zoom)}px`,
    minHeight: `${lay.height * zoom}px`,
    transform: `matrix(${m.a / zoom},${m.b / zoom},${m.c / zoom},${m.d / zoom},0,0)`,
    transformOrigin: '0 0',
  });
  const autosize = () => {
    if (el.width <= 0) {
      const probe: TextElement = { ...el, text: ta.value || ' ' };
      const l = layoutText(probe);
      ta.style.width = `${Math.max(40, l.width * zoom + el.size * zoom)}px`;
    }
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', autosize);
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = ta.value.replace(/\r\n?/g, '\n');
    ta.remove();
    if (existing) {
      if (text === existing.text) return;
      store.transact('Edit Text', () => {
        const f = store.mutableSelection().find((s) => s.el.id === existing.id) ?? findMutable(existing.id);
        if (!f) return;
        if (!text.trim()) f.list.splice(f.list.indexOf(f.el), 1);
        else (f.el as TextElement).text = text;
      });
    } else if (text.trim()) {
      store.addElement({ ...el, text });
    }
    stage.el.focus({ preventScroll: true });
  };
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commit(); }
  });
  ta.addEventListener('blur', commit);
  host.append(ta);
  if (existing) store.select([existing.id]);
  requestAnimationFrame(() => { ta.focus(); autosize(); if (existing) ta.select(); });
}

function findMutable(id: string) {
  for (const layer of store.editLayers()) {
    const list = store.editableElements(layer, false);
    const el = list?.find((e) => e.id === id);
    if (el && list) return { layer, el, list };
  }
  return null;
}

const textTool: Tool = {
  cursor: () => 'text',
  down(e, stage) {
    const hit = stage.hitTest(e.x, e.y);
    if (hit && hit.el.type === 'text') { editText(stage, hit.el); return; }
    if (!store.canDraw()) return;
    textDrag = { x0: e.x, y0: e.y, x1: e.x, y1: e.y };
  },
  move(e) { if (e.pressed && textDrag) { textDrag.x1 = e.x; textDrag.y1 = e.y; } },
  up(_e, stage) {
    const d = textDrag;
    textDrag = null;
    if (!d) return;
    const r = normRect(d.x0, d.y0, d.x1, d.y1);
    const width = r.w > 8 * stage.pxSize ? r.w : 0;
    editText(stage, null, { x: width ? r.x : d.x0, y: width ? r.y : d.y0 }, width);
  },
  overlay(ctx, m) { if (textDrag) dashedRect(ctx, m, normRect(textDrag.x0, textDrag.y0, textDrag.x1, textDrag.y1)); },
};

// ---------------- Hand (H) & Zoom (Z) ----------------
let handDrag: { x: number; y: number; view: Matrix } | null = null;
const handTool: Tool = {
  cursor: () => (handDrag ? 'grabbing' : 'grab'),
  down(e) { handDrag = { x: e.sx, y: e.sy, view: ui.view }; },
  move(e) {
    if (!e.pressed || !handDrag) return;
    setUI('view', { ...handDrag.view, tx: handDrag.view.tx + e.sx - handDrag.x, ty: handDrag.view.ty + e.sy - handDrag.y });
  },
  up() { handDrag = null; },
  dblclick(_e, stage) { stage.fitStage(); },
};

let zoomDrag: { x0: number; y0: number; x1: number; y1: number } | null = null;
const zoomTool: Tool = {
  cursor: () => 'zoom-in',
  down(e) { zoomDrag = { x0: e.sx, y0: e.sy, x1: e.sx, y1: e.sy }; },
  move(e) { if (e.pressed && zoomDrag) { zoomDrag.x1 = e.sx; zoomDrag.y1 = e.sy; } },
  up(e, stage) {
    const d = zoomDrag;
    zoomDrag = null;
    if (!d) return;
    if (Math.abs(d.x1 - d.x0) > 6 && Math.abs(d.y1 - d.y0) > 6) {
      const inv = invert(ui.view);
      const a = apply(inv, d.x0, d.y0), b = apply(inv, d.x1, d.y1);
      stage.zoomToRect(normRect(a.x, a.y, b.x, b.y));
      return;
    }
    stage.zoomAt(e.alt ? 0.5 : 2, e.sx, e.sy);
  },
  overlay(ctx, _m, stage) {
    if (!zoomDrag) return;
    ctx.setTransform(stage.dpr, 0, 0, stage.dpr, 0, 0);
    ctx.strokeStyle = '#2E9BFF';
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(zoomDrag.x0, zoomDrag.x1), Math.min(zoomDrag.y0, zoomDrag.y1), Math.abs(zoomDrag.x1 - zoomDrag.x0), Math.abs(zoomDrag.y1 - zoomDrag.y0));
    ctx.setLineDash([]);
  },
};

// ---------------- Gradient Transform (F) ----------------
interface GradTarget { el: ShapeElement; index: number; G: Matrix }
let gradDrag: { kind: 'center' | 'xaxis' | 'yaxis'; elId: string; index: number; started: boolean } | null = null;

function gradientTarget(): GradTarget | null {
  for (const s of store.selected()) {
    if (s.el.type !== 'shape') continue;
    const index = s.el.paths.findIndex((p) => p.fill && p.fill.kind !== 'solid');
    if (index < 0) continue;
    const f = s.el.paths[index].fill as Exclude<Fill, { kind: 'solid' }>;
    return { el: s.el, index, G: multiply(s.el.matrix, f.matrix) };
  }
  return null;
}

function gradHandles(t: GradTarget) {
  return {
    center: apply(t.G, 0, 0),
    x: apply(t.G, 819.2, 0),
    y: apply(t.G, 0, 819.2),
  };
}

const gradientTool: Tool = {
  cursor: () => 'default',
  down(e, stage) {
    const t = gradientTarget();
    if (t) {
      const hp = gradHandles(t);
      const tol = 7 * stage.pxSize;
      const kind = Math.hypot(hp.x.x - e.x, hp.x.y - e.y) < tol ? 'xaxis'
        : Math.hypot(hp.y.x - e.x, hp.y.y - e.y) < tol ? 'yaxis'
          : Math.hypot(hp.center.x - e.x, hp.center.y - e.y) < tol * 1.5 ? 'center' : null;
      if (kind) { gradDrag = { kind, elId: t.el.id, index: t.index, started: false }; return; }
    }
    const hit = stage.hitTest(e.x, e.y);
    if (hit) store.select([hit.el.id]); else store.clearSelection();
    if (hit && !gradientTarget()) store.flash('This object has no gradient fill. Choose a linear or radial fill in the Color panel.');
  },
  move(e) {
    if (!e.pressed || !gradDrag) return;
    const g = gradDrag;
    if (!g.started) { g.started = true; store.beginLive(); }
    const ms = store.mutableSelection().find((s) => s.el.id === g.elId);
    if (!ms || ms.el.type !== 'shape') return;
    const el = ms.el;
    const p = el.paths[g.index];
    if (!p?.fill || p.fill.kind === 'solid') return;
    const local = apply(invert(el.matrix), e.x, e.y);
    const m = { ...p.fill.matrix };
    if (g.kind === 'center') { m.tx = local.x; m.ty = local.y; }
    else if (g.kind === 'xaxis') {
      const vx = (local.x - m.tx) / 819.2, vy = (local.y - m.ty) / 819.2;
      const ylen = Math.hypot(m.c, m.d) || Math.hypot(vx, vy);
      const xlen = Math.hypot(vx, vy) || 1;
      m.a = vx; m.b = vy;
      // keep the perpendicular axis orthogonal (rotation follows the handle)
      m.c = (-vy / xlen) * ylen; m.d = (vx / xlen) * ylen;
    } else {
      m.c = (local.x - m.tx) / 819.2; m.d = (local.y - m.ty) / 819.2;
    }
    if (Math.abs(m.a * m.d - m.b * m.c) < 1e-9) return;
    const oldFill = p.fill;
    const newFill = { ...(oldFill as Exclude<Fill, { kind: 'solid' }>), matrix: m };
    if (el.planar) {
      const key = JSON.stringify(oldFill);
      el.planar = { ...el.planar, fills: el.planar.fills.map((fl) => (JSON.stringify(fl) === key ? newFill : fl)) };
      el.paths = planarToPaths(el.planar);
      gradDrag.index = el.paths.findIndex((q) => q.fill === newFill);
    } else el.paths = el.paths.map((q, i) => (i === g.index ? { ...q, fill: newFill } : q));
    store.emit('doc');
  },
  up() {
    if (gradDrag?.started) store.commitLive('Gradient Transform');
    gradDrag = null;
  },
  overlay(ctx, m) {
    const t = gradientTarget();
    if (!t) return;
    const hp = gradHandles(t);
    const c = apply(m, hp.center.x, hp.center.y), x = apply(m, hp.x.x, hp.x.y), y = apply(m, hp.y.x, hp.y.y);
    const radial = (t.el.paths[t.index].fill as Exclude<Fill, { kind: 'solid' }>).kind === 'radial';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#2E9BFF';
    ctx.lineWidth = 1;
    // outline of the gradient box
    const gm = multiply(m, t.G);
    ctx.save();
    setCtx(ctx, gm);
    ctx.lineWidth = 1 / scaleFactor(gm);
    ctx.setLineDash([4 / scaleFactor(gm), 3 / scaleFactor(gm)]);
    if (radial) { ctx.beginPath(); ctx.arc(0, 0, 819.2, 0, Math.PI * 2); ctx.stroke(); }
    else { ctx.strokeRect(-819.2, -819.2, 1638.4, 1638.4); }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(x.x, x.y); ctx.stroke();
    if (radial) { ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(y.x, y.y); ctx.stroke(); }
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(c.x, c.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillRect(x.x - 4, x.y - 4, 8, 8); ctx.strokeRect(x.x - 4, x.y - 4, 8, 8);
    if (radial) { ctx.beginPath(); ctx.arc(y.x, y.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  },
  cancel() { if (store.isLive) store.cancelLive(); gradDrag = null; },
};

export const tools: Record<ToolId, Tool> = {
  gradient: gradientTool,
  select: selectTool,
  subselect: subselectTool,
  transform: transformTool,
  line: primitiveTool('line'),
  rect: primitiveTool('rect'),
  oval: primitiveTool('oval'),
  polystar: primitiveTool('polystar'),
  pencil: pencilTool,
  brush: brushTool,
  pen: penTool,
  bucket: bucketTool,
  ink: inkTool,
  eyedropper: eyedropperTool,
  eraser: eraserTool,
  text: textTool,
  hand: handTool,
  zoom: zoomTool,
};

export const TOOL_LIST: { id: ToolId; name: string; key: string; icon: string }[] = [
  { id: 'select', name: 'Selection Tool', key: 'V', icon: 'select' },
  { id: 'subselect', name: 'Subselection Tool', key: 'A', icon: 'subselect' },
  { id: 'transform', name: 'Free Transform Tool', key: 'Q', icon: 'transform' },
  { id: 'gradient', name: 'Gradient Transform Tool', key: 'F', icon: 'gradient' },
  { id: 'line', name: 'Line Tool', key: 'N', icon: 'line' },
  { id: 'rect', name: 'Rectangle Tool', key: 'R', icon: 'rect' },
  { id: 'oval', name: 'Oval Tool', key: 'O', icon: 'oval' },
  { id: 'polystar', name: 'PolyStar Tool', key: '', icon: 'polystar' },
  { id: 'pencil', name: 'Pencil Tool', key: 'Y', icon: 'pencil' },
  { id: 'brush', name: 'Brush Tool', key: 'B', icon: 'brush' },
  { id: 'pen', name: 'Pen Tool', key: 'P', icon: 'pen' },
  { id: 'bucket', name: 'Paint Bucket Tool', key: 'K', icon: 'bucket' },
  { id: 'ink', name: 'Ink Bottle Tool', key: 'S', icon: 'ink' },
  { id: 'eyedropper', name: 'Eyedropper Tool', key: 'I', icon: 'eyedropper' },
  { id: 'eraser', name: 'Eraser Tool', key: 'E', icon: 'eraser' },
  { id: 'text', name: 'Text Tool', key: 'T', icon: 'text' },
  { id: 'hand', name: 'Hand Tool', key: 'H', icon: 'hand' },
  { id: 'zoom', name: 'Zoom Tool', key: 'Z', icon: 'zoom' },
];

export { transformRect, OP_SIZE };
