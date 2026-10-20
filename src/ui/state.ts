// UI state shared by tools and panels (not part of the document / undo).
import type { CapStyle, JoinStyle, Matrix, GradientStop } from '../core/types';
import { Store } from '../core/store';

export type ToolId =
  | 'select' | 'subselect' | 'transform' | 'line' | 'rect' | 'oval' | 'polystar' | 'pencil' | 'brush'
  | 'pen' | 'bucket' | 'ink' | 'eyedropper' | 'eraser' | 'text' | 'hand' | 'zoom' | 'gradient';

export interface UIState {
  tool: ToolId;
  fillColor: string;
  fillAlpha: number;
  fillNone: boolean;
  fillKind: 'solid' | 'linear' | 'radial';
  fillStops: GradientStop[];
  strokeColor: string;
  strokeAlpha: number;
  strokeNone: boolean;
  strokeWidth: number;
  caps: CapStyle;
  joints: JoinStyle;
  rectRadius: number;
  polySides: number;
  polyStar: boolean;
  polyInner: number;
  pencilMode: 'smooth' | 'straighten' | 'ink';
  brushSize: number;
  brushPressure: boolean;
  eraserSize: number;
  eraserMode: 'normal' | 'fills' | 'lines' | 'object';
  bucketGap: 'none' | 'small' | 'medium' | 'large';
  textFont: string;
  textSize: number;
  textBold: boolean;
  textItalic: boolean;
  textAlign: 'left' | 'center' | 'right';
  onion: boolean;
  onionBefore: number;
  onionAfter: number;
  onionOutline: boolean;
  loop: boolean;
  snap: boolean;
  view: Matrix;            // stage -> screen (CSS px)
  zoom: number;
  showGrid: boolean;
  showRulers: boolean;
  clipToStage: boolean;
  swatches: string[];
  recentColors: string[];
  previewQuality: 'high' | 'fast';
}

const DEFAULT_SWATCHES = (() => {
  const out: string[] = [];
  // grayscale row + web-safe-like palette similar to Animate's default swatches
  for (const g of ['000000', '333333', '666666', '999999', 'CCCCCC', 'FFFFFF']) out.push('#' + g);
  const steps = ['00', '33', '66', '99', 'CC', 'FF'];
  for (const r of steps) for (const g of steps) for (const b of ['00', '66', 'CC', 'FF']) out.push(`#${r}${g}${b}`);
  return out;
})();

export const ui: UIState = {
  tool: 'select',
  fillColor: '#3399FF',
  fillAlpha: 1,
  fillNone: false,
  fillKind: 'solid',
  fillStops: [{ offset: 0, color: '#FFFFFF', alpha: 1 }, { offset: 1, color: '#000000', alpha: 1 }],
  strokeColor: '#000000',
  strokeAlpha: 1,
  strokeNone: false,
  strokeWidth: 1,
  caps: 'round',
  joints: 'round',
  rectRadius: 0,
  polySides: 5,
  polyStar: false,
  polyInner: 0.5,
  pencilMode: 'smooth',
  brushSize: 10,
  brushPressure: true,
  eraserSize: 16,
  eraserMode: 'normal',
  bucketGap: 'small',
  textFont: 'Arial',
  textSize: 24,
  textBold: false,
  textItalic: false,
  textAlign: 'left',
  onion: false,
  onionBefore: 2,
  onionAfter: 2,
  onionOutline: false,
  loop: true,
  snap: true,
  view: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
  zoom: 1,
  showGrid: false,
  showRulers: false,
  clipToStage: false,
  swatches: DEFAULT_SWATCHES,
  recentColors: [],
  previewQuality: 'high',
};

export const store = new Store();

type UIListener = (key: string) => void;
const uiListeners: UIListener[] = [];
export function onUI(fn: UIListener) { uiListeners.push(fn); }
export function setUI<K extends keyof UIState>(key: K, value: UIState[K]) {
  ui[key] = value;
  for (const l of uiListeners) l(key as string);
  persistPrefs();
}

const PREF_KEYS: (keyof UIState)[] = [
  'fillColor', 'fillAlpha', 'fillKind', 'fillStops', 'strokeColor', 'strokeAlpha', 'strokeWidth', 'rectRadius', 'polySides', 'polyStar', 'polyInner',
  'pencilMode', 'brushSize', 'brushPressure', 'eraserSize', 'eraserMode', 'bucketGap', 'textFont', 'textSize', 'onionBefore', 'onionAfter',
  'loop', 'snap', 'showGrid', 'recentColors', 'previewQuality', 'clipToStage',
];

let persistTimer = 0;
function persistPrefs() {
  if (typeof localStorage === 'undefined') return;
  clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    try {
      const o: Record<string, unknown> = {};
      for (const k of PREF_KEYS) o[k] = ui[k];
      localStorage.setItem('celerity.prefs', JSON.stringify(o));
    } catch { /* storage unavailable */ }
  }, 300);
}

export function loadPrefs() {
  try {
    const raw = localStorage.getItem('celerity.prefs');
    if (!raw) return;
    const o = JSON.parse(raw);
    for (const k of PREF_KEYS) if (o[k] !== undefined && typeof o[k] === typeof ui[k]) (ui as unknown as Record<string, unknown>)[k] = o[k];
  } catch { /* ignore */ }
}

export function addRecentColor(c: string) {
  const list = [c, ...ui.recentColors.filter((x) => x !== c)].slice(0, 12);
  setUI('recentColors', list);
}
