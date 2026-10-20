// Sprite sheet packing and data-file generation (formats compatible with
// Animate's "Generate Sprite Sheet": JSON-Hash, JSON-Array, Starling/Sparrow,
// EaselJS, cocos2d-x plist, Phaser 3 multi-atlas, plain CSS).

export interface SheetFrame {
  name: string;
  srcW: number; srcH: number;            // untrimmed frame size
  trimX: number; trimY: number;          // trimmed rect within source
  w: number; h: number;                  // trimmed size
  hash: string;                          // pixel hash for duplicate detection
  dupOf?: number;                        // index of identical frame
  x?: number; y?: number;                // placement in the sheet
  anim?: string;                         // animation (symbol) the frame belongs to
  reg?: { x: number; y: number };        // registration point when it differs per animation
}

export type SheetAlgorithm = 'basic' | 'packed';
export type SheetFormat = 'json' | 'json-array' | 'starling' | 'easeljs' | 'cocos2d' | 'phaser3' | 'css';

export interface PackOptions {
  algorithm: SheetAlgorithm;
  padding: number;      // shape padding between frames
  border: number;       // border padding around the sheet
  columns?: number;     // basic: fixed column count (0 = auto)
  maxSize: number;
  powerOfTwo: boolean;
  stack: boolean;       // reuse identical frames
}

function nextPow2(v: number) { let p = 1; while (p < v) p <<= 1; return p; }

export function packFrames(frames: SheetFrame[], o: PackOptions): { width: number; height: number } {
  // duplicate detection
  if (o.stack) {
    const seen = new Map<string, number>();
    frames.forEach((f, i) => {
      const k = `${f.hash}|${f.w}x${f.h}|${f.trimX},${f.trimY}`;
      const prev = seen.get(k);
      if (prev !== undefined) f.dupOf = prev; else seen.set(k, i);
    });
  }
  const unique = frames.filter((f) => f.dupOf === undefined);
  let width = 0, height = 0;
  if (o.algorithm === 'basic') {
    const cw = Math.max(1, ...unique.map((f) => f.srcW));
    const chh = Math.max(1, ...unique.map((f) => f.srcH));
    const n = unique.length;
    let cols = o.columns && o.columns > 0 ? o.columns : Math.ceil(Math.sqrt(n * chh / cw));
    cols = Math.max(1, Math.min(n, cols));
    unique.forEach((f, i) => {
      const c = i % cols, r = Math.floor(i / cols);
      // basic layout keeps full (untrimmed) cells
      f.x = o.border + c * (cw + o.padding);
      f.y = o.border + r * (chh + o.padding);
      f.trimX = 0; f.trimY = 0; f.w = f.srcW; f.h = f.srcH;
    });
    const rows = Math.ceil(n / cols);
    width = o.border * 2 + cols * cw + (cols - 1) * o.padding;
    height = o.border * 2 + rows * chh + Math.max(0, rows - 1) * o.padding;
  } else {
    const r = maxRects(unique, o);
    width = r.width; height = r.height;
  }
  for (const f of frames) {
    if (f.dupOf !== undefined) {
      const src = frames[f.dupOf];
      f.x = src.x; f.y = src.y;
      if (o.algorithm === 'basic') { f.trimX = 0; f.trimY = 0; f.w = f.srcW; f.h = f.srcH; }
    }
  }
  if (o.powerOfTwo) { width = nextPow2(width); height = nextPow2(height); }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

interface FreeRect { x: number; y: number; w: number; h: number }

function maxRects(frames: SheetFrame[], o: PackOptions): { width: number; height: number } {
  const area = frames.reduce((s, f) => s + (f.w + o.padding) * (f.h + o.padding), 0);
  const maxW = Math.max(...frames.map((f) => f.w + o.padding), 1);
  let binW = Math.max(maxW + o.border * 2, Math.ceil(Math.sqrt(area) * 1.1) + o.border * 2);
  binW = Math.min(binW, o.maxSize);
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = tryPack(frames, binW, o);
    if (res) return res;
    binW = Math.min(o.maxSize, Math.ceil(binW * 1.25));
  }
  // fallback: shelf
  let x = o.border, y = o.border, rowH = 0, w = 0;
  for (const f of frames) {
    if (x + f.w + o.border > o.maxSize && x > o.border) { x = o.border; y += rowH + o.padding; rowH = 0; }
    f.x = x; f.y = y;
    x += f.w + o.padding; rowH = Math.max(rowH, f.h); w = Math.max(w, x);
  }
  return { width: w - o.padding + o.border, height: y + rowH + o.border };
}

