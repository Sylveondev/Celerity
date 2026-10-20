// SWF (Flash) publisher. Produces SWF 10 files with:
//  - DefineShape4 vector shapes (solid + gradient fills, strokes with caps/joins)
//  - DefineSprite for movie clips & buttons, graphic symbols flattened like Flash does
//  - classic & shape tweens baked per frame
//  - bitmaps (DefineBitsLossless2), text rasterized to bitmaps
//  - masks via clip depths
//  - simple AS2 frame scripts: stop(), play(), gotoAndPlay/Stop(n), nextFrame(), prevFrame()
import type { BlendMode, ColorTransform, Doc, Element, Fill, FilterDef, Matrix, ShapePath, Stroke, SymbolItem, Timeline, TextElement, Layer } from '../core/types';
import { multiply, IDENTITY, invert } from '../core/matrix';
import { pathBounds, toQuadPath, visit, transformPath } from '../core/path';
import { resolveLayerFrame, timelineFrameCount } from '../core/timeline';
import { concatCT, effectToTransform, isIdentityCT, parseHex, IDENTITY_CT } from '../core/util';
import { childContext, indexLibrary, instanceFrame, layoutText, type FrameContext, type LibIndex } from '../core/symbols';
import { zlibDeflate } from './zip';
import { fillSide } from './xfl-edges';
import { renderElement } from '../core/render';
import { AssetStore } from '../core/assets';

// ---------------- low level writers ----------------
class Bytes {
  buf = new Uint8Array(1024);
  len = 0;
  private ensure(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v: number) { this.ensure(1); this.buf[this.len++] = v & 255; }
  u16(v: number) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >>> 8) & 255; }
  u32(v: number) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  str(s: string) { this.bytes(new TextEncoder().encode(s)); this.u8(0); }
  done(): Uint8Array { return this.buf.slice(0, this.len); }
}

class Bits {
  private out = new Bytes();
  private cur = 0;
  private n = 0;
  ub(v: number, bits: number) {
    for (let i = bits - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | (Math.floor(v / 2 ** i) & 1);
      this.n++;
      if (this.n === 8) { this.out.u8(this.cur); this.cur = 0; this.n = 0; }
    }
  }
  sb(v: number, bits: number) {
    const max = 2 ** bits;
    this.ub(v < 0 ? max + v : v, bits);
  }
  flush() {
    if (this.n > 0) { this.out.u8(this.cur << (8 - this.n)); this.cur = 0; this.n = 0; }
  }
  done(): Uint8Array { this.flush(); return this.out.done(); }
}

function sbits(v: number): number {
  v = Math.round(v);
  if (v === 0) return 1;
  const a = v < 0 ? ~v : v;
  return 32 - Math.clz32(a) + 1;
}

function writeRect(b: Bits, x0: number, x1: number, y0: number, y1: number) {
  const vals = [x0, x1, y0, y1].map((v) => Math.max(-0x3fffffff, Math.min(0x3fffffff, Math.round(v))));
  const n = Math.max(...vals.map(sbits));
  b.ub(n, 5);
  for (const v of vals) b.sb(v, n);
}

function writeMatrix(b: Bits, m: Matrix) {
  const fx = (v: number) => Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(v * 65536)));
  const sx = fx(m.a), sy = fx(m.d), r0 = fx(m.b), r1 = fx(m.c);
  const hasScale = sx !== 65536 || sy !== 65536;
  b.ub(hasScale ? 1 : 0, 1);
  if (hasScale) {
    const n = Math.max(sbits(sx), sbits(sy));
    b.ub(n, 5); b.sb(sx, n); b.sb(sy, n);
  }
  const hasRot = r0 !== 0 || r1 !== 0;
  b.ub(hasRot ? 1 : 0, 1);
  if (hasRot) {
    const n = Math.max(sbits(r0), sbits(r1));
    b.ub(n, 5); b.sb(r0, n); b.sb(r1, n);
  }
  const tx = Math.round(m.tx * 20), ty = Math.round(m.ty * 20);
  const n = tx === 0 && ty === 0 ? 0 : Math.max(sbits(tx), sbits(ty));
  b.ub(n, 5);
  if (n) { b.sb(tx, n); b.sb(ty, n); }
}

function matrixBytes(m: Matrix): Uint8Array {
  const b = new Bits();
  writeMatrix(b, m);
  return b.done();
}

