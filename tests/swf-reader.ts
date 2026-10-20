// Minimal SWF reader used by tests to validate the publisher's output bit-exactly.
import { inflateSync } from 'node:zlib';

export class BitReader {
  pos = 0; bit = 0;
  constructor(public b: Uint8Array) {}
  align() { if (this.bit) { this.bit = 0; this.pos++; } }
  ub(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.b.length) throw new Error('read past end');
      const bitv = (this.b[this.pos] >> (7 - this.bit)) & 1;
      v = v * 2 + bitv;
      this.bit++;
      if (this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  }
  sb(n: number): number { if (!n) return 0; const v = this.ub(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  u8() { this.align(); return this.b[this.pos++]; }
  u16() { this.align(); const v = this.b[this.pos] | (this.b[this.pos + 1] << 8); this.pos += 2; return v; }
  u32() { return (this.u16() | (this.u16() << 16)) >>> 0; }
  str() { this.align(); let s = ''; while (this.b[this.pos]) s += String.fromCharCode(this.b[this.pos++]); this.pos++; return s; }
}

export function readRect(r: BitReader) {
  r.align();
  const n = r.ub(5);
  const v = [r.sb(n), r.sb(n), r.sb(n), r.sb(n)];
  r.align();
  return { xmin: v[0], xmax: v[1], ymin: v[2], ymax: v[3] };
}

export function readMatrix(r: BitReader) {
  r.align();
  let a = 1, d = 1, b = 0, c = 0;
  if (r.ub(1)) { const n = r.ub(5); a = r.sb(n) / 65536; d = r.sb(n) / 65536; }
  if (r.ub(1)) { const n = r.ub(5); b = r.sb(n) / 65536; c = r.sb(n) / 65536; }
  const n = r.ub(5);
  const tx = r.sb(n), ty = r.sb(n);
  r.align();
  return { a, b, c, d, tx: tx / 20, ty: ty / 20 };
}

function readCxform(r: BitReader) {
  r.align();
  const hasAdd = r.ub(1), hasMul = r.ub(1), n = r.ub(4);
  const mul = hasMul ? [r.sb(n), r.sb(n), r.sb(n), r.sb(n)] : [256, 256, 256, 256];
  const add = hasAdd ? [r.sb(n), r.sb(n), r.sb(n), r.sb(n)] : [0, 0, 0, 0];
  r.align();
  return { mul, add };
}

function readFillStyles(r: BitReader) {
  let n = r.u8();
  if (n === 0xff) n = r.u16();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = r.u8();
    if (t === 0) { r.pos += 4; out.push('solid'); }
    else if (t === 0x10 || t === 0x12) {
      readMatrix(r);
      r.align();
      r.ub(2); r.ub(2); const g = r.ub(4);
      r.align();
      r.pos += g * 5;
      out.push(t === 0x10 ? 'linear' : 'radial');
    } else if (t >= 0x40 && t <= 0x43) { r.u16(); readMatrix(r); out.push('bitmap'); }
    else throw new Error('unknown fill type ' + t);
  }
  return out;
}

function readLineStyles2(r: BitReader) {
  let n = r.u8();
  if (n === 0xff) n = r.u16();
  for (let i = 0; i < n; i++) {
    r.u16();
    r.align();
    r.ub(2); const join = r.ub(2); const hasFill = r.ub(1); r.ub(3); r.ub(5); r.ub(1); r.ub(2);
    r.align();
    if (join === 2) r.u16();
    if (hasFill) throw new Error('fill lines not expected'); else r.pos += 4;
  }
  return n;
}

export interface ShapeInfo { id: number; edges: number; moves: number; styles: number; minX: number; maxX: number; minY: number; maxY: number }

export function readShape4(body: Uint8Array): ShapeInfo {
  const r = new BitReader(body);
  const id = r.u16();
  readRect(r); readRect(r);
  r.u8();
  let fills = readFillStyles(r).length;
  let lines = readLineStyles2(r);
  r.align();
  let fillBits = r.ub(4), lineBits = r.ub(4);
  let x = 0, y = 0, edges = 0, moves = 0, styles = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const track = () => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (;;) {
    const type = r.ub(1);
    if (type === 0) {
      const flags = r.ub(5);
      if (flags === 0) break;
      if (flags & 1) { const n = r.ub(5); x = r.sb(n); y = r.sb(n); moves++; track(); }
      if (flags & 2) { const v = r.ub(fillBits); if (v > fills) throw new Error(`fill0 index ${v} > ${fills}`); }
      if (flags & 4) { const v = r.ub(fillBits); if (v > fills) throw new Error(`fill1 index ${v} > ${fills}`); }
      if (flags & 8) { const v = r.ub(lineBits); if (v > lines) throw new Error(`line index ${v} > ${lines}`); }
      if (flags & 16) {
        r.align();
        fills = readFillStyles(r).length;
        lines = readLineStyles2(r);
        r.align();
        fillBits = r.ub(4); lineBits = r.ub(4);
        styles++;
      }
    } else {
      const straight = r.ub(1);
      const n = r.ub(4) + 2;
      if (straight) {
        if (r.ub(1)) { x += r.sb(n); y += r.sb(n); }
        else if (r.ub(1)) y += r.sb(n); else x += r.sb(n);
      } else {
        x += r.sb(n); y += r.sb(n); x += r.sb(n); y += r.sb(n);
      }
      edges++;
      track();
    }
  }
  return { id, edges, moves, styles, minX: minX / 20, maxX: maxX / 20, minY: minY / 20, maxY: maxY / 20 };
}

export interface SwfInfo {
  version: number; width: number; height: number; fps: number; frames: number;
  tags: { code: number; len: number }[];
  shapes: ShapeInfo[];
  places: { depth: number; char?: number; move: boolean; matrix?: ReturnType<typeof readMatrix>; clipDepth?: number; name?: string; filters?: number[]; blend?: number }[];
  sprites: { id: number; frames: number; tags: number[] }[];
  showFrames: number;
  labels: string[];
  actions: number;
}

function readTags(b: Uint8Array, start: number, end: number, info: SwfInfo, inSprite: number[] | null) {
  let p = start;
  while (p < end) {
    const hdr = b[p] | (b[p + 1] << 8);
    p += 2;
    const code = hdr >> 6;
    let len = hdr & 0x3f;
    if (len === 0x3f) { len = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4; }
    const body = b.subarray(p, p + len);
    if (p + len > end) throw new Error(`tag ${code} overruns (${p + len} > ${end})`);
    if (inSprite) inSprite.push(code); else info.tags.push({ code, len });
    if (code === 83) info.shapes.push(readShape4(body));
    if (code === 26) {
      const r = new BitReader(body);
      const flags = r.u8();
      const depth = r.u16();
      const pl: SwfInfo['places'][number] = { depth, move: !!(flags & 1) };
      if (flags & 2) pl.char = r.u16();
      if (flags & 4) pl.matrix = readMatrix(r);
      if (flags & 8) readCxform(r);
      if (flags & 16) r.u16();
      if (flags & 32) pl.name = r.str();
      if (flags & 64) pl.clipDepth = r.u16();
      if (r.pos !== body.length) throw new Error(`PlaceObject2 length mismatch ${r.pos} != ${body.length}`);
      info.places.push(pl);
    }
    if (code === 70) {
      const r = new BitReader(body);
      const f1 = r.u8(), f2 = r.u8();
      const depth = r.u16();
      if (f2 & 8) r.str();
      const pl: SwfInfo['places'][number] = { depth, move: !!(f1 & 1) };
      if (f1 & 2) pl.char = r.u16();
      if (f1 & 4) pl.matrix = readMatrix(r);
      if (f1 & 8) readCxform(r);
      if (f1 & 16) r.u16();
      if (f1 & 32) pl.name = r.str();
      if (f1 & 64) pl.clipDepth = r.u16();
      if (f2 & 1) {
        const n = r.u8();
        pl.filters = [];
        for (let i = 0; i < n; i++) {
          const id = r.u8();
          pl.filters.push(id);
          if (id === 0) r.pos += 4 + 16 + 2 + 1;
          else if (id === 1) r.pos += 8 + 1;
          else if (id === 2) r.pos += 4 + 8 + 2 + 1;
          else throw new Error('unexpected filter ' + id);
        }
      }
      if (f2 & 2) pl.blend = r.u8();
      if (r.pos !== body.length) throw new Error(`PlaceObject3 length mismatch ${r.pos} != ${body.length}`);
      info.places.push(pl);
    }
    if (code === 1 && !inSprite) info.showFrames++;
    if (code === 43) info.labels.push(new BitReader(body).str());
    if (code === 12) info.actions++;
    if (code === 39) {
      const id = body[0] | (body[1] << 8), frames = body[2] | (body[3] << 8);
      const tags: number[] = [];
      readTags(b, p + 4, p + len, info, tags);
      info.sprites.push({ id, frames, tags });
    }
    p += len;
    if (code === 0) break;
  }
}

export function readSwf(data: Uint8Array): SwfInfo {
  const sig = String.fromCharCode(data[0], data[1], data[2]);
  const version = data[3];
  const total = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
  let body = data.subarray(8);
  if (sig === 'CWS') body = new Uint8Array(inflateSync(body));
  else if (sig !== 'FWS') throw new Error('bad signature ' + sig);
  if (body.length + 8 !== total) throw new Error(`length mismatch: header ${total}, actual ${body.length + 8}`);
  const r = new BitReader(body);
  const rect = readRect(r);
  const fps = r.u16() / 256;
  const frames = r.u16();
  const info: SwfInfo = { version, width: rect.xmax / 20, height: rect.ymax / 20, fps, frames, tags: [], shapes: [], places: [], sprites: [], showFrames: 0, labels: [], actions: 0 };
  readTags(body, r.pos, body.length, info, null);
  return info;
}
