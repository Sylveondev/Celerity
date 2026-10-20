// Minimal, dependency-free ZIP reader/writer (store + deflate) built on the
// platform CompressionStream API (available in Electron/Chromium and Node 18+).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pump(stream: CompressionStream | DecompressionStream, data: Uint8Array): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  await writer.write(data as unknown as BufferSource);
  await writer.close();
  await readAll;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pump(new CompressionStream('deflate-raw' as CompressionFormat), data);
}
export function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pump(new DecompressionStream('deflate-raw' as CompressionFormat), data);
}
export function zlibDeflate(data: Uint8Array): Promise<Uint8Array> {
  return pump(new CompressionStream('deflate'), data);
}
export function zlibInflate(data: Uint8Array): Promise<Uint8Array> {
  return pump(new DecompressionStream('deflate'), data);
}

export interface ZipEntryIn { name: string; data: Uint8Array | string; store?: boolean }

const enc = new TextEncoder();

function dosDateTime(d = new Date()): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

export async function writeZip(entries: ZipEntryIn[]): Promise<Uint8Array> {
  const [time, date] = dosDateTime();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const nameBytes = enc.encode(e.name);
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    if (!e.store && raw.length > 64) {
      const comp = await deflateRaw(raw);
      if (comp.length < raw.length) { body = comp; method = 8; }
    }
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    parts.push(lh, body);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);
    offset += lh.length + body.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  let total = 0;
  for (const p of all) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

export interface ZipFile {
  names(): string[];
  has(name: string): boolean;
  read(name: string): Promise<Uint8Array>;
  readText(name: string): Promise<string>;
}

const dec = new TextDecoder();

export function isZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

export function readZip(data: Uint8Array): ZipFile {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP/FLA file (no central directory).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map<string, { method: number; csize: number; usize: number; local: number }>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const nameBytes = data.subarray(p + 46, p + 46 + nlen);
    const name = flags & 0x0800 ? dec.decode(nameBytes) : latin1(nameBytes);
    entries.set(name.replace(/\\/g, '/'), { method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  const lookup = (name: string) => {
    let e = entries.get(name);
    if (!e) {
      const lower = name.toLowerCase();
      for (const [k, v] of entries) if (k.toLowerCase() === lower) { e = v; break; }
    }
    return e;
  };
  return {
    names: () => [...entries.keys()],
    has: (name) => !!lookup(name),
    async read(name) {
      const e = lookup(name);
      if (!e) throw new Error(`Missing file in archive: ${name}`);
      const nlen = dv.getUint16(e.local + 26, true);
      const xlen = dv.getUint16(e.local + 28, true);
      const start = e.local + 30 + nlen + xlen;
      const body = data.subarray(start, start + e.csize);
      if (e.method === 0) return body.slice();
      if (e.method === 8) return inflateRaw(body);
      throw new Error(`Unsupported compression method ${e.method} for ${name}`);
    },
    async readText(name) {
      return dec.decode(await this.read(name));
    },
  };
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
