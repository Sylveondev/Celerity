// Editing operations used by menus, shortcuts and panels.
import type { Element, Frame, Layer, LibraryItem, Matrix, Rect, ShapeElement, SymbolInstance, SymbolType, TextElement } from '../core/types';
import { aboutPoint, apply, emptyRect, identity, invert, isEmptyRect, multiply, rotate, scale, translate, unionRect } from '../core/matrix';
import { elementBounds, elementsBounds } from '../core/geometry';
import {
  clearKeyframes, copyFrames, frameAt, insertFrames, insertKeyframe, layerLength, pasteFramesInto, removeFrames, resolveLayerFrame,
  reverseFrames, setTween, timelineFrameCount, convertToKeyframes, type FrameClip,
} from '../core/timeline';
import { applyCTFill, applyCTStroke, cloneElements, concatCT, defaultColorEffect, effectToTransform, isIdentityCT, uid, uniqueName, baseName } from '../core/util';
import { forEachElement, makeInstance } from '../core/store';
import { keyAllProps, clearKeysAt } from '../core/motion';
import { attachSound } from './audio';
import { placeVideo } from './video';
import { getSymbol, instanceFrame, layoutText } from '../core/symbols';
import { store, ui, setUI } from './state';
import { toast } from './dom';

const I: Matrix = identity();

// ---------------- clipboard ----------------
interface ElementClip { kind: 'elements'; elements: Element[]; library: LibraryItem[]; bounds: Rect; from: string }
let clip: ElementClip | null = null;
let frameClip: FrameClip | null = null;
export const CLIP_PREFIX = 'CELERITY_CLIP:';

function referencedItems(els: Element[]): LibraryItem[] {
  const names = new Set<string>();
  const visit = (list: Element[]) => {
    for (const e of list) {
      if (e.type === 'group') visit(e.children);
      else if ((e.type === 'symbol' || e.type === 'bitmap' || e.type === 'video') && !names.has(e.libraryItem)) {
        names.add(e.libraryItem);
        const it = store.lib.get(e.libraryItem);
        if (it?.kind === 'symbol') {
          for (const l of it.timeline.layers) for (const f of l.frames) visit(f.elements);
        }
      }
    }
  };
  visit(els);
  return store.doc.library.filter((i) => names.has(i.name)).map((i) => structuredClone(i));
}

export function copySelection(): string | null {
  const sel = store.selected();
  if (!sel.length) return null;
  const els = sel.map((s) => structuredClone(s.el));
  clip = { kind: 'elements', elements: els, library: referencedItems(els), bounds: elementsBounds(els, I, store.lib), from: store.fileName };
  try { return CLIP_PREFIX + JSON.stringify(clip); } catch { return null; }
}

export function cutSelection(): string | null {
  const text = copySelection();
  if (text) deleteSelection('Cut');
  return text;
}

export function deleteSelection(label = 'Delete') {
  if (!store.selection.length) return;
  store.transact(label, () => {
    for (const s of store.mutableSelection()) {
      const i = s.list.indexOf(s.el);
      if (i >= 0) s.list.splice(i, 1);
    }
  });
  store.select([]);
}

/** Pastes elements. `text` may come from the system clipboard. */
export function paste(inPlace: boolean, text?: string | null, center?: { x: number; y: number }) {
  let c = clip;
  if (text && text.startsWith(CLIP_PREFIX)) {
    try { c = JSON.parse(text.slice(CLIP_PREFIX.length)); } catch { /* use internal */ }
  } else if (text && text.trim() && !clip) {
    pasteText(text, center);
    return;
  }
  if (!c || !c.elements?.length) return;
  if (!store.canDraw()) return;
  const layer = store.layer()!;
  const els = cloneElements(c.elements);
  let dx = 0, dy = 0;
  if (!inPlace && center) {
    dx = center.x - (c.bounds.x + c.bounds.w / 2);
    dy = center.y - (c.bounds.y + c.bounds.h / 2);
  }
  for (const e of els) {
    e.matrix = { ...e.matrix, tx: e.matrix.tx + dx, ty: e.matrix.ty + dy };
    // raw shape pieces float above the layer until deselected
    if (e.type === 'shape' && e.planar) { e.lifted = true; e.floating = true; }
  }
  const ids = els.map((e) => e.id);
  store.transact('Paste', () => {
    for (const it of c!.library) {
      if (!store.lib.has(it.name)) store.addLibraryItem(structuredClone(it));
    }
    const list = store.editableElements(layer);
    list?.push(...els);
    // select inside the transaction so pasted raw pieces stay floating
    store.selection = [...ids];
    store.subSel.clear();
  });
  store.select(ids);
}