function cxformBytes(ct: ColorTransform): Uint8Array {
  const b = new Bits();
  const mul = [ct.rm, ct.gm, ct.bm, ct.am].map((v) => Math.max(-32768, Math.min(32767, Math.round(v * 256))));
  const add = [ct.ro, ct.go, ct.bo, ct.ao].map((v) => Math.max(-32768, Math.min(32767, Math.round(v))));
  const hasMul = mul.some((v) => v !== 256);
  const hasAdd = add.some((v) => v !== 0);
  b.ub(hasAdd ? 1 : 0, 1);
  b.ub(hasMul ? 1 : 0, 1);
  const n = Math.max(1, ...(hasMul ? mul.map(sbits) : []), ...(hasAdd ? add.map(sbits) : []));
  b.ub(n, 4);
  if (hasMul) for (const v of mul) b.sb(v, n);
  if (hasAdd) for (const v of add) b.sb(v, n);
  return b.done();
}

function tag(out: Bytes, code: number, body: Uint8Array) {
  if (body.length < 63 && code !== 36 && code !== 20) {
    out.u16((code << 6) | body.length);
  } else {
    out.u16((code << 6) | 0x3f);
    out.u32(body.length);
  }
  out.bytes(body);
}

// ---------------- shapes ----------------
function rgbaBytes(o: Bytes, color: string, alpha: number) {
  const [r, g, b] = parseHex(color);
  o.u8(r); o.u8(g); o.u8(b); o.u8(Math.round(Math.max(0, Math.min(1, alpha)) * 255));
}

function writeFillStyle(o: Bytes, fill: Fill | { kind: 'bitmap'; id: number; matrix: Matrix }) {
  if (fill.kind === 'solid') {
    o.u8(0x00);
    rgbaBytes(o, fill.color, fill.alpha);
  } else if (fill.kind === 'bitmap') {
    o.u8(0x41); // clipped bitmap
    o.u16(fill.id);
    o.bytes(matrixBytes(fill.matrix));
  } else {
    o.u8(fill.kind === 'linear' ? 0x10 : 0x12);
    const m = fill.matrix;
    o.bytes(matrixBytes({ a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty }));
    const stops = fill.stops.slice(0, 15);
    const bb = new Bits();
    bb.ub(fill.spread === 'reflect' ? 1 : fill.spread === 'repeat' ? 2 : 0, 2);
    bb.ub(0, 2);
    bb.ub(stops.length, 4);
    o.bytes(bb.done());
    for (const s of stops) {
      o.u8(Math.round(Math.max(0, Math.min(1, s.offset)) * 255));
      rgbaBytes(o, s.color, s.alpha);
    }
  }
}

function writeLineStyle2(o: Bytes, s: Stroke, scaleFactorVal: number) {
  const w = Math.max(1, Math.round((s.width <= 0.05 ? 0 : s.width) * scaleFactorVal * 20));
  o.u16(s.width <= 0.05 ? 1 : w);
  const cap = s.caps === 'butt' ? 1 : s.caps === 'square' ? 2 : 0;
  const join = s.joints === 'bevel' ? 1 : s.joints === 'miter' ? 2 : 0;
  const b = new Bits();
  b.ub(cap, 2);          // StartCapStyle
  b.ub(join, 2);         // JoinStyle
  b.ub(0, 1);            // HasFillFlag
  b.ub(0, 1);            // NoHScaleFlag
  b.ub(0, 1);            // NoVScaleFlag
  b.ub(0, 1);            // PixelHintingFlag
  b.ub(0, 5);            // Reserved
  b.ub(0, 1);            // NoClose
  b.ub(cap, 2);          // EndCapStyle
  o.bytes(b.done());
  if (join === 2) o.u16(Math.round((s.miter ?? 3) * 256));
  rgbaBytes(o, s.color, s.alpha);
}

interface SwfPath { fill: Fill | { kind: 'bitmap'; id: number; matrix: Matrix } | null; stroke: Stroke | null; d: number[] }