function tryPack(frames: SheetFrame[], binW: number, o: PackOptions): { width: number; height: number } | null {
  const binH = o.maxSize;
  const free: FreeRect[] = [{ x: o.border, y: o.border, w: binW - o.border * 2 + o.padding, h: binH - o.border * 2 + o.padding }];
  const order = frames.map((f, i) => i).sort((a, b) => Math.max(frames[b].w, frames[b].h) - Math.max(frames[a].w, frames[a].h) || frames[b].w * frames[b].h - frames[a].w * frames[a].h);
  let usedW = 0, usedH = 0;
  for (const i of order) {
    const f = frames[i];
    const w = f.w + o.padding, h = f.h + o.padding;
    let best: FreeRect | null = null, bestShort = Infinity, bestLong = Infinity;
    for (const r of free) {
      if (w <= r.w && h <= r.h) {
        const ls = Math.min(r.w - w, r.h - h), ll = Math.max(r.w - w, r.h - h);
        // prefer low y to keep the sheet short
        const score = r.y * 4 + ls;
        if (score < bestShort || (score === bestShort && ll < bestLong)) { best = r; bestShort = score; bestLong = ll; }
      }
    }
    if (!best) return null;
    f.x = best.x; f.y = best.y;
    usedW = Math.max(usedW, best.x + f.w); usedH = Math.max(usedH, best.y + f.h);
    const placed = { x: best.x, y: best.y, w, h };
    // split free rects
    const next: FreeRect[] = [];
    for (const r of free) {
      if (placed.x >= r.x + r.w || placed.x + placed.w <= r.x || placed.y >= r.y + r.h || placed.y + placed.h <= r.y) { next.push(r); continue; }
      if (placed.x > r.x) next.push({ x: r.x, y: r.y, w: placed.x - r.x, h: r.h });
      if (placed.x + placed.w < r.x + r.w) next.push({ x: placed.x + placed.w, y: r.y, w: r.x + r.w - placed.x - placed.w, h: r.h });
      if (placed.y > r.y) next.push({ x: r.x, y: r.y, w: r.w, h: placed.y - r.y });
      if (placed.y + placed.h < r.y + r.h) next.push({ x: r.x, y: placed.y + placed.h, w: r.w, h: r.y + r.h - placed.y - placed.h });
    }
    // prune contained rects
    free.length = 0;
    for (let a = 0; a < next.length; a++) {
      let contained = false;
      for (let b = 0; b < next.length; b++) {
        if (a === b) continue;
        const A = next[a], B = next[b];
        if (A.x >= B.x && A.y >= B.y && A.x + A.w <= B.x + B.w && A.y + A.h <= B.y + B.h && (a > b || A.w !== B.w || A.h !== B.h || A.x !== B.x || A.y !== B.y)) { contained = true; break; }
      }
      if (!contained) free.push(next[a]);
    }
  }
  return { width: usedW + o.border, height: usedH + o.border };
}

export interface SheetMeta {
  image: string;
  width: number;
  height: number;
  fps: number;
  scale: number;
  animationName: string;
  registration: { x: number; y: number }; // registration point in untrimmed frame
}

/** Animations in frame order: [name, first index, last index]. One per symbol on multi-symbol sheets. */
export function sheetAnimations(frames: SheetFrame[], fallback: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  frames.forEach((f, i) => {
    const n = f.anim ?? fallback;
    const last = out[out.length - 1];
    if (last && last[0] === n && last[2] === i - 1) last[2] = i; else out.push([n, i, i]);
  });
  return out;
}

function xmlEsc(s: string) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

