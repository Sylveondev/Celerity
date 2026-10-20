import { planarFromPaths, planarToPaths } from './planar';
import { motionTween, newMotion, splitMotion } from './motion';
import type { Element, Frame, Layer, Timeline } from './types';
import { cloneElements, emptyFrame } from './util';
import { classicTween, classicTweenValid, shapeTween, shapeTweenValid } from './tween';

export function layerLength(layer: Layer): number {
  const f = layer.frames[layer.frames.length - 1];
  return f ? f.start + f.duration : 0;
}

/** Index into layer.frames of the frame span containing `f`, or -1. */
export function frameIndexAt(layer: Layer, f: number): number {
  const frames = layer.frames;
  let lo = 0, hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const fr = frames[mid];
    if (f < fr.start) hi = mid - 1;
    else if (f >= fr.start + fr.duration) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function frameAt(layer: Layer, f: number): Frame | null {
  const i = frameIndexAt(layer, f);
  return i >= 0 ? layer.frames[i] : null;
}

export function isKeyframe(layer: Layer, f: number): boolean {
  const fr = frameAt(layer, f);
  return !!fr && fr.start === f;
}

export interface ResolvedFrame {
  frame: Frame;            // the keyframe span
  next: Frame | undefined; // next keyframe
  offset: number;          // frames since keyframe start
  elements: Element[];     // what is displayed (may be interpolated, do not mutate)
  tweened: boolean;        // true when elements are interpolated copies
}

/** Resolves what a layer displays at frame f (with tween interpolation). */
export function resolveLayerFrame(layer: Layer, f: number): ResolvedFrame | null {
  const i = frameIndexAt(layer, f);
  if (i < 0) return null;
  const frame = layer.frames[i];
  const next = layer.frames[i + 1];
  const offset = f - frame.start;
  if (frame.tween === 'motion' && frame.motion && frame.elements.length) {
    // object-based tweens animate on their own (no end keyframe needed); every frame is "tweened"
    return { frame, next, offset, elements: motionTween(frame, offset), tweened: true };
  }
  if (offset === 0 || frame.tween === 'none' || !next) {
    return { frame, next, offset, elements: frame.elements, tweened: false };
  }
  const t = offset / frame.duration;
  if (frame.tween === 'classic' && classicTweenValid(frame, next)) {
    return { frame, next, offset, elements: classicTween(frame, next, t), tweened: true };
  }
  if (frame.tween === 'shape' && shapeTweenValid(frame, next)) {
    return { frame, next, offset, elements: shapeTween(frame, next, t, layer.id + ':tw'), tweened: true };
  }
  return { frame, next, offset, elements: frame.elements, tweened: false };
}

// ---------------------------------------------------------------------------
// Frame editing. Operations expand the layer into a per-frame array of frame
// references, edit that, then compact it back to keyframe spans. This keeps
// every operation simple and makes edge cases (splits, merges) consistent.
// ---------------------------------------------------------------------------

type Cells = (Frame | null)[];

function expand(layer: Layer): Cells {
  const cells: Cells = [];
  for (const fr of layer.frames) for (let k = 0; k < fr.duration; k++) cells.push(fr);
  return cells;
}

function compact(layer: Layer, cells: Cells) {
  // trim trailing empties
  let end = cells.length;
  while (end > 0 && cells[end - 1] === null) end--;
  const frames: Frame[] = [];
  const used = new Set<Frame>();
  let i = 0;
  while (i < end) {
    let fr = cells[i];
    if (fr === null) {
      // fill gaps with blank keyframes
      let j = i;
      while (j < end && cells[j] === null) j++;
      frames.push(emptyFrame(i, j - i));
      i = j;
      continue;
    }
    let j = i;
    while (j < end && cells[j] === fr) j++;
    if (used.has(fr)) {
      fr = { ...fr, elements: cloneElements(fr.elements) };
    }
    used.add(fr);
    fr.start = i;
    fr.duration = j - i;
    frames.push(fr);
    i = j;
  }
  if (frames.length === 0) frames.push(emptyFrame(0, 1));
  layer.frames = frames;
}

/** Inserts `count` frames at f (F5). Extends the layer if f is past its end. */
export function insertFrames(layer: Layer, f: number, count = 1) {
  const cells = expand(layer);
  if (f >= cells.length) {
    const last = cells[cells.length - 1] ?? null;
    while (cells.length <= f) cells.push(last);
    compact(layer, cells);
    return;
  }
  const fr = cells[f];
  cells.splice(f, 0, ...new Array(count).fill(fr));
  compact(layer, cells);
}

/** Extends the layer so it contains frame f (without inserting in the middle). */
export function extendTo(layer: Layer, f: number) {
  if (layerLength(layer) > f) return;
  insertFrames(layer, f);
}

/** F6 / F7. Returns the new keyframe. */
export function insertKeyframe(layer: Layer, f: number, blank: boolean): Frame {
  const cells = expand(layer);
  const existing = cells[f];
  if (existing && existing.start === f && f < cells.length) return existing;
  // Keyframe copies keep element ids: they represent the same objects over time.
  let content: Element[] = [];
  if (!blank) {
    if (f < cells.length) {
      const resolved = resolveLayerFrame(layer, f);
      content = resolved ? structuredClone(resolved.elements) : [];
      // in-betweens of raw-shape tweens become editable raw shapes again
      content = content.map((e) => {
        if (e.type !== 'shape' || !e.fromRaw) return e;
        const planar = planarFromPaths(e.paths);
        return { type: 'shape', id: e.id, matrix: e.matrix, planar, paths: planarToPaths(planar) };
      });
    } else {
      const last = cells[cells.length - 1];
      content = last ? structuredClone(last.elements) : [];
    }
  }
  const prev = f < cells.length ? cells[f] : cells[cells.length - 1] ?? null;
  const nf = emptyFrame(f, 1);
  nf.elements = content;
  if (prev && !blank && f < cells.length) {
    // the new keyframe continues the tween settings of the span it split
    nf.tween = prev.tween; nf.ease = prev.ease; nf.rotate = prev.rotate; nf.rotateTimes = prev.rotateTimes;
    if (prev.tween === 'motion' && prev.motion) {
      const at = f - prev.start;
      nf.motion = splitMotion(prev.motion, at);
      // the stored object is the state at the split, with its colour as authored
      if (nf.elements[0] && prev.elements[0] && nf.elements[0].type === 'symbol' && prev.elements[0].type === 'symbol') nf.elements[0] = { ...nf.elements[0], matrix: nf.elements[0].matrix, color: prev.elements[0].color };
    } else if (prev.tween === 'motion') nf.tween = 'none';
  }
  if (f >= cells.length) {
    const last = cells[cells.length - 1] ?? null;
    while (cells.length < f) cells.push(last);
    cells.push(nf);
  } else {
    const old = cells[f];
    for (let i = f; i < cells.length && cells[i] === old; i++) cells[i] = nf;
  }
  compact(layer, cells);
  return nf;
}

/** Shift+F5: removes frames [f0, f1]. */
export function removeFrames(layer: Layer, f0: number, f1: number) {
  const cells = expand(layer);
  if (f0 >= cells.length) return;
  cells.splice(f0, Math.min(f1, cells.length - 1) - f0 + 1);
  compact(layer, cells);
}

/** Shift+F6: clears keyframes in range; spans merge into the previous keyframe. */
export function clearKeyframes(layer: Layer, f0: number, f1: number) {
  const cells = expand(layer);
  for (let f = f0; f <= f1 && f < cells.length; f++) {
    const fr = cells[f];
    if (!fr || fr.start !== f) continue;
    const prev = f > 0 ? cells[f - 1] : null;
    if (prev) {
      for (let i = f; i < cells.length && cells[i] === fr; i++) cells[i] = prev;
    } else {
      fr.elements = [];
      fr.tween = 'none';
    }
  }
  compact(layer, cells);
}

export function convertToKeyframes(layer: Layer, f0: number, f1: number, blank = false) {
  for (let f = f0; f <= f1; f++) insertKeyframe(layer, f, blank);
}

export function setTween(layer: Layer, f0: number, f1: number, tween: Frame['tween']) {
  const seen = new Set<Frame>();
  for (let f = f0; f <= f1; f++) {
    const fr = frameAt(layer, f);
    if (fr && !seen.has(fr)) {
      seen.add(fr);
      fr.tween = tween;
      if (tween === 'motion') fr.motion ??= newMotion();
      else delete fr.motion;
    }
  }
}

export interface FrameClip {
  layers: { cells: { frame: Frame; offset: number }[] }[]; // per layer, per frame
  length: number;
}

/** Copies frames [f0..f1] of the given layers. */
export function copyFrames(layers: Layer[], f0: number, f1: number): FrameClip {
  const length = f1 - f0 + 1;
  return {
    length,
    layers: layers.map((layer) => {
      const cells = expand(layer);
      const out: { frame: Frame; offset: number }[] = [];
      for (let f = f0; f <= f1; f++) {
        const fr = cells[f];
        if (!fr) { out.push({ frame: emptyFrame(0, 1), offset: 0 }); continue; }
        out.push({ frame: structuredClone(fr), offset: f - fr.start });
      }
      return { cells: out };
    }),
  };
}

/** Pastes a clip into a layer at frame f, overwriting. */
export function pasteFramesInto(layer: Layer, f: number, clipLayer: FrameClip['layers'][number], insert = false) {
  const cells = expand(layer);
  while (cells.length < f) cells.push(cells[cells.length - 1] ?? null);
  const map = new Map<string, Frame>();
  const newCells: Frame[] = clipLayer.cells.map((c, i) => {
    // cells of the same source frame within the clip share one new frame object
    const key = JSON.stringify([c.frame.start, c.frame.duration, i - c.offset]);
    let nf = map.get(key);
    if (!nf) {
      nf = { ...structuredClone(c.frame), elements: cloneElements(c.frame.elements) };
      if (c.offset > 0) {
        // the clip begins in the middle of a span: show the frame as it looked
        nf.tween = 'none';
      }
      map.set(key, nf);
    }
    return nf;
  });
  if (insert) cells.splice(f, 0, ...newCells);
  else for (let i = 0; i < newCells.length; i++) cells[f + i] = newCells[i];
  compact(layer, cells);
}

export function reverseFrames(layer: Layer, f0: number, f1: number) {
  const cells = expand(layer);
  f1 = Math.min(f1, cells.length - 1);
  if (f1 <= f0) return;
  // reverse the keyframe order but keep each keyframe's content as its own span
  const segment = cells.slice(f0, f1 + 1).reverse();
  for (let i = 0; i < segment.length; i++) cells[f0 + i] = segment[i];
  compact(layer, cells);
}

/** Moves frames [f0..f1] of a layer by delta frames (drag in timeline). */
export function moveFrames(layer: Layer, f0: number, f1: number, delta: number) {
  if (delta === 0) return;
  const cells = expand(layer);
  f1 = Math.min(f1, cells.length - 1);
  if (f0 > f1) return;
  const seg = cells.slice(f0, f1 + 1);
  const isKeyStart = seg[0] && seg[0].start === f0;
  // vacate: the previous keyframe extends over the vacated cells when the
  // moved segment started on a keyframe, otherwise leave blank cells
  const fill: Frame | null = f0 > 0 ? cells[f0 - 1] : null;
  for (let i = f0; i <= f1; i++) cells[i] = isKeyStart ? fill : null;
  const dst = Math.max(0, f0 + delta);
  while (cells.length < dst + seg.length) cells.push(null);
  for (let i = 0; i < seg.length; i++) cells[dst + i] = seg[i];
  // like Animate, gaps left before the moved block are filled by extending the previous span
  if (isKeyStart) {
    for (let i = 1; i < dst; i++) if (cells[i] === null && cells[i - 1] !== null) cells[i] = cells[i - 1];
  }
  compact(layer, cells);
}

export function timelineFrameCount(tl: Timeline): number {
  let max = 1;
  for (const l of tl.layers) max = Math.max(max, layerLength(l));
  return max;
}

export function labelsOf(tl: Timeline): { frame: number; label: string }[] {
  const out: { frame: number; label: string }[] = [];
  for (const l of tl.layers) for (const f of l.frames) if (f.label && f.labelType === 'name') out.push({ frame: f.start, label: f.label });
  return out.sort((a, b) => a.frame - b.frame);
}