/** Encodes a DefineShape4 tag body for the given paths (coordinates in px). */
function defineShape4(id: number, paths: SwfPath[]): Uint8Array {
  const o = new Bytes();
  o.u16(id);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let eMinX = Infinity, eMinY = Infinity, eMaxX = -Infinity, eMaxY = -Infinity;
  for (const p of paths) {
    const r = pathBounds(p.d);
    if (!Number.isFinite(r.x)) continue;
    const hw = p.stroke ? Math.max(p.stroke.width, 1) / 2 : 0;
    minX = Math.min(minX, r.x - hw); minY = Math.min(minY, r.y - hw);
    maxX = Math.max(maxX, r.x + r.w + hw); maxY = Math.max(maxY, r.y + r.h + hw);
    eMinX = Math.min(eMinX, r.x); eMinY = Math.min(eMinY, r.y);
    eMaxX = Math.max(eMaxX, r.x + r.w); eMaxY = Math.max(eMaxY, r.y + r.h);
  }
  if (!Number.isFinite(minX)) { minX = minY = maxX = maxY = eMinX = eMinY = eMaxX = eMaxY = 0; }
  const rb = new Bits();
  writeRect(rb, minX * 20, maxX * 20, minY * 20, maxY * 20);
  o.bytes(rb.done());
  const eb = new Bits();
  writeRect(eb, eMinX * 20, eMaxX * 20, eMinY * 20, eMaxY * 20);
  o.bytes(eb.done());
  o.u8(0); // reserved(5) usesFillWindingRule(1) usesNonScalingStrokes(1) usesScalingStrokes(1)
  // initial style arrays: empty, every path declares its own via StateNewStyles
  o.u8(0); // fill style count
  o.u8(0); // line style count
  const b = new Bits();
  b.ub(0, 4); // NumFillBits
  b.ub(0, 4); // NumLineBits
  let px = 0, py = 0; // current pen in twips
  for (const p of paths) {
    const q = toQuadPath(p.d, 0.1);
    const side = p.fill ? fillSide(p.d) : 1;
    // 1) StyleChangeRecord that only installs this path's style arrays.
    //    Per spec, style arrays are byte aligned and followed by the new bit counts.
    b.ub(0, 1); // TypeFlag
    b.ub(1, 1); // StateNewStyles
    b.ub(0, 1); // StateLineStyle
    b.ub(0, 1); // StateFillStyle1
    b.ub(0, 1); // StateFillStyle0
    b.ub(0, 1); // StateMoveTo
    b.flush();
    const styles = new Bytes();
    styles.u8(p.fill ? 1 : 0);
    if (p.fill) writeFillStyle(styles, p.fill);
    styles.u8(p.stroke ? 1 : 0);
    if (p.stroke) writeLineStyle2(styles, p.stroke, 1);
    for (const byte of styles.done()) b.ub(byte, 8);
    const fillBits = p.fill ? 1 : 0;
    const lineBits = p.stroke ? 1 : 0;
    b.ub(fillBits, 4);
    b.ub(lineBits, 4);
    // 2) every subpath starts with a moveTo record; the first one also selects
    //    the styles (always set explicitly so nothing leaks from the previous path).
    let first = true;
    let sxT = 0, syT = 0;
    const moveTo = (x: number, y: number) => {
      const tx = Math.round(x * 20), ty = Math.round(y * 20);
      b.ub(0, 1); // TypeFlag
      b.ub(0, 1); // StateNewStyles
      b.ub(first ? 1 : 0, 1); // StateLineStyle
      b.ub(first ? 1 : 0, 1); // StateFillStyle1
      b.ub(first ? 1 : 0, 1); // StateFillStyle0
      b.ub(1, 1); // StateMoveTo
      const n = Math.max(sbits(tx), sbits(ty));
      b.ub(n, 5); b.sb(tx, n); b.sb(ty, n);
      if (first) {
        b.ub(p.fill && side === 0 ? 1 : 0, fillBits); // FillStyle0
        b.ub(p.fill && side === 1 ? 1 : 0, fillBits); // FillStyle1
        b.ub(p.stroke ? 1 : 0, lineBits);             // LineStyle
      }
      first = false;
      px = tx; py = ty; sxT = tx; syT = ty;
    };
    const line = (x: number, y: number) => {
      const tx = Math.round(x * 20), ty = Math.round(y * 20);
      if (tx === px && ty === py) return;
      // split overly long lines (edge deltas are limited to 17 bits)
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(tx - px), Math.abs(ty - py)) / 60000));
      for (let s = 1; s <= steps; s++) {
        const nx = s === steps ? tx : Math.round(px + (tx - px) / (steps - s + 1));
        const ny = s === steps ? ty : Math.round(py + (ty - py) / (steps - s + 1));
        const dx = nx - px, dy = ny - py;
        b.ub(1, 1); b.ub(1, 1); // edge, straight
        const n = Math.max(2, sbits(dx), sbits(dy));
        b.ub(n - 2, 4);
        if (dx !== 0 && dy !== 0) {
          b.ub(1, 1); b.sb(dx, n); b.sb(dy, n);
        } else {
          b.ub(0, 1);
          if (dx === 0) { b.ub(1, 1); b.sb(dy, n); } else { b.ub(0, 1); b.sb(dx, n); }
        }
        px = nx; py = ny;
      }
    };
    const curve = (cx: number, cy: number, x: number, y: number) => {
      const ctx = Math.round(cx * 20), cty = Math.round(cy * 20);
      const ax = Math.round(x * 20), ay = Math.round(y * 20);
      const d1x = ctx - px, d1y = cty - py, d2x = ax - ctx, d2y = ay - cty;
      const n = Math.max(2, sbits(d1x), sbits(d1y), sbits(d2x), sbits(d2y));
      if (n > 17) { line(cx, cy); line(x, y); return; }
      b.ub(1, 1); b.ub(0, 1);
      b.ub(n - 2, 4);
      b.sb(d1x, n); b.sb(d1y, n); b.sb(d2x, n); b.sb(d2y, n);
      px = ax; py = ay;
    };
    visit(q, {
      M: (x, y) => moveTo(x, y),
      L: (x, y) => line(x, y),
      Q: (cx, cy, x, y) => curve(cx, cy, x, y),
      C: () => { /* not present */ },
      Z: () => { if (px !== sxT || py !== syT) line(sxT / 20, syT / 20); },
    });
  }
  b.ub(0, 6); // EndShapeRecord
  o.bytes(b.done());
  return o.done();
}

