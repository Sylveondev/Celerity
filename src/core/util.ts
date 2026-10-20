import type {
  ColorEffect, ColorTransform, Doc, Element, Frame, Layer, Stroke, SymbolItem, Timeline, Fill,
} from './types';

let idCounter = 0;
const idPrefix = Math.floor(Math.random() * 0xffffff).toString(36);
export function uid(): string {
  idCounter++;
  return idPrefix + idCounter.toString(36);
}

export function itemId(): string {
  // XFL style itemID: 8 hex - 8 hex
  const h = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${h()}-${h()}`;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function clone<T>(v: T): T {
  return structuredClone(v);
}

export function parseHex(color: string): [number, number, number] {
  let c = color.trim();
  if (c[0] === '#') c = c.slice(1);
  if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  const n = parseInt(c.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function toHex(r: number, g: number, b: number): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return ('#' + h(r) + h(g) + h(b)).toUpperCase();
}

export function rgba(color: string, alpha: number): string {
  const [r, g, b] = parseHex(color);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = parseHex(a), cb = parseHex(b);
  return toHex(lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerp(ca[2], cb[2], t));
}

export function normalizeHex(s: string): string | null {
  let c = s.trim();
  if (c[0] === '#') c = c.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(c)) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  if (!/^[0-9a-fA-F]{6}$/.test(c)) return null;
  return '#' + c.toUpperCase();
}

export const IDENTITY_CT: ColorTransform = { rm: 1, gm: 1, bm: 1, am: 1, ro: 0, go: 0, bo: 0, ao: 0 };

export function defaultColorEffect(): ColorEffect {
  return { mode: 'none', brightness: 0, tintColor: '#FFFFFF', tintAmount: 0, alpha: 100, advanced: { ...IDENTITY_CT } };
}

/** Converts the UI-friendly color effect into a color transform. */
export function effectToTransform(e: ColorEffect | undefined): ColorTransform {
  if (!e) return IDENTITY_CT;
  switch (e.mode) {
    case 'alpha':
      return { ...IDENTITY_CT, am: clamp(e.alpha, 0, 100) / 100 };
    case 'brightness': {
      const b = clamp(e.brightness, -100, 100) / 100;
      if (b >= 0) {
        const o = Math.round(255 * b);
        return { rm: 1 - b, gm: 1 - b, bm: 1 - b, am: 1, ro: o, go: o, bo: o, ao: 0 };
      }
      return { rm: 1 + b, gm: 1 + b, bm: 1 + b, am: 1, ro: 0, go: 0, bo: 0, ao: 0 };
    }
    case 'tint': {
      const t = clamp(e.tintAmount, 0, 100) / 100;
      const [r, g, b] = parseHex(e.tintColor);
      return { rm: 1 - t, gm: 1 - t, bm: 1 - t, am: 1, ro: Math.round(r * t), go: Math.round(g * t), bo: Math.round(b * t), ao: 0 };
    }
    case 'advanced':
      return { ...e.advanced };
    default:
      return IDENTITY_CT;
  }
}

export function concatCT(outer: ColorTransform, inner: ColorTransform): ColorTransform {
  // result(c) = outer(inner(c))
  return {
    rm: outer.rm * inner.rm, gm: outer.gm * inner.gm, bm: outer.bm * inner.bm, am: outer.am * inner.am,
    ro: outer.rm * inner.ro + outer.ro, go: outer.gm * inner.go + outer.go,
    bo: outer.bm * inner.bo + outer.bo, ao: outer.am * inner.ao + outer.ao,
  };
}

export function isIdentityCT(ct: ColorTransform): boolean {
  return ct.rm === 1 && ct.gm === 1 && ct.bm === 1 && ct.am === 1 && ct.ro === 0 && ct.go === 0 && ct.bo === 0 && ct.ao === 0;
}

export function isAlphaOnlyCT(ct: ColorTransform): boolean {
  return ct.rm === 1 && ct.gm === 1 && ct.bm === 1 && ct.ro === 0 && ct.go === 0 && ct.bo === 0 && ct.ao === 0;
}

export function lerpCT(a: ColorTransform, b: ColorTransform, t: number): ColorTransform {
  return {
    rm: lerp(a.rm, b.rm, t), gm: lerp(a.gm, b.gm, t), bm: lerp(a.bm, b.bm, t), am: lerp(a.am, b.am, t),
    ro: lerp(a.ro, b.ro, t), go: lerp(a.go, b.go, t), bo: lerp(a.bo, b.bo, t), ao: lerp(a.ao, b.ao, t),
  };
}

export function applyCTColor(color: string, alpha: number, ct: ColorTransform): [string, number] {
  const [r, g, b] = parseHex(color);
  return [
    toHex(r * ct.rm + ct.ro, g * ct.gm + ct.go, b * ct.bm + ct.bo),
    clamp(alpha * ct.am + ct.ao / 255, 0, 1),
  ];
}

export function applyCTFill(f: Fill, ct: ColorTransform): Fill {
  if (f.kind === 'solid') {
    const [c, a] = applyCTColor(f.color, f.alpha, ct);
    return { kind: 'solid', color: c, alpha: a };
  }
  return {
    ...f,
    stops: f.stops.map((s) => {
      const [c, a] = applyCTColor(s.color, s.alpha, ct);
      return { offset: s.offset, color: c, alpha: a };
    }),
  };
}

export function applyCTStroke(s: Stroke, ct: ColorTransform): Stroke {
  const [c, a] = applyCTColor(s.color, s.alpha, ct);
  return { ...s, color: c, alpha: a };
}

export const LAYER_COLORS = ['#4F80FF', '#FF4FFF', '#4FFF4F', '#FF4F4F', '#4FFFFF', '#FFFF4F', '#9933CC', '#FF9933', '#00CC99', '#CC6666'];
let layerColorIndex = 0;
export function nextLayerColor(): string {
  return LAYER_COLORS[layerColorIndex++ % LAYER_COLORS.length];
}

export function emptyFrame(start: number, duration = 1): Frame {
  return {
    start, duration, elements: [], tween: 'none', ease: 0, rotate: 'auto', rotateTimes: 0,
    label: '', labelType: 'name', script: '',
  };
}

export function newLayer(name: string, frameCount = 1): Layer {
  return {
    id: uid(), name, type: 'normal', parentId: null, visible: true, locked: false, outline: false,
    color: nextLayerColor(), frames: [emptyFrame(0, Math.max(1, frameCount))],
  };
}

export function newTimeline(name: string): Timeline {
  return { name, layers: [newLayer('Layer_1')] };
}

export function newDoc(width = 550, height = 400, fps = 24, background = '#FFFFFF'): Doc {
  return { width, height, fps, background, scenes: [newTimeline('Scene 1')], library: [] };
}

export function newSymbol(name: string, symbolType: SymbolItem['symbolType']): SymbolItem {
  return { kind: 'symbol', name, symbolType, timeline: newTimeline(baseName(name)), itemID: itemId() };
}

export function baseName(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(i + 1) : name;
}

export function folderOf(name: string): string {
  const i = name.lastIndexOf('/');
  return i >= 0 ? name.slice(0, i) : '';
}

/** Deep-copies elements assigning fresh ids. */
export function cloneElements(els: Element[]): Element[] {
  return els.map(cloneElement);
}

export function cloneElement(e: Element): Element {
  const c = structuredClone(e) as Element;
  reassignIds(c);
  return c;
}

function reassignIds(e: Element) {
  e.id = uid();
  if (e.type === 'group') e.children.forEach(reassignIds);
}

export function uniqueName(existing: Set<string>, base: string): string {
  if (!existing.has(base)) return base;
  const m = /^(.*?)(?:\s*(\d+))?$/.exec(base)!;
  const stem = m[1];
  let n = m[2] ? parseInt(m[2], 10) : 1;
  let name = base;
  while (existing.has(name)) {
    n++;
    name = `${stem} ${n}`;
  }
  return name;
}

export function defaultStroke(): Stroke {
  return { color: '#000000', alpha: 1, width: 1, caps: 'round', joints: 'round' };
}

export function timelineLength(tl: Timeline): number {
  let max = 0;
  for (const l of tl.layers) {
    const f = l.frames[l.frames.length - 1];
    if (f) max = Math.max(max, f.start + f.duration);
  }
  return Math.max(1, max);
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtNum(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(digits);
  return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
