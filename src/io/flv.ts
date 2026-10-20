// FLV container parsing (embedded video in FLA files and SWF publishing).
export interface FlvVideo {
  width: number;
  height: number;
  fps: number;
  duration: number;            // seconds
  codec: number;               // 2 = Sorenson H.263, 3 = screen, 4 = VP6, 5 = VP6 alpha, 7 = AVC
  frames: { time: number; key: boolean; data: Uint8Array }[]; // data as SWF VideoFrame payload
}

export function isFlv(b: Uint8Array): boolean {
  return b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56;
}

/** Reads an AMF0 value (enough for onMetaData). */
function amf(dv: DataView, o: number): [unknown, number] {
  const t = dv.getUint8(o);
  o++;
  const str = (p: number): [string, number] => {
    const n = dv.getUint16(p);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p + 2 + i));
    return [s, p + 2 + n];
  };
  switch (t) {
    case 0: return [dv.getFloat64(o), o + 8];
    case 1: return [dv.getUint8(o) !== 0, o + 1];
    case 2: return str(o);
    case 3: case 8: {
      if (t === 8) o += 4;
      const obj: Record<string, unknown> = {};
      for (let guard = 0; guard < 10000 && o + 3 <= dv.byteLength; guard++) {
        const [k, o2] = str(o);
        if (!k && dv.getUint8(o2) === 9) return [obj, o2 + 1];
        const [v, o3] = amf(dv, o2);
        obj[k] = v;
        o = o3;
      }
      return [obj, o];
    }
    case 10: {
      const n = dv.getUint32(o);
      o += 4;
      const arr: unknown[] = [];
      for (let i = 0; i < n; i++) { const [v, o2] = amf(dv, o); arr.push(v); o = o2; }
      return [arr, o];
    }
    case 11: return [dv.getFloat64(o), o + 10];
    default: return [null, dv.byteLength];
  }
}

/** Sorenson H.263 picture size from the first frame header. */
function h263Size(d: Uint8Array): { w: number; h: number } | null {
  // PictureStartCode UB17, Version UB5, TemporalReference UB8, PictureSize UB3
  let pos = 0;
  const ub = (n: number) => { let v = 0; for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((d[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
  if (ub(17) !== 1) return null;
  ub(5); ub(8);
  const ps = ub(3);
  switch (ps) {
    case 0: return { w: ub(8), h: ub(8) };
    case 1: return { w: ub(16), h: ub(16) };
    case 2: return { w: 352, h: 288 };
    case 3: return { w: 176, h: 144 };
    case 4: return { w: 128, h: 96 };
    case 5: return { w: 320, h: 240 };
    case 6: return { w: 160, h: 120 };
  }
  return null;
}

export function parseFlv(b: Uint8Array): FlvVideo | null {
  if (!isFlv(b) || b.length < 13) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = dv.getUint32(5) + 4; // header size + PreviousTagSize0
  const v: FlvVideo = { width: 0, height: 0, fps: 0, duration: 0, codec: 0, frames: [] };
  while (o + 11 <= b.length) {
    const type = b[o] & 0x1f;
    const size = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    const ts = ((b[o + 7] << 24) | (b[o + 4] << 16) | (b[o + 5] << 8) | b[o + 6]) >>> 0;
    const body = o + 11;
    if (body + size > b.length) break;
    if (type === 18) {
      try {
        const sub = new DataView(b.buffer, b.byteOffset + body, size);
        const [name, p] = amf(sub, 0);
        if (name === 'onMetaData') {
          const [meta] = amf(sub, p) as [Record<string, number>, number];
          if (meta) {
            v.width = Number(meta.width) || v.width;
            v.height = Number(meta.height) || v.height;
            v.fps = Number(meta.framerate) || Number(meta.videoframerate) || v.fps;
            v.duration = Number(meta.duration) || v.duration;
          }
        }
      } catch { /* bad metadata */ }
    } else if (type === 9 && size > 1) {
      const h = b[body];
      const codec = h & 0x0f, frameType = h >> 4;
      if (frameType !== 5) {
        v.codec = codec;
        // SWF VideoFrame data: H.263 = tag data after the header byte; VP6 drops the size-adjustment byte
        const skip = codec === 4 || codec === 5 ? 2 : 1;
        v.frames.push({ time: ts / 1000, key: frameType === 1, data: b.slice(body + skip, body + size) });
      }
    }
    o = body + size + 4;
  }
  if (!v.width && v.codec === 2 && v.frames[0]) {
    const s = h263Size(v.frames[0].data);
    if (s) { v.width = s.w; v.height = s.h; }
  }
  if (!v.fps && v.frames.length > 1) {
    const span = v.frames[v.frames.length - 1].time - v.frames[0].time;
    v.fps = span > 0 ? Math.round(((v.frames.length - 1) / span) * 100) / 100 : 0;
  }
  if (!v.duration && v.fps) v.duration = v.frames.length / v.fps;
  return v;
}

/** Locates the playable stream inside an Animate video .dat (FLV, MP4/MOV or WebM behind a short header). */
export function splitVideoDat(bytes: Uint8Array): { prefix: Uint8Array; stream: Uint8Array; mime: string } {
  for (let i = 0; i <= Math.min(bytes.length - 4, 64); i++) {
    if (bytes[i] === 0x46 && bytes[i + 1] === 0x4c && bytes[i + 2] === 0x56 && bytes[i + 3] === 1) {
      return { prefix: bytes.slice(0, i), stream: bytes.subarray(i), mime: 'video/x-flv' };
    }
    if (bytes[i] === 0x66 && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x79 && bytes[i + 3] === 0x70 && i >= 4) {
      return { prefix: bytes.slice(0, i - 4), stream: bytes.subarray(i - 4), mime: 'video/mp4' };
    }
    if (bytes[i] === 0x1a && bytes[i + 1] === 0x45 && bytes[i + 2] === 0xdf && bytes[i + 3] === 0xa3) {
      return { prefix: bytes.slice(0, i), stream: bytes.subarray(i), mime: 'video/webm' };
    }
  }
  return { prefix: new Uint8Array(0), stream: bytes, mime: 'application/octet-stream' };
}

export function sniffVideo(b: Uint8Array): string | null {
  if (isFlv(b)) return 'video/x-flv';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49) return 'video/x-msvideo';
  return null;
}