// ---------------- display list model ----------------
interface Item {
  char: number;
  matrix: Matrix;
  ct: ColorTransform;
  name?: string;
  clipDepth?: number; // index (exclusive end) of masked items, converted to depth later
  ratio?: number;
  filters?: FilterDef[];
  blend?: BlendMode;
}

export interface SwfOptions {
  version?: number;
  compress?: boolean;
  includeHidden?: boolean;
  assets: AssetStore;
  pixels(assetId: string): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null>;
  sceneIndex?: number; // undefined = all scenes in sequence
}

interface Ctx {
  doc: Doc;
  lib: LibIndex;
  opts: SwfOptions;
  nextId: number;
  defs: Bytes;
  shapeCache: Map<string, number>;
  spriteIds: Map<string, number>;
  bitmapChars: Map<string, number>;     // assetId -> bitmap char
  bitmapShapes: Map<string, number>;    // library item -> shape id
  pixelCache: Map<string, { width: number; height: number; data: Uint8ClampedArray } | null>;
  building: Set<string>;
}

async function defineBitmapShape(c: Ctx, itemName: string): Promise<number | null> {
  const hit = c.bitmapShapes.get(itemName);
  if (hit !== undefined) return hit;
  const it = c.lib.get(itemName);
  if (!it || it.kind !== 'bitmap') return null;
  let px = c.pixelCache.get(it.assetId);
  if (px === undefined) { px = await c.opts.pixels(it.assetId); c.pixelCache.set(it.assetId, px); }
  if (!px) return null;
  const bmpId = await defineBitsLossless(c, px.width, px.height, px.data);
  const sid = c.nextId++;
  const d = [0, 0, 0, 1, it.width, 0, 1, it.width, it.height, 1, 0, it.height, 4];
  const sx = it.width / px.width, sy = it.height / px.height;
  tag(c.defs, 83, defineShape4(sid, [{ fill: { kind: 'bitmap', id: bmpId, matrix: { a: 20 * sx, b: 0, c: 0, d: 20 * sy, tx: 0, ty: 0 } }, stroke: null, d }]));
  c.bitmapShapes.set(itemName, sid);
  return sid;
}

async function defineBitsLossless(c: Ctx, w: number, h: number, rgba: Uint8ClampedArray): Promise<number> {
  const id = c.nextId++;
  const argb = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    argb[i * 4] = a;
    argb[i * 4 + 1] = Math.round((rgba[i * 4] * a) / 255);
    argb[i * 4 + 2] = Math.round((rgba[i * 4 + 1] * a) / 255);
    argb[i * 4 + 3] = Math.round((rgba[i * 4 + 2] * a) / 255);
  }
  const z = await zlibDeflate(argb);
  const o = new Bytes();
  o.u16(id); o.u8(5); o.u16(w); o.u16(h); o.bytes(z);
  tag(c.defs, 36, o.done());
  return id;
}

async function defineTextShape(c: Ctx, t: TextElement): Promise<{ id: number; scale: number } | null> {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const key = 'text:' + JSON.stringify([t.text, t.font, t.size, t.bold, t.italic, t.color, t.alpha, t.align, t.width, t.lineSpacing, t.letterSpacing]);
  const scale = 2;
  const hit = c.shapeCache.get(key);
  if (hit !== undefined) return { id: hit, scale };
  const lay = layoutText(t);
  const w = Math.max(1, Math.ceil(lay.width * scale)), h = Math.max(1, Math.ceil(lay.height * scale));
  const cv = new OffscreenCanvas(w, h);
  const x = cv.getContext('2d')!;
  const env = { lib: c.lib, assets: c.opts.assets, playback: true, includeHidden: true, showGuides: false, outlines: false };
  renderElement(x, { ...t, matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } }, { a: scale, b: 0, c: 0, d: scale, tx: 0, ty: 0 }, IDENTITY_CT, env, { offset: 0, elapsed: 0, spanAll: true, playback: true }, 0);
  const data = x.getImageData(0, 0, w, h).data;
  const bmp = await defineBitsLossless(c, w, h, data);
  const sid = c.nextId++;
  const d = [0, 0, 0, 1, w, 0, 1, w, h, 1, 0, h, 4];
  tag(c.defs, 83, defineShape4(sid, [{ fill: { kind: 'bitmap', id: bmp, matrix: { a: 20, b: 0, c: 0, d: 20, tx: 0, ty: 0 } }, stroke: null, d }]));
  c.shapeCache.set(key, sid);
  return { id: sid, scale };
}

