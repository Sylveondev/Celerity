// Object-based ("new style", CS4+) motion tweens.
//
// A motion tween span holds one object (the element's matrix is its state at
// the start of the span) plus per-property curves, exactly like Animate's
// <motionObjectXML><AnimationCore>:
//   Motion_X / Motion_Y   offset of the transformation point from its start (px)
//   Rotation_Z            rotation (degrees, absolute)
//   Skew_X / Skew_Y       skew (degrees, absolute)
//   Scale_X / Scale_Y     scale (percent, absolute)
//   Alpha_Amount, Brightness_Amount, Tint_Amount + Tint_Color, AdvClr_*  colour effects
// Key times are stored in frames from the start of the span (the XFL file uses
// ticks; see xfl-read/xfl-write). Each key may carry Bézier handles in
// (time, value) space; handles on the anchors make a segment linear.
import type { ColorEffect, Element, Frame, Matrix, Point, SymbolInstance } from './types';
import { defaultColorEffect, effectToTransform, IDENTITY_CT } from './util';

export interface MotionKey {
  t: number;                    // frames from the span start
  v: number;                    // value (colour keys: unused)
  rgba?: number[];              // colour keys (Tint_Color)
  next?: [number, number];      // outgoing handle: [dt frames, value]
  prev?: [number, number];      // incoming handle: [dt frames (<=0), value]
}

export interface MotionProp {
  id: string;
  container: string;            // e.g. "Basic_Motion", "Colors/Alpha_Color", "Filters/Blur_Filter"
  keys: MotionKey[];
  timeMap?: number;             // TimeMapIndex
  ignoreTimeMap?: boolean;
  value?: string;               // constant-valued property (no keys)
  attrs?: Record<string, string>; // other attributes kept for round-trips
}

export interface MotionData {
  timeMaps: { type: string; strength: number }[];
  props: MotionProp[];
  orientToPath?: boolean;
}

