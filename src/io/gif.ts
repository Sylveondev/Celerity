// Animated GIF encoder (global median-cut palette + LZW), no dependencies.

interface Box { pixels: number[]; rMin: number; rMax: number; gMin: number; gMax: number; bMin: number; bMax: number }

function boxFor(pixels: number[]): Box {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  for (const p of pixels) {
    const r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  return { pixels, rMin, rMax, gMin, gMax, bMin, bMax };
}

/** Median-cut quantization of packed 0xRRGGBB samples into at most n colors. */
export function medianCut(samples: number[], n: number): number[] {
  if (samples.length === 0) return [0];
  const unique = [...new Set(samples)];
  if (unique.length <= n) return unique;
  const boxes: Box[] = [boxFor(samples)];
  while (boxes.length < n) {
    let bi = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.pixels.length < 2) continue;
      const range = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin) * Math.log2(b.pixels.length + 1);
      if (range > best) { best = range; bi = i; }
    }
    if (bi < 0) break;
    const b = boxes[bi];
    const rr = b.rMax - b.rMin, gr = b.gMax - b.gMin, br = b.bMax - b.bMin;
    const shift = rr >= gr && rr >= br ? 16 : gr >= br ? 8 : 0;
    b.pixels.sort((x, y) => ((x >> shift) & 255) - ((y >> shift) & 255));
    const mid = b.pixels.length >> 1;
    boxes.splice(bi, 1, boxFor(b.pixels.slice(0, mid)), boxFor(b.pixels.slice(mid)));
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const p of b.pixels) { r += (p >> 16) & 255; g += (p >> 8) & 255; bl += p & 255; }
    const k = b.pixels.length || 1;
    return (Math.round(r / k) << 16) | (Math.round(g / k) << 8) | Math.round(bl / k);
  });
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const out: number[] = [];
  let cur = 0, curBits = 0;
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map<number, number>();
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 255); cur >>>= 8; curBits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) { prefix = found; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  if (next >= 1 << codeSize && codeSize < 12) codeSize++;
  emit(eoi);
  if (curBits > 0) out.push(cur & 255);
  // sub-blocks
  const blocks: number[] = [minCodeSize];
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    blocks.push(n);
    for (let k = 0; k < n; k++) blocks.push(out[i + k]);
  }
  blocks.push(0);
  return Uint8Array.from(blocks);
}

export interface GifFrame { data: Uint8ClampedArray } // RGBA, width*height*4

export function encodeGif(width: number, height: number, frames: GifFrame[], fps: number, opts: { loop?: number; transparent?: boolean } = {}): Uint8Array {
  const transparent = opts.transparent ?? false;
  // sample colors across frames
  const samples: number[] = [];
  const target = 60000;
  const total = frames.length * width * height;
  const step = Math.max(1, Math.floor(total / target));
  let idx = 0;
  for (const f of frames) {
    for (let i = 0; i < width * height; i++, idx++) {
      if (idx % step) continue;
      const a = f.data[i * 4 + 3];
      if (transparent && a < 128) continue;
      samples.push((f.data[i * 4] << 16) | (f.data[i * 4 + 1] << 8) | f.data[i * 4 + 2]);
    }
  }
  const palette = medianCut(samples, transparent ? 255 : 256);
  const offset = transparent ? 1 : 0;
  const pal = new Uint8Array(256 * 3);
  palette.forEach((c, i) => {
    pal[(i + offset) * 3] = (c >> 16) & 255;
    pal[(i + offset) * 3 + 1] = (c >> 8) & 255;
    pal[(i + offset) * 3 + 2] = c & 255;
  });
  const cache = new Map<number, number>();
  const nearest = (c: number) => {
    const hit = cache.get(c);
    if (hit !== undefined) return hit;
    const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    let best = 0, bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - ((p >> 16) & 255), dg = g - ((p >> 8) & 255), db = b - (p & 255);
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    const v = best + offset;
    if (cache.size < 1 << 20) cache.set(c, v);
    return v;
  };

  const out: number[] = [];
  const push = (...b: number[]) => { for (const x of b) out.push(x & 255); };
  const u16 = (v: number) => push(v & 255, v >> 8);
  for (const ch of 'GIF89a') out.push(ch.charCodeAt(0));
  u16(width); u16(height);
  push(0xf7, 0, 0); // global color table, 8 bits/channel, 256 entries
  for (let i = 0; i < pal.length; i++) out.push(pal[i]);
  // NETSCAPE loop extension
  push(0x21, 0xff, 0x0b);
  for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0));
  push(0x03, 0x01);
  u16(opts.loop ?? 0);
  push(0x00);
  let acc = 0;
  for (const f of frames) {
    acc += 100 / fps;
    const delay = Math.max(2, Math.round(acc));
    acc -= delay;
    // graphic control extension
    push(0x21, 0xf9, 0x04, transparent ? (2 << 2) | 1 : (1 << 2), delay & 255, delay >> 8, 0, 0);
    push(0x2c);
    u16(0); u16(0); u16(width); u16(height);
    push(0);
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const a = f.data[i * 4 + 3];
      if (transparent && a < 128) { indices[i] = 0; continue; }
      indices[i] = nearest((f.data[i * 4] << 16) | (f.data[i * 4 + 1] << 8) | f.data[i * 4 + 2]);
    }
    const enc = lzwEncode(indices, 8);
    for (let i = 0; i < enc.length; i++) out.push(enc[i]);
  }
  push(0x3b);
  return Uint8Array.from(out);
}