function defineShapeCached(c: Ctx, paths: ShapePath[]): number {
  const key = JSON.stringify(paths);
  const hit = c.shapeCache.get(key);
  if (hit !== undefined) return hit;
  const id = c.nextId++;
  tag(c.defs, 83, defineShape4(id, paths));
  c.shapeCache.set(key, id);
  return id;
}

async function collectItems(c: Ctx, tl: Timeline, frame: number, m: Matrix, ct: ColorTransform, fctx: FrameContext, out: Item[], depth: number) {
  if (depth > 24) return;
  const layers = tl.layers;
  const len = timelineFrameCount(tl);
  const include = (l: Layer) => (c.opts.includeHidden ?? true) || l.visible;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer.type === 'folder' || layer.type === 'guide' || !include(layer)) continue;
    const parent = layer.parentId ? layers.find((l) => l.id === layer.parentId) : undefined;
    if (parent && parent.type === 'mask') continue;
    if (layer.type === 'mask') {
      // mask: union of the mask layer's shapes as one clip shape
      const maskPaths: ShapePath[] = [];
      const r = resolveLayerFrame(layer, frame);
      if (r) collectMaskPaths(c, r.elements, m, maskPaths, childContext(fctx, r.frame.start, r.frame.duration, len, r.offset), depth);
      const startIdx = out.length;
      const clipItem: Item = { char: 0, matrix: IDENTITY, ct: IDENTITY_CT, clipDepth: 0 };
      if (maskPaths.length) {
        clipItem.char = defineShapeCached(c, maskPaths.map((p) => ({ ...p, fill: { kind: 'solid', color: '#000000', alpha: 1 }, stroke: null })));
        out.push(clipItem);
      }
      const children = layers.filter((l) => l.parentId === layer.id && l.type !== 'folder');
      for (let k = children.length - 1; k >= 0; k--) {
        const ch = children[k];
        if (!include(ch)) continue;
        await collectLayer(c, ch, frame, m, ct, fctx, out, depth, len);
      }
      if (maskPaths.length) clipItem.clipDepth = out.length; // index of last masked item (+1 later)
      void startIdx;
      continue;
    }
    await collectLayer(c, layer, frame, m, ct, fctx, out, depth, len);
  }
}

function collectMaskPaths(c: Ctx, els: Element[], m: Matrix, out: ShapePath[], fctx: FrameContext, depth: number) {
  for (const el of els) {
    const mm = multiply(m, el.matrix);
    if (el.type === 'shape') {
      for (const p of el.paths) if (p.fill) out.push({ fill: p.fill, stroke: null, d: transformPath(p.d, mm) });
    } else if (el.type === 'group') {
      collectMaskPaths(c, el.children, mm, out, fctx, depth);
    } else if (el.type === 'symbol' && depth < 24) {
      const sym = c.lib.get(el.libraryItem);
      if (sym?.kind !== 'symbol') continue;
      const f = instanceFrame(el, sym, fctx);
      const len = timelineFrameCount(sym.timeline);
      for (const l of sym.timeline.layers) {
        if (l.type === 'guide' || l.type === 'folder') continue;
        const r = resolveLayerFrame(l, f);
        if (r) collectMaskPaths(c, r.elements, mm, out, childContext(fctx, r.frame.start, r.frame.duration, len, r.offset), depth + 1);
      }
    } else if (el.type === 'bitmap') {
      const it = c.lib.get(el.libraryItem);
      if (it?.kind === 'bitmap') {
        out.push({ fill: { kind: 'solid', color: '#000000', alpha: 1 }, stroke: null, d: transformPath([0, 0, 0, 1, it.width, 0, 1, it.width, it.height, 1, 0, it.height, 4], mm) });
      }
    }
  }
}

async function collectLayer(c: Ctx, layer: Layer, frame: number, m: Matrix, ct: ColorTransform, fctx: FrameContext, out: Item[], depth: number, len: number) {
  const r = resolveLayerFrame(layer, frame);
  if (!r) return;
  const sub = childContext(fctx, r.frame.start, r.frame.duration, len, r.offset);
  for (const el of r.elements) await collectElement(c, el, m, ct, sub, out, depth);
}