export function newMotion(): MotionData {
  return { timeMaps: [{ type: 'Quadratic', strength: 0 }], props: [] };
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Easing (Motion Editor presets stored as <TimeMap type strength>)
// ---------------------------------------------------------------------------
const POWERS: Record<string, number> = { Quadratic: 2, Cubic: 3, Quartic: 4, Quintic: 5 };

export function timeMapEase(tm: { type: string; strength: number } | undefined, r: number): number {
  if (!tm || !tm.strength) return r;
  const a = Math.min(Math.abs(tm.strength) / 100, 1);
  const pw = POWERS[tm.type] ?? POWERS[tm.type.replace(/^Dual/, '')];
  if (pw) {
    let curve: number;
    if (tm.type.startsWith('Dual')) {
      const p = (x: number) => Math.pow(Math.abs(x), pw);
      curve = tm.strength > 0 ? (r < 0.5 ? 0.5 - p(2 * r - 1) / 2 : 0.5 + p(2 * r - 1) / 2) : (r < 0.5 ? p(2 * r) / 2 : 1 - p(2 * r - 2) / 2);
    } else curve = tm.strength > 0 ? 1 - Math.pow(1 - r, pw) : Math.pow(r, pw);
    return a * curve + (1 - a) * r;
  }
  switch (tm.type) {
    case 'SineWave': {
      const n = Math.max(0, Math.min(100, Math.trunc(tm.strength)));
      return n ? (1 + Math.sin(r * Math.PI * n - Math.PI / 2)) / 2 : r;
    }
    case 'Bounce':
    case 'BounceIn': {
      const n = Math.abs(Math.trunc(tm.strength));
      if (!n) return r;
      let h = 0;
      for (let i = 1; i <= n; i++) h += 1 / i;
      const t0 = 1 / h;
      const x = tm.strength > 0 ? r : 1 - r;
      let k = 0, start = 0, end = t0;
      while (end < x && k < n) { k++; start = end; end += t0 / (k + 1); }
      const u = (x - start) / (t0 / (k + 1));
      const v = tm.type === 'Bounce' ? 4 * Math.exp(-k) * u * (1 - u) : k === 0 ? u * u : 1 - 4 * Math.exp(-k) * u * (1 - u);
      return tm.strength > 0 || tm.type === 'Bounce' ? v : 1 - v;
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Curve evaluation
// ---------------------------------------------------------------------------
const cubic = (p0: number, p1: number, p2: number, p3: number, u: number) => {
  const v = 1 - u;
  return v * v * v * p0 + 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u * p3;
};

function segment(k0: MotionKey, k1: MotionKey, t: number): number {
  const t0 = k0.t, t1 = k1.t;
  if (t1 <= t0) return k1.v;
  const x1 = Math.min(Math.max(t0 + (k0.next?.[0] ?? 0), t0), t1);
  const x2 = Math.min(Math.max(t1 + (k1.prev?.[0] ?? 0), t0), t1);
  const y1 = k0.next?.[1] ?? k0.v, y2 = k1.prev?.[1] ?? k1.v;
  let lo = 0, hi = 1, u = (t - t0) / (t1 - t0);
  for (let i = 0; i < 40; i++) {
    const x = cubic(t0, x1, x2, t1, u);
    if (Math.abs(x - t) < 1e-7) break;
    if (x < t) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  return cubic(k0.v, y1, y2, k1.v, u);
}

/** Eased time inside the key range (handles the whole-curve time map). */
function easedTime(p: MotionProp, data: MotionData, t: number): number {
  const keys = p.keys;
  const first = keys[0].t, last = keys[keys.length - 1].t;
  if (t <= first || last <= first) return t;
  const r = Math.min((t - first) / (last - first), 1);
  const e = p.ignoreTimeMap ? r : timeMapEase(data.timeMaps[p.timeMap ?? 0], r);
  return first + (last - first) * e;
}

export function evalProp(p: MotionProp, data: MotionData, t: number): number {
  const keys = p.keys;
  if (!keys.length) return Number(p.value ?? 0);
  if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].v;
  const et = Math.min(Math.max(easedTime(p, data, t), keys[0].t), keys[keys.length - 1].t);
  for (let i = 0; i < keys.length - 1; i++) if (et <= keys[i + 1].t) return segment(keys[i], keys[i + 1], et);
  return keys[keys.length - 1].v;
}

function evalColor(p: MotionProp, data: MotionData, t: number): number[] {
  const keys = p.keys.filter((k) => k.rgba);
  if (!keys.length) return [255, 255, 255, 255];
  if (keys.length === 1 || t <= keys[0].t) return keys[0].rgba!;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].rgba!;
  const et = easedTime(p, data, t);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (et <= b.t) {
      const u = b.t > a.t ? (et - a.t) / (b.t - a.t) : 1;
      return a.rgba!.map((c, j) => c + (b.rgba![j] - c) * u);
    }
  }
  return keys[keys.length - 1].rgba!;
}

export function findProp(data: MotionData, id: string): MotionProp | undefined {
  return data.props.find((p) => p.id === id && (p.keys.length || p.value !== undefined));
}

// ---------------------------------------------------------------------------
// Applying a tween to its object
// ---------------------------------------------------------------------------
export interface BaseParts { rotation: number; skewX: number; skewY: number; scaleX: number; scaleY: number }

export function baseParts(m: Matrix): BaseParts {
  const rotation = Math.atan2(m.b, m.a) / DEG;
  return { rotation, skewX: Math.atan2(-m.c, m.d) / DEG - rotation, skewY: 0, scaleX: Math.hypot(m.a, m.b) * 100, scaleY: Math.hypot(m.c, m.d) * 100 };
}

export function pivotOf(el: Element): Point {
  return el.type === 'symbol' ? el.transformPoint : { x: 0, y: 0 };
}

export interface MotionValues extends BaseParts { x: number; y: number }

/** All animatable transform values of the tween at frame offset t. */
export function motionValues(data: MotionData, base: Matrix, t: number): MotionValues {
  const b = baseParts(base);
  const v = (id: string, d: number) => { const p = findProp(data, id); return p ? evalProp(p, data, t) : d; };
  return {
    x: v('Motion_X', 0), y: v('Motion_Y', 0),
    rotation: v('Rotation_Z', b.rotation), skewX: v('Skew_X', b.skewX), skewY: v('Skew_Y', b.skewY),
    scaleX: v('Scale_X', b.scaleX), scaleY: v('Scale_Y', b.scaleY),
  };
}

export function composeMotion(vals: MotionValues, base: Matrix, tp: Point): Matrix {
  const kx = (vals.rotation + vals.skewX) * DEG, ky = (vals.rotation + vals.skewY) * DEG;
  const sx = vals.scaleX / 100, sy = vals.scaleY / 100;
  const a = sx * Math.cos(ky), b = sx * Math.sin(ky), c = -sy * Math.sin(kx), d = sy * Math.cos(kx);
  const px = base.a * tp.x + base.c * tp.y + base.tx + vals.x;
  const py = base.b * tp.x + base.d * tp.y + base.ty + vals.y;
  return { a, b, c, d, tx: px - (a * tp.x + c * tp.y), ty: py - (b * tp.x + d * tp.y) };
}

function hex2(n: number) { return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase(); }

/** Colour effect at t, or null when the tween doesn't animate colour. */
export function motionColor(data: MotionData, t: number): ColorEffect | null {
  const v = (id: string, d: number) => { const p = findProp(data, id); return p ? evalProp(p, data, t) : d; };
  const ce = defaultColorEffect();
  if (findProp(data, 'AdvClr_R_Pct') || findProp(data, 'AdvClr_A_Pct') || findProp(data, 'AdvClr_R_Offset')) {
    ce.mode = 'advanced';
    ce.advanced = {
      rm: v('AdvClr_R_Pct', 100) / 100, gm: v('AdvClr_G_Pct', 100) / 100, bm: v('AdvClr_B_Pct', 100) / 100, am: v('AdvClr_A_Pct', 100) / 100,
      ro: v('AdvClr_R_Offset', 0), go: v('AdvClr_G_Offset', 0), bo: v('AdvClr_B_Offset', 0), ao: v('AdvClr_A_Offset', 0),
    };
    return ce;
  }
  if (findProp(data, 'Alpha_Amount')) { ce.mode = 'alpha'; ce.alpha = v('Alpha_Amount', 100); return ce; }
  if (findProp(data, 'Brightness_Amount')) { ce.mode = 'brightness'; ce.brightness = v('Brightness_Amount', 0); return ce; }
  const tc = findProp(data, 'Tint_Color');
  if (findProp(data, 'Tint_Amount') || tc) {
    ce.mode = 'tint';
    ce.tintAmount = v('Tint_Amount', 0);
    const c = tc ? evalColor(tc, data, t) : [255, 255, 255, 255];
    ce.tintColor = '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]);
    return ce;
  }
  return null;
}

/** The span's elements at frame offset t (the first object is animated). */
/** The tween's curves with the frame's Ease value applied as the main time map. */
export function effectiveMotion(frame: Frame): MotionData | undefined {
  const d = frame.motion;
  if (!d) return d;
  const tm = d.timeMaps[0];
  if ((!tm || tm.type === 'Quadratic') && (tm?.strength ?? 0) !== frame.ease) {
    return { ...d, timeMaps: [{ type: 'Quadratic', strength: frame.ease }, ...d.timeMaps.slice(1)] };
  }
  return d;
}

export function motionTween(frame: Frame, t: number): Element[] {
  const data = effectiveMotion(frame);
  if (!data || !frame.elements.length) return frame.elements;
  const target = frame.elements[0];
  const out = frame.elements.slice();
  const vals = motionValues(data, target.matrix, t);
  const m = composeMotion(vals, target.matrix, pivotOf(target));
  const color = target.type === 'symbol' ? motionColor(data, t) : null;
  out[0] = { ...target, matrix: m, ...(color ? { color } : {}) } as Element;
  return out;
}

/** Frame offsets that carry a property keyframe (timeline diamonds). */
export function motionKeyOffsets(data: MotionData | undefined): number[] {
  if (!data) return [];
  const s = new Set<number>();
  for (const p of data.props) for (const k of p.keys) s.add(Math.round(k.t));
  return [...s].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Authoring: turning an edited object back into property keys
// ---------------------------------------------------------------------------
const CONTAINER: Record<string, string> = {
  Motion_X: 'Basic_Motion', Motion_Y: 'Basic_Motion', Rotation_Z: 'Basic_Motion',
  Skew_X: 'Transformation', Skew_Y: 'Transformation', Scale_X: 'Transformation', Scale_Y: 'Transformation',
  Alpha_Amount: 'Colors/Alpha_ColorXform', Brightness_Amount: 'Colors/Brightness_ColorXform',
  Tint_Amount: 'Colors/Tint_ColorXform', Tint_Color: 'Colors/Tint_ColorXform',
  AdvClr_R_Pct: 'Colors/Advanced_ColorXform', AdvClr_G_Pct: 'Colors/Advanced_ColorXform', AdvClr_B_Pct: 'Colors/Advanced_ColorXform', AdvClr_A_Pct: 'Colors/Advanced_ColorXform',
  AdvClr_R_Offset: 'Colors/Advanced_ColorXform', AdvClr_G_Offset: 'Colors/Advanced_ColorXform', AdvClr_B_Offset: 'Colors/Advanced_ColorXform', AdvClr_A_Offset: 'Colors/Advanced_ColorXform',
};

/** Sets (or adds) a key; a new property also gets a key at the span start holding `startValue`. */
export function setKey(data: MotionData, id: string, t: number, v: number, startValue: number) {
  let p = data.props.find((q) => q.id === id);
  if (!p) {
    p = { id, container: CONTAINER[id] ?? 'Basic_Motion', keys: [] };
    data.props.push(p);
  }
  if (!p.keys.length && t > 0.0001) p.keys.push({ t: 0, v: startValue });
  const k = p.keys.find((q) => Math.abs(q.t - t) < 0.5);
  if (k) { k.v = v; delete k.next; delete k.prev; }
  else { p.keys.push({ t, v }); p.keys.sort((a, b) => a.t - b.t); }
  delete p.value;
}

function setColorKey(data: MotionData, id: string, t: number, rgba: number[], start: number[]) {
  let p = data.props.find((q) => q.id === id);
  if (!p) { p = { id, container: CONTAINER[id], keys: [] }; data.props.push(p); }
  if (!p.keys.length && t > 0.0001) p.keys.push({ t: 0, v: 0, rgba: start });
  const k = p.keys.find((q) => Math.abs(q.t - t) < 0.5);
  if (k) k.rgba = rgba; else { p.keys.push({ t, v: 0, rgba }); p.keys.sort((a, b) => a.t - b.t); }
}

/** Closest equivalent angle to `ref` (keeps rotation continuous). */
function unwrap(deg: number, ref: number) {
  return deg + 360 * Math.round((ref - deg) / 360);
}

/**
 * Records an object edited at frame offset `t` as property keys. `base` is the
 * span's stored object and `edited` the object as the user left it.
 */
export function recordMotionEdit(frame: Frame, t: number, base: Element, edited: Element) {
  const data = frame.motion!;
  const eff = effectiveMotion(frame)!;
  const before = motionValues(eff, base.matrix, t);
  const m = edited.matrix;
  const tp = pivotOf(edited);
  const b0 = baseParts(base.matrix);
  const ky = Math.atan2(m.b, m.a) / DEG, kx = Math.atan2(-m.c, m.d) / DEG;
  const rot = unwrap(ky - before.skewY, before.rotation);
  const after: MotionValues = {
    x: m.a * tp.x + m.c * tp.y + m.tx - (base.matrix.a * pivotOf(base).x + base.matrix.c * pivotOf(base).y + base.matrix.tx),
    y: m.b * tp.x + m.d * tp.y + m.ty - (base.matrix.b * pivotOf(base).x + base.matrix.d * pivotOf(base).y + base.matrix.ty),
    rotation: rot,
    skewX: unwrap(kx - rot, before.skewX),
    skewY: before.skewY,
    scaleX: Math.hypot(m.a, m.b) * 100,
    scaleY: Math.hypot(m.c, m.d) * 100,
  };
  const ch = (a: number, b: number, eps: number) => Math.abs(a - b) > eps;
  if (ch(after.x, before.x, 1e-3) || ch(after.y, before.y, 1e-3)) {
    setKey(data, 'Motion_X', t, after.x, 0);
    setKey(data, 'Motion_Y', t, after.y, 0);
  }
  if (ch(after.rotation, before.rotation, 1e-3)) setKey(data, 'Rotation_Z', t, after.rotation, b0.rotation);
  if (ch(after.skewX, before.skewX, 1e-3)) setKey(data, 'Skew_X', t, after.skewX, b0.skewX);
  if (ch(after.scaleX, before.scaleX, 1e-3) || ch(after.scaleY, before.scaleY, 1e-3)) {
    setKey(data, 'Scale_X', t, after.scaleX, b0.scaleX);
    setKey(data, 'Scale_Y', t, after.scaleY, b0.scaleY);
  }
  // transformation point moved: keep it on the stored object so the path stays put
  if (edited.type === 'symbol' && base.type === 'symbol') {
    const etp = edited.transformPoint, btp = base.transformPoint;
    if (ch(etp.x, btp.x, 1e-6) || ch(etp.y, btp.y, 1e-6)) {
      (base as SymbolInstance).transformPoint = { ...etp };
    }
  }
  // colour effect
  if (edited.type === 'symbol' && base.type === 'symbol') {
    const cur = motionColor(eff, t) ?? base.color;
    if (JSON.stringify(effectToTransform(cur)) !== JSON.stringify(effectToTransform(edited.color))) recordColor(data, t, base, edited.color);
  }
}

function recordColor(data: MotionData, t: number, base: SymbolInstance, ce: ColorEffect) {
  const startCT = effectToTransform(base.color);
  // a different kind of effect replaces the colour curves
  const ids = { alpha: ['Alpha_Amount'], brightness: ['Brightness_Amount'], tint: ['Tint_Amount', 'Tint_Color'], advanced: ['AdvClr_R_Pct', 'AdvClr_G_Pct', 'AdvClr_B_Pct', 'AdvClr_A_Pct', 'AdvClr_R_Offset', 'AdvClr_G_Offset', 'AdvClr_B_Offset', 'AdvClr_A_Offset'], none: [] as string[] };
  const keep = new Set(ids[ce.mode === 'none' ? 'alpha' : ce.mode]);
  data.props = data.props.filter((p) => !p.container.startsWith('Colors/') || keep.has(p.id));
  switch (ce.mode) {
    case 'none':
    case 'alpha':
      setKey(data, 'Alpha_Amount', t, ce.mode === 'none' ? 100 : ce.alpha, base.color.mode === 'alpha' ? base.color.alpha : startCT.am * 100);
      break;
    case 'brightness':
      setKey(data, 'Brightness_Amount', t, ce.brightness, base.color.mode === 'brightness' ? base.color.brightness : 0);
      break;
    case 'tint': {
      setKey(data, 'Tint_Amount', t, ce.tintAmount, base.color.mode === 'tint' ? base.color.tintAmount : 0);
      const hex = (s: string) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
      setColorKey(data, 'Tint_Color', t, hex(ce.tintColor), hex(base.color.mode === 'tint' ? base.color.tintColor : ce.tintColor));
      break;
    }
    case 'advanced': {
      const a = ce.advanced, s = base.color.mode === 'advanced' ? base.color.advanced : IDENTITY_CT;
      setKey(data, 'AdvClr_R_Pct', t, a.rm * 100, s.rm * 100); setKey(data, 'AdvClr_G_Pct', t, a.gm * 100, s.gm * 100);
      setKey(data, 'AdvClr_B_Pct', t, a.bm * 100, s.bm * 100); setKey(data, 'AdvClr_A_Pct', t, a.am * 100, s.am * 100);
      setKey(data, 'AdvClr_R_Offset', t, a.ro, s.ro); setKey(data, 'AdvClr_G_Offset', t, a.go, s.go);
      setKey(data, 'AdvClr_B_Offset', t, a.bo, s.bo); setKey(data, 'AdvClr_A_Offset', t, a.ao, s.ao);
      break;
    }
  }
}

/** F6 inside a motion tween: keys every animated property at t with its current value. */
export function keyAllProps(frame: Frame, t: number) {
  const data = frame.motion;
  const base = frame.elements[0];
  if (!data || !base) return;
  const eff = effectiveMotion(frame)!;
  const vals = motionValues(eff, base.matrix, t);
  const b0 = baseParts(base.matrix);
  setKey(data, 'Motion_X', t, vals.x, 0);
  setKey(data, 'Motion_Y', t, vals.y, 0);
  setKey(data, 'Rotation_Z', t, vals.rotation, b0.rotation);
  setKey(data, 'Scale_X', t, vals.scaleX, b0.scaleX);
  setKey(data, 'Scale_Y', t, vals.scaleY, b0.scaleY);
  for (const p of data.props) {
    if (!p.keys.length || p.keys.some((k) => Math.abs(k.t - t) < 0.5)) continue;
    if (p.keys[0].rgba) continue;
    const v = evalProp(p, eff, t);
    p.keys.push({ t, v });
    p.keys.sort((a, b) => a.t - b.t);
  }
}

/** Removes property keys at offset t (Clear Keyframe inside a motion tween). */
export function clearKeysAt(frame: Frame, t: number): boolean {
  const data = frame.motion;
  if (!data) return false;
  let any = false;
  for (const p of data.props) {
    const n = p.keys.length;
    p.keys = p.keys.filter((k) => Math.abs(k.t - t) >= 0.5 || k.t === 0);
    if (p.keys.length !== n) any = true;
  }
  return any;
}

/** Positions of the transformation point for every frame of the span (motion path). */
export function motionPath(frame: Frame): Point[] {
  const out: Point[] = [];
  const el = frame.elements[0];
  if (!frame.motion || !el) return out;
  for (let t = 0; t < frame.duration; t++) {
    const m = motionTween(frame, t)[0].matrix;
    const tp = pivotOf(el);
    out.push({ x: m.a * tp.x + m.c * tp.y + m.tx, y: m.b * tp.x + m.d * tp.y + m.ty });
  }
  return out;
}

/**
 * Motion data for the second half of a span split at offset `at`: keys move
 * back by `at`, a key at 0 holds the value there, and Motion_X/Y become
 * relative to the new start position.
 */
export function splitMotion(data: MotionData, at: number): MotionData {
  const out: MotionData = { ...structuredClone(data), props: [] };
  for (const p of data.props) {
    if (!p.keys.length) { out.props.push(structuredClone(p)); continue; }
    const isColor = !!p.keys[0].rgba;
    const startV = isColor ? 0 : evalProp(p, data, at);
    const startC = isColor ? evalColor(p, data, at) : undefined;
    const rel = p.id === 'Motion_X' || p.id === 'Motion_Y' ? startV : 0;
    const keys: MotionKey[] = [isColor ? { t: 0, v: 0, rgba: startC } : { t: 0, v: startV - rel }];
    for (const k of p.keys) if (k.t > at + 0.5) keys.push({ ...structuredClone(k), t: k.t - at, v: k.v - rel, ...(k.next ? { next: [k.next[0], k.next[1] - rel] as [number, number] } : {}), ...(k.prev ? { prev: [k.prev[0], k.prev[1] - rel] as [number, number] } : {}) });
    out.props.push({ ...structuredClone(p), keys });
  }
  return out;
}
