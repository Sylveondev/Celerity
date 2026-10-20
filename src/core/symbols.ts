import type { BitmapItem, Doc, LibraryItem, SymbolInstance, SymbolItem, TextElement } from './types';
import { timelineFrameCount } from './timeline';

export type LibIndex = Map<string, LibraryItem>;

export function indexLibrary(doc: Doc): LibIndex {
  const m = new Map<string, LibraryItem>();
  for (const it of doc.library) m.set(it.name, it);
  return m;
}

export function getSymbol(lib: LibIndex, name: string): SymbolItem | null {
  const it = lib.get(name);
  return it && it.kind === 'symbol' ? it : null;
}

export function getBitmap(lib: LibIndex, name: string): BitmapItem | null {
  const it = lib.get(name);
  return it && it.kind === 'bitmap' ? it : null;
}

/** Timing info passed from a parent timeline to its child instances. */
export interface FrameContext {
  offset: number;    // frames since the containing keyframe started
  elapsed: number;   // frames the parent has been playing (for movie clips)
  spanAll: boolean;  // the containing keyframe spans the whole parent timeline
  playback: boolean; // movie clips animate (test movie / export)
}

const lengthCache = new WeakMap<SymbolItem['timeline'], number>();
export function symbolLength(sym: SymbolItem): number {
  // timelines are mutated in place while editing, so only cache during playback/export
  return timelineFrameCount(sym.timeline);
}
export function cachedSymbolLength(sym: SymbolItem): number {
  let n = lengthCache.get(sym.timeline);
  if (n === undefined) { n = timelineFrameCount(sym.timeline); lengthCache.set(sym.timeline, n); }
  return n;
}

/** Which frame of a symbol an instance displays. */
export function instanceFrame(inst: SymbolInstance, sym: SymbolItem, ctx: FrameContext): number {
  const len = symbolLength(sym);
  if (len <= 1) return 0;
  if (inst.symbolType === 'button') return 0;
  if (inst.symbolType === 'movieclip') {
    if (!ctx.playback) return 0;
    const e = ctx.spanAll ? ctx.elapsed : ctx.offset;
    return ((e % len) + len) % len;
  }
  const first = Math.max(0, Math.min(len - 1, inst.firstFrame | 0));
  const off = ctx.offset;
  switch (inst.loop) {
    case 'single frame': return first;
    case 'play once': return Math.min(len - 1, first + off);
    case 'play once reverse': return Math.max(0, first - off);
    case 'loop reverse': return (((first - off) % len) + len) % len;
    default: return (first + off) % len;
  }
}

export function childContext(parent: FrameContext, frameStart: number, frameDuration: number, timelineLen: number, offset: number): FrameContext {
  return {
    offset,
    elapsed: parent.elapsed,
    spanAll: frameStart === 0 && frameDuration >= timelineLen,
    playback: parent.playback,
  };
}

// ---------------- text layout ----------------
export interface TextLine { text: string; x: number; y: number; width: number }
export interface TextLayout { lines: TextLine[]; width: number; height: number; font: string; lineHeight: number }

let measureCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
function mctx() {
  if (!measureCtx) {
    if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d')!;
    else measureCtx = document.createElement('canvas').getContext('2d')!;
  }
  return measureCtx;
}

export function fontString(t: TextElement): string {
  const fam = /[\s,]/.test(t.font) && !/["']/.test(t.font) ? `"${t.font}"` : t.font;
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${Math.max(1, t.size)}px ${fam}, sans-serif`;
}

const layoutCache = new WeakMap<TextElement, { key: string; layout: TextLayout }>();

export function layoutText(t: TextElement): TextLayout {
  const key = [t.text, t.font, t.size, t.bold, t.italic, t.align, t.width, t.lineSpacing, t.letterSpacing].join('\u0001');
  const hit = layoutCache.get(t);
  if (hit && hit.key === key) return hit.layout;
  const ctx = mctx();
  const font = fontString(t);
  ctx.font = font;
  try { (ctx as any).letterSpacing = `${t.letterSpacing || 0}px`; } catch { /* older engines */ }
  const lineHeight = t.size * 1.2 + (t.lineSpacing || 0);
  const gutter = 2;
  const paragraphs = t.text.split('\n');
  const raw: { text: string; width: number }[] = [];
  const maxW = t.width > 0 ? t.width - gutter * 2 : Infinity;
  for (const para of paragraphs) {
    if (maxW === Infinity) {
      raw.push({ text: para, width: ctx.measureText(para).width });
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && ctx.measureText(test).width > maxW && w.trim()) {
        raw.push({ text: line.replace(/\s+$/, ''), width: ctx.measureText(line.replace(/\s+$/, '')).width });
        line = w.replace(/^\s+/, '');
      } else {
        line = test;
      }
    }
    raw.push({ text: line, width: ctx.measureText(line).width });
  }
  const contentW = Math.max(1, ...raw.map((r) => r.width));
  const boxW = t.width > 0 ? t.width : contentW + gutter * 2;
  const lines = raw.map((r, i) => {
    let x = gutter;
    if (t.align === 'center') x = (boxW - r.width) / 2;
    else if (t.align === 'right') x = boxW - gutter - r.width;
    return { text: r.text, x, y: gutter + i * lineHeight, width: r.width };
  });
  const layout = { lines, width: boxW, height: gutter * 2 + raw.length * lineHeight, font, lineHeight };
  layoutCache.set(t, { key, layout });
  return layout;
}