async function collectElement(c: Ctx, el: Element, m: Matrix, ct: ColorTransform, fctx: FrameContext, out: Item[], depth: number) {
  const mm = multiply(m, el.matrix);
  switch (el.type) {
    case 'shape': {
      if (!el.paths.length) return;
      out.push({ char: defineShapeCached(c, el.paths), matrix: mm, ct });
      return;
    }
    case 'group':
      for (const ch of el.children) await collectElement(c, ch, mm, ct, fctx, out, depth);
      return;
    case 'bitmap': {
      const id = await defineBitmapShape(c, el.libraryItem);
      if (id !== null) out.push({ char: id, matrix: mm, ct });
      return;
    }
    case 'text': {
      const r = await defineTextShape(c, el);
      if (r) out.push({ char: r.id, matrix: multiply(mm, { a: 1 / r.scale, b: 0, c: 0, d: 1 / r.scale, tx: 0, ty: 0 }), ct: concatCT(ct, IDENTITY_CT) });
      return;
    }
    case 'symbol': {
      const sym = c.lib.get(el.libraryItem);
      if (!sym || sym.kind !== 'symbol') return;
      const childCT = concatCT(ct, effectToTransform(el.color));
      if (el.symbolType === 'graphic') {
        const f = instanceFrame(el, sym, fctx);
        await collectItems(c, sym.timeline, f, mm, childCT, { ...fctx, offset: f }, out, depth + 1);
        return;
      }
      const sid = await defineSprite(c, sym);
      if (sid === null) return;
      out.push({ char: sid, matrix: mm, ct: childCT, name: el.name || undefined, filters: el.filters, blend: el.blendMode });
      return;
    }
  }
}

function sameItems(a: Item[], b: Item[], upto: number): boolean {
  for (let i = 0; i < upto; i++) {
    if (a[i].char !== b[i].char || (a[i].clipDepth ?? -1) !== (b[i].clipDepth ?? -1) || a[i].name !== b[i].name) return false;
  }
  return true;
}

const BLEND_IDS: Record<string, number> = { normal: 1, layer: 2, multiply: 3, screen: 4, lighten: 5, darken: 6, difference: 7, add: 8, subtract: 9, invert: 10, overlay: 13, hardlight: 14 };

function fixed(o: Bytes, v: number) { o.u32(Math.round(v * 65536) >>> 0); }

function filterList(filters: FilterDef[]): Uint8Array {
  const o = new Bytes();
  const list = filters.slice(0, 255);
  o.u8(list.length);
  for (const f of list) {
    const passes = Math.max(1, Math.min(31, Math.round(f.quality || 1)));
    if (f.type === 'blur') {
      o.u8(1); fixed(o, f.blurX); fixed(o, f.blurY); o.u8(passes << 3);
    } else if (f.type === 'dropShadow') {
      o.u8(0); rgbaBytes(o, f.color, f.alpha);
      fixed(o, f.blurX); fixed(o, f.blurY); fixed(o, (f.angle * Math.PI) / 180); fixed(o, f.distance);
      o.u16(Math.round(f.strength * 256));
      o.u8(((f.inner ? 1 : 0) << 7) | ((f.knockout || f.hideObject ? 1 : 0) << 6) | (1 << 5) | passes);
    } else {
      o.u8(2); rgbaBytes(o, f.color, f.alpha);
      fixed(o, f.blurX); fixed(o, f.blurY);
      o.u16(Math.round(f.strength * 256));
      o.u8(((f.inner ? 1 : 0) << 7) | ((f.knockout ? 1 : 0) << 6) | (1 << 5) | passes);
    }
  }
  return o.done();
}

function placeObject2(o: Bytes, depth: number, item: Item, move: boolean, prev?: Item) {
  if (!move && ((item.filters && item.filters.length) || (item.blend && item.blend !== 'normal'))) {
    placeObject3(o, depth, item);
    return;
  }
  const body = new Bytes();
  const hasMatrix = !prev || !matEq(prev.matrix, item.matrix);
  const hasCT = !prev ? !isIdentityCT(item.ct) : !ctEq(prev.ct, item.ct);
  const hasName = !move && !!item.name;
  const hasClip = !move && item.clipDepth !== undefined;
  let flags = 0;
  if (hasClip) flags |= 0x40;
  if (hasName) flags |= 0x20;
  if (hasCT) flags |= 0x08;
  if (hasMatrix) flags |= 0x04;
  if (!move) flags |= 0x02; // HasCharacter
  if (move) flags |= 0x01;
  if (move && !hasMatrix && !hasCT) return;
  body.u8(flags);
  body.u16(depth);
  if (!move) body.u16(item.char);
  if (hasMatrix) body.bytes(matrixBytes(twipMatrix(item.matrix)));
  if (hasCT) body.bytes(cxformBytes(item.ct));
  if (hasName) body.str(item.name!);
  if (hasClip) body.u16(item.clipDepth!);
  tag(o, 26, body.done());
}