function pasteText(text: string, center?: { x: number; y: number }) {
  if (!store.canDraw()) return;
  const el: TextElement = {
    type: 'text', id: uid(), matrix: translate(center?.x ?? 0, center?.y ?? 0), text: text.slice(0, 20000), font: ui.textFont, size: ui.textSize,
    color: ui.fillColor, alpha: 1, bold: false, italic: false, align: 'left', width: 0, lineSpacing: 0, letterSpacing: 0,
  };
  const l = layoutText(el);
  el.matrix = translate((center?.x ?? 0) - l.width / 2, (center?.y ?? 0) - l.height / 2);
  store.addElement(el);
}

export function duplicateSelection() {
  const sel = store.selected();
  if (!sel.length) return;
  const ids: string[] = [];
  store.transact('Duplicate', () => {
    for (const s of store.mutableSelection()) {
      const c = cloneElements([s.el])[0];
      c.matrix = { ...c.matrix, tx: c.matrix.tx + 10, ty: c.matrix.ty + 10 };
      if (c.type === 'shape' && c.planar) { c.lifted = true; c.floating = true; }
      s.list.splice(s.list.indexOf(s.el) + 1, 0, c);
      ids.push(c.id);
    }
    store.selection = [...ids];
    store.subSel.clear();
  });
  store.select(ids);
}

export function selectAll() {
  store.select(store.selectable().map((s) => s.el.id));
}

// ---------------- transforms ----------------
export function transformSelection(label: string, fn: (m: Matrix, center: { x: number; y: number }) => Matrix) {
  const sel = store.selected();
  if (!sel.length) return;
  const b = elementsBounds(sel.map((s) => s.el), I, store.lib);
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  store.transact(label, () => {
    for (const s of store.mutableSelection()) s.el.matrix = fn(s.el.matrix, center);
  });
}

export const flipH = () => transformSelection('Flip Horizontal', (m, c) => multiply(aboutPoint(scale(-1, 1), c.x, c.y), m));
export const flipV = () => transformSelection('Flip Vertical', (m, c) => multiply(aboutPoint(scale(1, -1), c.x, c.y), m));
export const rotate90 = (cw: boolean) => transformSelection(cw ? 'Rotate 90° CW' : 'Rotate 90° CCW', (m, c) => multiply(aboutPoint(rotate(cw ? Math.PI / 2 : -Math.PI / 2), c.x, c.y), m));
export const removeTransform = () => transformSelection('Remove Transform', (m) => ({ a: 1, b: 0, c: 0, d: 1, tx: m.tx, ty: m.ty }));
export function nudge(dx: number, dy: number) {
  if (!store.selection.length) return;
  transformSelection('Nudge', (m) => ({ ...m, tx: m.tx + dx, ty: m.ty + dy }));
}