export function sheetData(format: SheetFormat, frames: SheetFrame[], meta: SheetMeta): { text: string; ext: string } {
  const app = 'Celerity';
  switch (format) {
    case 'json':
    case 'json-array': {
      const entries = frames.map((f) => ({
        filename: f.name,
        frame: { x: f.x, y: f.y, w: f.w, h: f.h },
        rotated: false,
        trimmed: f.w !== f.srcW || f.h !== f.srcH,
        spriteSourceSize: { x: f.trimX, y: f.trimY, w: f.w, h: f.h },
        sourceSize: { w: f.srcW, h: f.srcH },
      }));
      const metaObj = {
        app, version: '1.0', image: meta.image, format: 'RGBA8888',
        size: { w: meta.width, h: meta.height }, scale: String(meta.scale),
        frameTags: sheetAnimations(frames, meta.animationName).map(([name, from, to]) => ({ name, from, to, direction: 'forward' })), frameRate: meta.fps,
      };
      if (format === 'json-array') return { ext: 'json', text: JSON.stringify({ frames: entries, meta: metaObj }, null, 2) };
      const hash: Record<string, unknown> = {};
      for (const e of entries) { const { filename, ...rest } = e; hash[filename] = rest; }
      return { ext: 'json', text: JSON.stringify({ frames: hash, meta: metaObj }, null, 2) };
    }
    case 'phaser3': {
      return {
        ext: 'json',
        text: JSON.stringify({
          textures: [{
            image: meta.image, format: 'RGBA8888', size: { w: meta.width, h: meta.height }, scale: meta.scale,
            frames: frames.map((f) => ({
              filename: f.name, rotated: false, trimmed: f.w !== f.srcW || f.h !== f.srcH,
              sourceSize: { w: f.srcW, h: f.srcH }, spriteSourceSize: { x: f.trimX, y: f.trimY, w: f.w, h: f.h },
              frame: { x: f.x, y: f.y, w: f.w, h: f.h },
            })),
          }],
          meta: { app, version: '1.0', frameTags: sheetAnimations(frames, meta.animationName).map(([name, from, to]) => ({ name, from, to, direction: 'forward' })) },
        }, null, 2),
      };
    }
    case 'starling': {
      const lines = frames.map((f) => {
        const trimmed = f.w !== f.srcW || f.h !== f.srcH;
        const extra = trimmed ? ` frameX="${-f.trimX}" frameY="${-f.trimY}" frameWidth="${f.srcW}" frameHeight="${f.srcH}"` : '';
        return `  <SubTexture name="${xmlEsc(f.name)}" x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}"${extra}/>`;
      });
      return { ext: 'xml', text: `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Created with ${app} -->\n<TextureAtlas imagePath="${xmlEsc(meta.image)}">\n${lines.join('\n')}\n</TextureAtlas>\n` };
    }
    case 'easeljs': {
      const arr = frames.map((f) => { const r = f.reg ?? meta.registration; return [f.x, f.y, f.w, f.h, 0, Math.round(r.x - f.trimX), Math.round(r.y - f.trimY)]; });
      const animations: Record<string, { frames: number[] }> = {};
      for (const [name, from, to] of sheetAnimations(frames, meta.animationName)) {
        (animations[name] ??= { frames: [] }).frames.push(...Array.from({ length: to - from + 1 }, (_, k) => from + k));
      }
      return { ext: 'json', text: JSON.stringify({ images: [meta.image], framerate: meta.fps, frames: arr, animations }, null, 2) };
    }
    case 'cocos2d': {
      const items = frames.map((f) => {
        const ox = f.trimX + f.w / 2 - f.srcW / 2;
        const oy = -(f.trimY + f.h / 2 - f.srcH / 2);
        return `\t\t<key>${xmlEsc(f.name)}.png</key>\n\t\t<dict>\n\t\t\t<key>aliases</key>\n\t\t\t<array/>\n\t\t\t<key>spriteOffset</key>\n\t\t\t<string>{${ox},${oy}}</string>\n\t\t\t<key>spriteSize</key>\n\t\t\t<string>{${f.w},${f.h}}</string>\n\t\t\t<key>spriteSourceSize</key>\n\t\t\t<string>{${f.srcW},${f.srcH}}</string>\n\t\t\t<key>textureRect</key>\n\t\t\t<string>{{${f.x},${f.y}},{${f.w},${f.h}}}</string>\n\t\t\t<key>textureRotated</key>\n\t\t\t<false/>\n\t\t</dict>`;
      });
      return {
        ext: 'plist',
        text: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>frames</key>\n\t<dict>\n${items.join('\n')}\n\t</dict>\n\t<key>metadata</key>\n\t<dict>\n\t\t<key>format</key>\n\t\t<integer>3</integer>\n\t\t<key>pixelFormat</key>\n\t\t<string>RGBA8888</string>\n\t\t<key>premultiplyAlpha</key>\n\t\t<false/>\n\t\t<key>realTextureFileName</key>\n\t\t<string>${xmlEsc(meta.image)}</string>\n\t\t<key>size</key>\n\t\t<string>{${meta.width},${meta.height}}</string>\n\t\t<key>textureFileName</key>\n\t\t<string>${xmlEsc(meta.image)}</string>\n\t</dict>\n</dict>\n</plist>\n`,
      };
    }
    case 'css': {
      const idx = new Map<string, number>();
      const lines = frames.map((f) => { const a = f.anim ?? meta.animationName; const i = idx.get(a) ?? 0; idx.set(a, i + 1); return `.${a.replace(/[^\w-]+/g, '_')}-${i} {`; }).map((head, k) => { const f = frames[k]; return `${head} width: ${f.srcW}px; height: ${f.srcH}px; background: url("${meta.image}") ${-(f.x ?? 0) + f.trimX}px ${-(f.y ?? 0) + f.trimY}px no-repeat; }`; });
      return { ext: 'css', text: `/* ${app} sprite sheet: ${meta.image} */\n${lines.join('\n')}\n` };
    }
  }
}

/** Finds the bounding box of non-transparent pixels. */
export function trimBounds(data: Uint8ClampedArray, w: number, h: number): { x: number; y: number; w: number; h: number } {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 0) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function hashPixels(data: Uint8ClampedArray): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < data.length; i += 1) {
    h1 = Math.imul(h1 ^ data[i], 16777619);
    if ((i & 7) === 0) h2 = Math.imul(h2 ^ h1, 2246822519);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + data.length.toString(16);
}