function placeObject3(o: Bytes, depth: number, item: Item) {
  const body = new Bytes();
  const hasCT = !isIdentityCT(item.ct);
  const hasFilters = !!(item.filters && item.filters.length);
  const blendId = item.blend ? BLEND_IDS[item.blend] : undefined;
  let f1 = 0x02 | 0x04; // character + matrix
  if (hasCT) f1 |= 0x08;
  if (item.name) f1 |= 0x20;
  if (item.clipDepth !== undefined) f1 |= 0x40;
  let f2 = 0;
  if (hasFilters) f2 |= 0x01;
  if (blendId) f2 |= 0x02;
  body.u8(f1); body.u8(f2);
  body.u16(depth);
  body.u16(item.char);
  body.bytes(matrixBytes(item.matrix));
  if (hasCT) body.bytes(cxformBytes(item.ct));
  if (item.name) body.str(item.name);
  if (item.clipDepth !== undefined) body.u16(item.clipDepth);
  if (hasFilters) body.bytes(filterList(item.filters!));
  if (blendId) body.u8(blendId);
  tag(o, 70, body.done());
}

function twipMatrix(m: Matrix): Matrix {
  // writeMatrix multiplies translation by 20 already; linear part is unit-less
  return m;
}

function matEq(a: Matrix, b: Matrix) {
  return Math.abs(a.a - b.a) < 1e-6 && Math.abs(a.b - b.b) < 1e-6 && Math.abs(a.c - b.c) < 1e-6 && Math.abs(a.d - b.d) < 1e-6 &&
    Math.abs(a.tx - b.tx) < 0.025 && Math.abs(a.ty - b.ty) < 0.025;
}
function ctEq(a: ColorTransform, b: ColorTransform) {
  return a.rm === b.rm && a.gm === b.gm && a.bm === b.bm && a.am === b.am && a.ro === b.ro && a.go === b.go && a.bo === b.bo && a.ao === b.ao;
}

/** Compiles common timeline scripts into AS2 action bytecode. */
export function compileScript(src: string, labels: Map<string, number>): Uint8Array | null {
  const o = new Bytes();
  let any = false;
  const stmts = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  for (let s of stmts) {
    s = s.replace(/^this\./, '').replace(/^_root\./, '');
    let mm: RegExpExecArray | null;
    if (/^stop\(\s*\)$/.test(s)) { o.u8(0x07); any = true; }
    else if (/^play\(\s*\)$/.test(s)) { o.u8(0x06); any = true; }
    else if (/^nextFrame\(\s*\)$/.test(s)) { o.u8(0x04); any = true; }
    else if (/^prevFrame\(\s*\)$/.test(s)) { o.u8(0x05); any = true; }
    else if ((mm = /^goto(And)?(Play|Stop)\(\s*(?:(\d+)|["']([^"']+)["'])\s*\)$/.exec(s))) {
      let frame = mm[3] !== undefined ? parseInt(mm[3], 10) - 1 : labels.get(mm[4]) ?? -1;
      if (frame < 0) continue;
      frame = Math.min(frame, 65535);
      o.u8(0x81); o.u16(2); o.u16(frame);
      if (mm[2] === 'Play') o.u8(0x06); else o.u8(0x07);
      any = true;
    }
  }
  if (!any) return null;
  o.u8(0);
  return o.done();
}

async function emitTimelineFrames(c: Ctx, tl: Timeline, out: Bytes, ctxFor: (f: number) => FrameContext, frameOffset = 0, prevIn: Item[] = []): Promise<Item[]> {
  const len = timelineFrameCount(tl);
  let prev: Item[] = prevIn;
  const labels = new Map<number, string>();
  const labelFrames = new Map<string, number>();
  const scripts = new Map<number, string>();
  for (const l of tl.layers) for (const f of l.frames) {
    if (f.label && f.labelType !== 'comment') { labels.set(f.start, f.label); labelFrames.set(f.label, f.start + frameOffset); }
    if (f.script && f.script.trim()) scripts.set(f.start, (scripts.get(f.start) ?? '') + '\n' + f.script);
  }
  for (let f = 0; f < len; f++) {
    const items: Item[] = [];
    await collectItems(c, tl, f, IDENTITY, IDENTITY_CT, ctxFor(f), items, 0);
    // clipDepth currently holds the exclusive index of last masked item; convert to depth
    for (const it of items) if (it.clipDepth !== undefined) it.clipDepth = it.clipDepth; // depth = index+1 => exclusive index == last depth
    let keep = 0;
    const maxKeep = Math.min(prev.length, items.length);
    while (keep < maxKeep && sameItems(prev, items, keep + 1)) keep++;
    for (let d = prev.length; d > keep; d--) {
      const rb = new Bytes(); rb.u16(d); tag(out, 28, rb.done());
    }
    for (let i = 0; i < items.length; i++) {
      if (i < keep) placeObject2(out, i + 1, items[i], true, prev[i]);
      else placeObject2(out, i + 1, items[i], false);
    }
    if (labels.has(f)) { const lb = new Bytes(); lb.str(labels.get(f)!); tag(out, 43, lb.done()); }
    if (scripts.has(f)) {
      const code = compileScript(scripts.get(f)!, labelFrames);
      if (code) tag(out, 12, code);
    }
    tag(out, 1, new Uint8Array(0)); // ShowFrame
    prev = items;
  }
  return prev;
}