// ---------------- arrange ----------------
export function arrange(mode: 'front' | 'forward' | 'backward' | 'back') {
  if (!store.selection.length) return;
  store.transact('Arrange', () => {
    const groups = new Map<Element[], Element[]>();
    for (const s of store.mutableSelection()) {
      const arr = groups.get(s.list) ?? [];
      arr.push(s.el);
      groups.set(s.list, arr);
    }
    for (const [list, els] of groups) {
      const set = new Set(els);
      if (mode === 'front') {
        const rest = list.filter((e) => !set.has(e));
        list.splice(0, list.length, ...rest, ...list.filter((e) => set.has(e)));
      } else if (mode === 'back') {
        const rest = list.filter((e) => !set.has(e));
        list.splice(0, list.length, ...list.filter((e) => set.has(e)), ...rest);
      } else if (mode === 'forward') {
        for (let i = list.length - 2; i >= 0; i--) {
          if (set.has(list[i]) && !set.has(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
        }
      } else {
        for (let i = 1; i < list.length; i++) {
          if (set.has(list[i]) && !set.has(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
        }
      }
    }
  });
}

// ---------------- align ----------------
export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' | 'distH' | 'distV' | 'matchW' | 'matchH' | 'matchWH' | 'spaceH' | 'spaceV';

export function align(mode: AlignMode, toStage: boolean) {
  const sel = store.selected();
  if (!sel.length) return;
  const boxes = sel.map((s) => ({ id: s.el.id, r: elementBounds(s.el, I, store.lib) })).filter((b) => !isEmptyRect(b.r));
  if (!boxes.length) return;
  let target: Rect;
  if (toStage) {
    // stage rect expressed in edit space
    const toStageM = multiply(store.contextMatrix(), store.groupMatrix());
    const inv = invert(toStageM);
    const p0 = apply(inv, 0, 0), p1 = apply(inv, store.doc.width, store.doc.height);
    target = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) };
  } else {
    target = boxes.reduce((acc, b) => unionRect(acc, b.r), emptyRect());
  }
  const moves = new Map<string, Matrix>();
  const byId = new Map(boxes.map((b) => [b.id, b.r]));
  const shift = (id: string, dx: number, dy: number) => moves.set(id, translate(dx, dy));
  switch (mode) {
    case 'left': for (const b of boxes) shift(b.id, target.x - b.r.x, 0); break;
    case 'hcenter': for (const b of boxes) shift(b.id, target.x + target.w / 2 - (b.r.x + b.r.w / 2), 0); break;
    case 'right': for (const b of boxes) shift(b.id, target.x + target.w - (b.r.x + b.r.w), 0); break;
    case 'top': for (const b of boxes) shift(b.id, 0, target.y - b.r.y); break;
    case 'vcenter': for (const b of boxes) shift(b.id, 0, target.y + target.h / 2 - (b.r.y + b.r.h / 2)); break;
    case 'bottom': for (const b of boxes) shift(b.id, 0, target.y + target.h - (b.r.y + b.r.h)); break;
    case 'distH':
    case 'distV': {
      const horiz = mode === 'distH';
      const sorted = [...boxes].sort((a, b) => (horiz ? a.r.x + a.r.w / 2 - (b.r.x + b.r.w / 2) : a.r.y + a.r.h / 2 - (b.r.y + b.r.h / 2)));
      if (sorted.length < 2 && !toStage) return;
      const c = (r: Rect) => (horiz ? r.x + r.w / 2 : r.y + r.h / 2);
      const first = toStage ? (horiz ? target.x + sorted[0].r.w / 2 : target.y + sorted[0].r.h / 2) : c(sorted[0].r);
      const lastR = sorted[sorted.length - 1].r;
      const last = toStage ? (horiz ? target.x + target.w - lastR.w / 2 : target.y + target.h - lastR.h / 2) : c(lastR);
      sorted.forEach((b, i) => {
        const want = sorted.length === 1 ? (first + last) / 2 : first + ((last - first) * i) / (sorted.length - 1);
        if (horiz) shift(b.id, want - c(b.r), 0); else shift(b.id, 0, want - c(b.r));
      });
      break;
    }
    case 'spaceH':
    case 'spaceV': {
      const horiz = mode === 'spaceH';
      const sorted = [...boxes].sort((a, b) => (horiz ? a.r.x - b.r.x : a.r.y - b.r.y));
      const total = sorted.reduce((s, b) => s + (horiz ? b.r.w : b.r.h), 0);
      const span = horiz ? target.w : target.h;
      const gap = sorted.length > 1 ? (span - total) / (sorted.length - 1) : 0;
      let pos = horiz ? target.x : target.y;
      for (const b of sorted) {
        if (horiz) shift(b.id, pos - b.r.x, 0); else shift(b.id, 0, pos - b.r.y);
        pos += (horiz ? b.r.w : b.r.h) + gap;
      }
      break;
    }
    case 'matchW':
    case 'matchH':
    case 'matchWH': {
      const w = toStage ? target.w : Math.max(...boxes.map((b) => b.r.w));
      const hh = toStage ? target.h : Math.max(...boxes.map((b) => b.r.h));
      for (const b of boxes) {
        const sx = mode !== 'matchH' && b.r.w > 0 ? w / b.r.w : 1;
        const sy = mode !== 'matchW' && b.r.h > 0 ? hh / b.r.h : 1;
        moves.set(b.id, aboutPoint(scale(sx, sy), b.r.x, b.r.y));
      }
      break;
    }
  }
  void byId;
  store.transact('Align', () => {
    for (const s of store.mutableSelection()) {
      const t = moves.get(s.el.id);
      if (t) s.el.matrix = multiply(t, s.el.matrix);
    }
  });
}

// ---------------- group / break apart ----------------
export function groupSelection() {
  const sel = store.selected();
  if (!sel.length) return;
  const layerId = sel[sel.length - 1].layer.id;
  let gid = '';
  store.transact('Group', () => {
    const ms = store.mutableSelection();
    const target = ms.find((s) => s.layer.id === layerId) ?? ms[ms.length - 1];
    const idx = target.list.indexOf(target.el);
    // lifted raw-shape parts become the group's own raw shape
    const children = ms.map((s) => (s.el.type === 'shape' && s.el.lifted ? { ...s.el, lifted: undefined, floating: undefined, id: uid() } : s.el));
    const g: Element = { type: 'group', id: uid(), matrix: identity(), children };
    gid = g.id;
    let insertAt = idx;
    for (const s of ms) {
      const i = s.list.indexOf(s.el);
      if (i >= 0) { s.list.splice(i, 1); if (s.list === target.list && i < idx) insertAt--; }
    }
    target.list.splice(Math.max(0, insertAt), 0, g);
  });
  store.select([gid]);
}

function bakeColor(el: Element, ct: ReturnType<typeof effectToTransform>): Element {
  if (isIdentityCT(ct)) return el;
  switch (el.type) {
    case 'shape': return { ...el, paths: el.paths.map((p) => ({ ...p, fill: p.fill ? applyCTFill(p.fill, ct) : null, stroke: p.stroke ? applyCTStroke(p.stroke, ct) : null })) };
    case 'group': return { ...el, children: el.children.map((c) => bakeColor(c, ct)) };
    case 'symbol': return { ...el, color: { ...defaultColorEffect(), mode: 'advanced', advanced: concatCT(ct, effectToTransform(el.color)) } };
    case 'text': {
      const [c, a] = [el.color, el.alpha * ct.am];
      return { ...el, color: c, alpha: a };
    }
    default: return el;
  }
}

/** Ctrl+B: groups -> children, symbols -> contents, text -> letters. */
export function breakApart() {
  const sel = store.selected();
  if (!sel.length) return;
  const newIds: string[] = [];
  let warned = false;
  store.transact('Break Apart', () => {
    for (const s of store.mutableSelection()) {
      const el = s.el;
      const idx = s.list.indexOf(el);
      let parts: Element[] | null = null;
      if (el.type === 'group') {
        parts = el.children.map((c) => ({ ...c, matrix: multiply(el.matrix, c.matrix) }));
      } else if (el.type === 'symbol') {
        const sym = getSymbol(store.lib, el.libraryItem);
        if (!sym) continue;
        const f = instanceFrame(el, sym, { offset: 0, elapsed: 0, spanAll: true, playback: false });
        const ct = effectToTransform(el.color);
        const out: Element[] = [];
        for (let i = sym.timeline.layers.length - 1; i >= 0; i--) {
          const l = sym.timeline.layers[i];
          if (l.type === 'guide' || l.type === 'folder') continue;
          const r = resolveLayerFrame(l, f);
          if (!r) continue;
          for (const c of cloneElements(r.elements)) out.push(bakeColor({ ...c, matrix: multiply(el.matrix, c.matrix) }, ct));
        }
        parts = out;
      } else if (el.type === 'text') {
        const lay = layoutText(el);
        if (el.text.length <= 1) continue;
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = lay.font;
        const letters: Element[] = [];
        lay.lines.forEach((line) => {
          let x = line.x;
          for (const ch of line.text) {
            const w = ctx.measureText(ch).width + (el.letterSpacing || 0);
            if (ch.trim()) {
              letters.push({ ...el, id: uid(), text: ch, width: 0, align: 'left', matrix: multiply(el.matrix, translate(x - 2, line.y - 2)) } as TextElement);
            }
            x += w;
          }
        });
        parts = letters;
      } else if (el.type === 'shape' && !el.planar) {
        // drawing object -> raw (merge) shape
        const paths = el.paths.map((p) => ({ ...p, d: transformPath(p.d, el.matrix), fill: p.fill && p.fill.kind !== 'solid' ? { ...p.fill, matrix: multiply(el.matrix, p.fill.matrix) } : p.fill }));
        const planar = planarFromPaths(paths);
        parts = [{ type: 'shape', id: uid(), matrix: identity(), planar, paths: planarToPaths(planar) }];
      } else {
        if (!warned && el.type === 'bitmap') { store.flash('Bitmaps cannot be broken apart.'); warned = true; }
        continue;
      }
      if (!parts) continue;
      s.list.splice(idx, 1, ...parts);
      newIds.push(...parts.map((p) => p.id));
    }
  });
  store.select(newIds);
}

export function ungroup() {
  const sel = store.selected();
  if (!sel.some((s) => s.el.type === 'group')) { breakApart(); return; }
  const newIds: string[] = [];
  store.transact('Ungroup', () => {
    for (const s of store.mutableSelection()) {
      if (s.el.type !== 'group') { newIds.push(s.el.id); continue; }
      const g = s.el;
      const parts = g.children.map((c) => ({ ...c, matrix: multiply(g.matrix, c.matrix) }));
      s.list.splice(s.list.indexOf(g), 1, ...parts);
      newIds.push(...parts.map((p) => p.id));
    }
  });
  store.select(newIds);
}

/** Combines selected drawing objects into one shape (Modify > Combine Objects > Union). */
export function unionShapes() {
  const sel = store.selected().filter((s) => s.el.type === 'shape');
  if (sel.length < 2) return;
  let id = '';
  store.transact('Union', () => {
    const ms = store.mutableSelection().filter((s) => s.el.type === 'shape');
    const first = ms[0];
    const paths = ms.flatMap((s) => (s.el as ShapeElement).paths.map((p) => ({ ...p, d: transformPathM(p.d, s.el.matrix) })));
    const shape: ShapeElement = { type: 'shape', id: uid(), matrix: identity(), paths };
    id = shape.id;
    const idx = first.list.indexOf(first.el);
    for (const s of ms) { const i = s.list.indexOf(s.el); if (i >= 0) s.list.splice(i, 1); }
    first.list.splice(Math.min(idx, first.list.length), 0, shape);
  });
  store.select([id]);
}

import { transformPath } from '../core/path';
import { planarFromPaths, planarToPaths } from '../core/planar';
function transformPathM(d: number[], m: Matrix) { return transformPath(d, m); }

// ---------------- symbols ----------------
export function convertSelectionToSymbol(name: string, type: SymbolType, reg: { x: number; y: number }) {
  if (!store.selection.length) {
    toast('Select something on the stage first.', 'error');
    return;
  }
  store.createSymbolFromSelection(name, type, reg);
}

export function nextSymbolName(base = 'Symbol'): string {
  return uniqueName(store.libraryNames(), `${base} 1`);
}

export function createEmptySymbol(name: string, type: SymbolType): string {
  const finalName = uniqueName(store.libraryNames(), name);
  store.transact('New Symbol', () => {
    store.addLibraryItem({
      kind: 'symbol', name: finalName, symbolType: type, itemID: `${Date.now().toString(16)}-${Math.floor(Math.random() * 1e8).toString(16)}`,
      timeline: { name: baseName(finalName), layers: [{ id: uid(), name: 'Layer_1', type: 'normal', parentId: null, visible: true, locked: false, outline: false, color: '#4F80FF', frames: [{ start: 0, duration: 1, elements: [], tween: 'none', ease: 0, rotate: 'auto', rotateTimes: 0, label: '', labelType: 'name', script: '' }] }] },
    });
  });
  return finalName;
}

export function placeLibraryItem(name: string, x: number, y: number) {
  const it = store.lib.get(name);
  if (!it || it.kind === 'folder') return;
  if (!store.canDraw()) return;
  if (store.stack.some((e) => e.symbol === name)) { toast('A symbol cannot be placed inside itself.', 'error'); return; }
  let el: Element;
  if (it.kind === 'symbol') {
    const inst = makeInstance(name, it.symbolType, translate(x, y));
    const b = elementBounds({ ...inst, matrix: I }, I, store.lib);
    if (!isEmptyRect(b)) {
      inst.matrix = translate(x - (b.x + b.w / 2), y - (b.y + b.h / 2));
      inst.transformPoint = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    el = inst;
  } else if (it.kind === 'sound') {
    attachSound(name);
    return;
  } else if (it.kind === 'video') {
    placeVideo(name, x, y);
    return;
  } else {
    el = { type: 'bitmap', id: uid(), matrix: translate(Math.round(x - it.width / 2), Math.round(y - it.height / 2)), libraryItem: name };
  }
  store.addElement(el);
}

export function swapSymbol(instanceId: string, newName: string) {
  store.transact('Swap Symbol', () => {
    const s = store.mutableSelection().find((x) => x.el.id === instanceId);
    if (s && s.el.type === 'symbol') {
      const it = store.lib.get(newName);
      if (it?.kind === 'symbol') { s.el.libraryItem = newName; }
    }
  });
}

export function symbolUsage(name: string): number {
  let n = 0;
  forEachElement(store.doc, (e) => { if ((e.type === 'symbol' || e.type === 'bitmap' || e.type === 'video') && e.libraryItem === name) n++; });
  return n;
}

// ---------------- timeline ops ----------------
function frameTargets(): { layers: Layer[]; f0: number; f1: number } {
  const tl = store.timeline();
  const fs = store.frameSel;
  if (fs) {
    const layers = tl.layers.filter((l) => fs.layerIds.includes(l.id) && l.type !== 'folder');
    if (layers.length) return { layers, f0: Math.min(fs.f0, fs.f1), f1: Math.max(fs.f0, fs.f1) };
  }
  const l = store.layer();
  return { layers: l && l.type !== 'folder' ? [l] : [], f0: store.frame, f1: store.frame };
}

export function insertFrame() {
  const { layers, f0, f1 } = frameTargets();
  if (!layers.length) return;
  store.transact('Insert Frame', () => {
    const count = f1 - f0 + 1;
    for (const l of layers) {
      if (f0 >= layerLength(l)) insertFrames(l, f1);
      else insertFrames(l, f0, count);
    }
  });
  store.emit('timeline');
}

export function removeFramesCmd() {
  const { layers, f0, f1 } = frameTargets();
  if (!layers.length) return;
  store.transact('Remove Frames', () => { for (const l of layers) removeFrames(l, f0, f1); });
}

export function insertKeyframeCmd(blank: boolean) {
  const { layers, f0, f1 } = frameTargets();
  if (!layers.length) return;
  const first = layers[0];
  const wasKey = f1 === f0 && !!first && f0 < layerLength(first) && frameAt(first, f0)?.start === f0;
  // F6 inside a motion tween adds property keyframes instead of splitting the span
  if (!blank && f1 === f0) {
    const fr = layers.length === 1 ? frameAt(layers[0], f0) : null;
    if (fr && fr.tween === 'motion' && fr.motion && f0 > fr.start) {
      store.transact('Insert Keyframe', () => keyAllProps(fr, f0 - fr.start));
      store.emit('timeline');
      return;
    }
  }
  store.transact(blank ? 'Insert Blank Keyframe' : 'Insert Keyframe', () => {
    for (const l of layers) {
      if (f1 > f0) convertToKeyframes(l, f0, f1, blank);
      else {
        const fr = frameAt(l, f0);
        if (fr && fr.start === f0 && f0 < layerLength(l)) {
          // already a keyframe: like Animate, insert on the next frame instead
          insertKeyframe(l, f0 + 1, blank);
        } else insertKeyframe(l, f0, blank);
      }
    }
  });
  if (wasKey) store.setFrame(f0 + 1);
}

export function clearKeyframeCmd() {
  const { layers, f0, f1 } = frameTargets();
  if (!layers.length) return;
  const fr = layers.length === 1 && f0 === f1 ? frameAt(layers[0], f0) : null;
  if (fr && fr.tween === 'motion' && fr.motion && f0 > fr.start) {
    store.transact('Clear Keyframe', () => { clearKeysAt(fr, f0 - fr.start); });
    return;
  }
  store.transact('Clear Keyframe', () => { for (const l of layers) clearKeyframes(l, f0, f1); });
}

/** Animate converts non-symbol tween content into a symbol (classic: "Tween N" graphic; motion: "Symbol N" movie clip). */
function spanToSymbol(fr: Frame, base: string, type: SymbolType) {
  if (!fr.elements.length) return;
  if (fr.elements.length === 1 && fr.elements[0].type === 'symbol') return;
  if (base.startsWith('Tween') && fr.elements.every((e) => e.type === 'symbol')) return;
  if (fr.elements.length === 1 && fr.elements[0].type !== 'symbol' && fr.elements[0].type !== 'shape' && fr.elements[0].type !== 'group' && base.startsWith('Tween')) return;
  const name = uniqueName(store.libraryNames(), `${base} 1`);
  const b = elementsBounds(fr.elements, I, store.lib);
  const ox = isEmptyRect(b) ? 0 : b.x, oy = isEmptyRect(b) ? 0 : b.y;
  const els = fr.elements.map((e) => {
    const c = { ...e, matrix: multiply(translate(-ox, -oy), e.matrix) };
    if (c.type === 'shape') { delete c.lifted; delete c.floating; }
    return c;
  });
  const sym = {
    kind: 'symbol' as const, name, symbolType: type, itemID: `${Date.now().toString(16)}-${Math.floor(Math.random() * 1e8).toString(16)}`,
    timeline: { name, layers: [{ id: uid(), name: 'Layer_1', type: 'normal' as const, parentId: null, visible: true, locked: false, outline: false, color: '#4F80FF', frames: [{ start: 0, duration: 1, elements: els, tween: 'none' as const, ease: 0, rotate: 'auto' as const, rotateTimes: 0, label: '', labelType: 'name' as const, script: '' }] }] },
  };
  store.addLibraryItem(sym);
  const inst: SymbolInstance = makeInstance(name, type, translate(ox, oy));
  if (!isEmptyRect(b)) inst.transformPoint = { x: b.w / 2, y: b.h / 2 };
  fr.elements = [inst];
}

export function createTween(kind: Frame['tween']) {
  const { layers, f0, f1 } = frameTargets();
  if (!layers.length) return;
  const label = kind === 'classic' ? 'Create Classic Tween' : kind === 'shape' ? 'Create Shape Tween' : kind === 'motion' ? 'Create Motion Tween' : 'Remove Tween';
  let empty = false;
  store.transact(label, () => {
    for (const l of layers) {
      if (kind === 'classic') {
        const spans = new Set<Frame>();
        for (let f = f0; f <= f1; f++) {
          const fr = frameAt(l, f);
          if (fr) { spans.add(fr); const i = l.frames.indexOf(fr); if (l.frames[i + 1]) spans.add(l.frames[i + 1]); }
        }
        for (const fr of spans) spanToSymbol(fr, 'Tween', 'graphic');
      } else if (kind === 'motion') {
        const fr = frameAt(l, f0);
        if (!fr || !fr.elements.length) { empty = true; continue; }
        spanToSymbol(fr, 'Symbol', 'movieclip');
        // a one-frame span grows to one second, like Animate
        if (fr.duration === 1) insertFrames(l, fr.start, Math.max(1, Math.round(store.doc.fps) - 1));
        setTween(l, fr.start, fr.start, 'motion');
        continue;
      }
      setTween(l, f0, f1, kind);
    }
  });
  if (empty) store.flash('Select a frame with an object to create a motion tween.');
}

export function setFrameProps(fn: (f: Frame) => void, label = 'Frame Properties') {
  const { layers, f0, f1 } = frameTargets();
  store.transact(label, () => {
    const seen = new Set<Frame>();
    for (const l of layers) for (let f = f0; f <= f1; f++) {
      const fr = frameAt(l, f);
      if (fr && !seen.has(fr)) { seen.add(fr); fn(fr); }
    }
  });
}

export function copyFramesCmd(cut = false) {
  const { layers, f0, f1 } = frameTargets();
  if (!layers.length) return;
  frameClip = copyFrames(layers, f0, f1);
  if (cut) store.transact('Cut Frames', () => { for (const l of layers) clearRange(l, f0, f1); });
  toast(`${cut ? 'Cut' : 'Copied'} ${f1 - f0 + 1} frame(s) on ${layers.length} layer(s).`, 'ok', 1500);
}

function clearRange(l: Layer, f0: number, f1: number) {
  // replace the range with a blank keyframe span (Animate "Cut Frames")
  const len = layerLength(l);
  if (f0 >= len) return;
  insertKeyframe(l, f0, true);
  if (f1 + 1 < len) insertKeyframe(l, f1 + 1, false);
  const fr = frameAt(l, f0);
  if (fr) fr.elements = [];
}

export function pasteFramesCmd(insert = false) {
  if (!frameClip) { toast('No frames on the clipboard.', 'error'); return; }
  const tl = store.timeline();
  const cur = store.layer();
  if (!cur) return;
  const startIdx = tl.layers.indexOf(cur);
  const f = store.frameSel ? Math.min(store.frameSel.f0, store.frameSel.f1) : store.frame;
  store.transact('Paste Frames', () => {
    frameClip!.layers.forEach((cl, i) => {
      let layer = tl.layers.filter((l) => l.type !== 'folder')[tl.layers.filter((l) => l.type !== 'folder').indexOf(cur) + i];
      if (!layer) {
        layer = { ...structuredClone(cur), id: uid(), name: `Layer_${tl.layers.length + 1}`, frames: [{ start: 0, duration: 1, elements: [], tween: 'none', ease: 0, rotate: 'auto', rotateTimes: 0, label: '', labelType: 'name', script: '' }] };
        tl.layers.splice(startIdx + i, 0, layer);
      }
      pasteFramesInto(layer, f, cl, insert);
    });
  });
}

export function reverseFramesCmd() {
  const { layers, f0, f1 } = frameTargets();
  if (f1 <= f0) { toast('Select a range of frames to reverse.', 'error'); return; }
  store.transact('Reverse Frames', () => { for (const l of layers) reverseFrames(l, f0, f1); });
}

export function selectAllFrames() {
  const tl = store.timeline();
  store.frameSel = { layerIds: tl.layers.map((l) => l.id), f0: 0, f1: timelineFrameCount(tl) - 1 };
  store.emit('frame');
}

export function convertLayerType(type: Layer['type']) {
  const l = store.layer();
  if (!l) return;
  const tl = store.timeline();
  store.transact('Layer Type', () => {
    const prevType = l.type;
    l.type = l.type === type ? 'normal' : type;
    if (l.type === 'mask') {
      // the layer below becomes masked; like Animate both get locked so the mask shows
      const idx = tl.layers.indexOf(l);
      const below = tl.layers[idx + 1];
      if (below && below.type === 'normal' && !below.parentId) { below.parentId = l.id; below.locked = true; }
      l.locked = true;
    } else if (prevType === 'mask') {
      for (const c of tl.layers) if (c.parentId === l.id) c.parentId = null;
    }
  });
}

/** Modify > Timeline > Distribute to Layers (Ctrl+Shift+D). */
export function distributeToLayers() {
  if (store.ctx.groupPath.length) { toast('Exit the group before distributing to layers.', 'error'); return; }
  const sel = store.selected();
  if (!sel.length) return;
  const tl = store.timeline();
  const f = store.frame;
  const newIds: string[] = [];
  store.transact('Distribute to Layers', () => {
    const ms = store.mutableSelection();
    const names = new Set(tl.layers.map((l) => l.name));
    for (const s of ms) {
      const src = s.layer;
      const span = frameAt(src, f);
      const end = span ? span.start + span.duration : f + 1;
      const el = s.el;
      s.list.splice(s.list.indexOf(el), 1);
      const base = el.type === 'symbol' ? (el.name || baseName(el.libraryItem)) : el.type === 'bitmap' ? baseName(el.libraryItem) : 'Layer';
      const name = uniqueName(names, base);
      names.add(name);
      const frames: Frame[] = [];
      const mk = (start: number, duration: number, elements: Element[]): Frame => ({ start, duration, elements, tween: 'none', ease: 0, rotate: 'auto', rotateTimes: 0, label: '', labelType: 'name', script: '' });
      if (f > 0) frames.push(mk(0, f, []));
      frames.push(mk(f, Math.max(1, end - f), [el]));
      const layer: Layer = { id: uid(), name, type: 'normal', parentId: src.parentId, visible: true, locked: false, outline: false, color: src.color, frames };
      tl.layers.splice(tl.layers.indexOf(src), 0, layer);
      newIds.push(el.id);
    }
  });
  store.select(newIds);
}

export function setStatus(msg: string) { store.flash(msg); }

export { setUI, ui, emptyRect };