async function defineSprite(c: Ctx, sym: SymbolItem): Promise<number | null> {
  const hit = c.spriteIds.get(sym.name);
  if (hit !== undefined) return hit;
  if (c.building.has(sym.name)) return null; // recursive symbol
  c.building.add(sym.name);
  const body = new Bytes();
  const control = new Bytes();
  const len = timelineFrameCount(sym.timeline);
  await emitTimelineFrames(c, sym.timeline, control, (f) => ({ offset: f, elapsed: f, spanAll: true, playback: true }));
  tag(control, 0, new Uint8Array(0));
  const id = c.nextId++;
  body.u16(id);
  body.u16(len);
  body.bytes(control.done());
  tag(c.defs, 39, body.done());
  c.spriteIds.set(sym.name, id);
  c.building.delete(sym.name);
  return id;
}

export async function writeSwf(doc: Doc, opts: SwfOptions): Promise<Uint8Array> {
  const version = opts.version ?? 10;
  const c: Ctx = {
    doc, lib: indexLibrary(doc), opts, nextId: 1, defs: new Bytes(), shapeCache: new Map(), spriteIds: new Map(),
    bitmapChars: new Map(), bitmapShapes: new Map(), pixelCache: new Map(), building: new Set(),
  };
  const scenes = opts.sceneIndex !== undefined ? [doc.scenes[opts.sceneIndex]] : doc.scenes;
  const frames = new Bytes();
  let totalFrames = 0;
  let prev: Item[] = [];
  for (const tl of scenes) {
    prev = await emitTimelineFrames(c, tl, frames, (f) => ({ offset: f, elapsed: f, spanAll: true, playback: true }), totalFrames, prev);
    totalFrames += timelineFrameCount(tl);
  }
  tag(frames, 0, new Uint8Array(0)); // End

  const body = new Bytes();
  const rb = new Bits();
  writeRect(rb, 0, doc.width * 20, 0, doc.height * 20);
  body.bytes(rb.done());
  const fps = Math.max(0.01, Math.min(255, doc.fps));
  body.u16(Math.round(fps * 256));
  body.u16(Math.min(65535, totalFrames));
  // FileAttributes: AS1/2 (scripts compiled to DoAction), no network access flags
  const fa = new Bytes(); fa.u32(0); tag(body, 69, fa.done());
  const bg = new Bytes();
  const [r, g, b] = parseHex(doc.background);
  bg.u8(r); bg.u8(g); bg.u8(b);
  tag(body, 9, bg.done());
  body.bytes(c.defs.done());
  body.bytes(frames.done());
  const content = body.done();
  const total = content.length + 8;
  const header = new Uint8Array(8);
  const compress = opts.compress ?? true;
  header[0] = compress ? 0x43 : 0x46; header[1] = 0x57; header[2] = 0x53; header[3] = version;
  new DataView(header.buffer).setUint32(4, total, true);
  const payload = compress ? await zlibDeflate(content) : content;
  const out = new Uint8Array(8 + payload.length);
  out.set(header, 0);
  out.set(payload, 8);
  return out;
}

/** HTML page that plays the SWF with the Ruffle Flash emulator. */
export function swfHtmlWrapper(swfName: string, width: number, height: number, bg: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${swfName.replace(/[<&>]/g, '')}</title>
<style>html,body{margin:0;height:100%;background:${bg};display:flex;align-items:center;justify-content:center}</style>
<script src="https://unpkg.com/@ruffle-rs/ruffle@0.1.0-nightly.2024.11.12/ruffle.js"></script>
</head>
<body>
<embed src="${encodeURI(swfName)}" width="${Math.round(width)}" height="${Math.round(height)}" type="application/x-shockwave-flash">
</body>
</html>
`;
}

export { invert };
