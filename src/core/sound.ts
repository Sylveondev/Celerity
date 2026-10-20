// Sound support: Flash/Animate sound formats, decoding helpers that need no
// browser APIs (raw PCM, ADPCM, WAV), resampling and the timeline mixdown used
// by video export and published SWFs.
import type { Doc, FrameSound, SoundItem, Timeline } from './types';

export const FLASH_RATES = [5512, 11025, 22050, 44100];

export interface FlashFormat { rate: number; bits: number; channels: number; adpcm: boolean }

/** Parses Animate's format strings: "44kHz 16bit Stereo", "22kHz 8bit Mono", "11kHz ADPCM 4bit Mono"… */
export function parseFlashFormat(fmt: string | undefined): FlashFormat {
  const s = fmt ?? '';
  const k = /(\d+(?:\.\d+)?)\s*kHz/i.exec(s);
  const kz = k ? Number(k[1]) : 44;
  const rate = kz >= 40 ? 44100 : kz >= 20 ? 22050 : kz >= 10 ? 11025 : 5512;
  const b = /(\d+)\s*bit/i.exec(s);
  return { rate, bits: b ? Number(b[1]) : 16, channels: /stereo/i.test(s) ? 2 : /mono/i.test(s) ? 1 : 2, adpcm: /adpcm/i.test(s) };
}

export function flashFormat(rate: number, channels: number): string {
  const r = nearestFlashRate(rate);
  const label = r === 44100 ? '44kHz' : r === 22050 ? '22kHz' : r === 11025 ? '11kHz' : '5kHz';
  return `${label} 16bit ${channels > 1 ? 'Stereo' : 'Mono'}`;
}

export function nearestFlashRate(rate: number): number {
  if (rate >= 33000) return 44100;
  if (rate >= 16500) return 22050;
  if (rate >= 8000) return 11025;
  return 5512;
}

export function isMp3(b: Uint8Array): boolean {
  return (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) || (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33);
}

export function sniffAudio(b: Uint8Array): string | null {
  if (isMp3(b)) return 'audio/mpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41) return 'audio/wav';
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg';
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4';
  if (b[0] === 0x46 && b[1] === 0x4f && b[2] === 0x52 && b[3] === 0x4d) return 'audio/aiff';
  return null;
}

/** Decoded audio: one Float32Array (-1..1) per channel. */
export interface Pcm { rate: number; channels: Float32Array[] }

export function pcmLength(p: Pcm) { return p.channels[0]?.length ?? 0; }

/** Raw little-endian PCM (8-bit unsigned or 16-bit signed, interleaved). */
export function decodeRawPcm(bytes: Uint8Array, bits: number, channels: number, rate: number, sampleCount?: number): Pcm {
  const bps = bits === 8 ? 1 : 2;
  let n = Math.floor(bytes.length / (bps * channels));
  if (sampleCount && sampleCount < n) n = sampleCount;
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bps;
      out[c][i] = bps === 1 ? (bytes[o] - 128) / 128 : dv.getInt16(o, true) / 32768;
    }
  }
  return { rate, channels: out };
}

const ADPCM_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
  1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];
const ADPCM_INDEX = [
  [-1, 2],
  [-1, -1, 2, 4],
  [-1, -1, -1, -1, 2, 4, 6, 8],
  [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16],
];

/** Flash ADPCM (SWF spec): 2-5 bit codes in packets of 4096 samples. */
export function decodeAdpcm(bytes: Uint8Array, channels: number, rate: number, sampleCount?: number): Pcm {
  let pos = 0; // bit position
  const total = bytes.length * 8;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const bit = (bytes[(pos >> 3)] >> (7 - (pos & 7))) & 1;
      v = (v << 1) | bit;
      pos++;
    }
    return v;
  };
  const bits = read(2) + 2;
  const table = ADPCM_INDEX[bits - 2];
  const signMask = 1 << (bits - 1);
  const k0 = 1 << (bits - 2);
  const out: number[][] = Array.from({ length: channels }, () => []);
  const pred = new Array(channels).fill(0), idx = new Array(channels).fill(0);
  while (total - pos >= 22 * channels) {
    for (let c = 0; c < channels; c++) {
      let s = read(16);
      if (s & 0x8000) s -= 0x10000;
      pred[c] = s;
      idx[c] = read(6);
      out[c].push(s);
    }
    for (let i = 0; i < 4095 && total - pos >= bits * channels; i++) {
      for (let c = 0; c < channels; c++) {
        const code = read(bits);
        let step = ADPCM_STEPS[idx[c]];
        let vp = 0;
        for (let k = k0; k; k >>= 1) {
          if (code & k) vp += step;
          step >>= 1;
        }
        vp += step;
        pred[c] = Math.max(-32768, Math.min(32767, code & signMask ? pred[c] - vp : pred[c] + vp));
        idx[c] = Math.max(0, Math.min(88, idx[c] + table[code & ~signMask]));
        out[c].push(pred[c]);
      }
    }
  }
  const n = sampleCount ? Math.min(sampleCount, out[0].length) : out[0].length;
  return { rate, channels: out.map((a) => Float32Array.from(a.slice(0, n), (v) => v / 32768)) };
}

/** Parses a WAV file (PCM 8/16/24/32-bit or 32/64-bit float). */
export function parseWav(b: Uint8Array): Pcm | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt: { format: number; ch: number; rate: number; bits: number } | null = null;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = tag(o), size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, ch: dv.getUint16(body + 2, true), rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data' && fmt) {
      const len = Math.min(size, b.length - body);
      const bps = fmt.bits / 8;
      const n = Math.floor(len / (bps * fmt.ch));
      const chans = Array.from({ length: fmt.ch }, () => new Float32Array(n));
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < fmt.ch; c++) {
          const p = body + (i * fmt.ch + c) * bps;
          let v = 0;
          if (fmt.format === 3) v = fmt.bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
          else if (fmt.bits === 8) v = (b[p] - 128) / 128;
          else if (fmt.bits === 16) v = dv.getInt16(p, true) / 32768;
          else if (fmt.bits === 24) { let x = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); if (x & 0x800000) x -= 0x1000000; v = x / 8388608; }
          else if (fmt.bits === 32) v = dv.getInt32(p, true) / 2147483648;
          chans[c][i] = v;
        }
      }
      if (fmt.format !== 1 && fmt.format !== 3) return null;
      return { rate: fmt.rate, channels: chans };
    }
    o = body + size + (size & 1);
  }
  return null;
}

/** Linear resampling (good enough for preview and export of game/animation audio). */
export function resample(p: Pcm, rate: number): Pcm {
  if (p.rate === rate) return p;
  const n = pcmLength(p);
  const m = Math.max(1, Math.round((n * rate) / p.rate));
  const ratio = p.rate / rate;
  return {
    rate,
    channels: p.channels.map((ch) => {
      const out = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const x = i * ratio;
        const i0 = Math.floor(x), f = x - i0;
        const a = ch[Math.min(i0, n - 1)] ?? 0, c = ch[Math.min(i0 + 1, n - 1)] ?? 0;
        out[i] = a + (c - a) * f;
      }
      return out;
    }),
  };
}

/** Interleaved 16-bit little-endian PCM. */
export function toPcm16(p: Pcm, channels = p.channels.length): Uint8Array {
  const n = pcmLength(p);
  const out = new Uint8Array(n * channels * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const src = p.channels[Math.min(c, p.channels.length - 1)];
      const v = Math.max(-1, Math.min(1, src[i]));
      dv.setInt16((i * channels + c) * 2, Math.round(v < 0 ? v * 32768 : v * 32767), true);
    }
  }
  return out;
}

export function encodeWav(p: Pcm): Uint8Array {
  const ch = p.channels.length;
  const data = toPcm16(p);
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + data.length, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, p.rate, true); dv.setUint32(28, p.rate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** Converts decoded audio into Flash-friendly 16-bit PCM at a Flash sample rate. */
export function toFlashPcm(p: Pcm): { bytes: Uint8Array; format: string; sampleCount: number; pcm: Pcm } {
  const rate = nearestFlashRate(p.rate);
  const r = resample({ rate: p.rate, channels: p.channels.slice(0, 2) }, rate);
  return { bytes: toPcm16(r), format: flashFormat(rate, r.channels.length), sampleCount: pcmLength(r), pcm: r };
}

/** Decodes a library sound without browser APIs (raw PCM, ADPCM, WAV); MP3 etc. return null. */
export function decodeSoundBytes(item: SoundItem, bytes: Uint8Array): Pcm | null {
  if (item.codec === 'pcm' || item.codec === 'adpcm') {
    const f = parseFlashFormat(item.format);
    return f.adpcm || item.codec === 'adpcm'
      ? decodeAdpcm(bytes, f.channels, f.rate, item.sampleCount || undefined)
      : decodeRawPcm(bytes, f.bits, f.channels, f.rate, item.sampleCount || undefined);
  }
  if (sniffAudio(bytes) === 'audio/wav') return parseWav(bytes);
  return null;
}

// ---------------------------------------------------------------------------
// Timeline sound events and mixdown
// ---------------------------------------------------------------------------
export interface SoundEvent extends FrameSound {
  start: number;   // frame (global, across the listed scenes)
  end: number;     // end of the keyframe span (exclusive) - stream sounds stop here
  layer: string;
}

/** Sounds attached to keyframes of the given timelines (played one after another). */
export function soundEvents(timelines: Timeline[], lengths: number[]): SoundEvent[] {
  const out: SoundEvent[] = [];
  let offset = 0;
  timelines.forEach((tl, i) => {
    for (const l of tl.layers) {
      if (l.type === 'folder' || l.type === 'guide') continue;
      for (const f of l.frames) if (f.sound && f.sound.name) out.push({ ...f.sound, start: offset + f.start, end: offset + f.start + f.duration, layer: l.id });
    }
    offset += lengths[i];
  });
  return out.sort((a, b) => a.start - b.start);
}

export interface SoundInstance { ev: SoundEvent; from: number; to: number } // seconds on the movie clock

/** Resolves sync modes (event/start/stop/stream) and loops into playing instances. */
export function soundSchedule(events: SoundEvent[], fps: number, durationOf: (name: string) => number, movieEnd: number): SoundInstance[] {
  const inst: SoundInstance[] = [];
  for (const ev of events) {
    const t = ev.start / fps;
    if (ev.sync === 'stop') {
      for (const s of inst) if (s.ev.name === ev.name && s.from <= t && s.to > t) s.to = t;
      continue;
    }
    const d = durationOf(ev.name);
    if (!(d > 0)) continue;
    if (ev.sync === 'start' && inst.some((s) => s.ev.name === ev.name && s.from <= t && s.to > t)) continue;
    const loops = ev.loopMode === 'loop' ? Infinity : Math.max(1, ev.loops || 1);
    let to = t + d * (loops === Infinity ? Math.ceil((movieEnd - t) / d) + 1 : loops);
    if (ev.sync === 'stream') to = Math.min(to, ev.end / fps);
    to = Math.min(to, movieEnd);
    if (to > t) inst.push({ ev, from: t, to });
  }
  return inst;
}

/**
 * Mixes the movie's sounds into stereo at `rate`. `decoded` maps sound names to
 * decoded audio. `frames` is the movie length.
 */
export function mixdown(events: SoundEvent[], decoded: Map<string, Pcm>, fps: number, frames: number, rate = 44100): Pcm {
  const movieEnd = frames / fps;
  const n = Math.max(1, Math.ceil(movieEnd * rate));
  const L = new Float32Array(n), R = new Float32Array(n);
  const res = new Map<string, Pcm>();
  const get = (name: string) => {
    let p = res.get(name);
    if (!p) { const src = decoded.get(name); if (!src) return null; p = resample(src, rate); res.set(name, p); }
    return p;
  };
  const inst = soundSchedule(events, fps, (name) => { const p = decoded.get(name); return p ? pcmLength(p) / p.rate : 0; }, movieEnd);
  for (const s of inst) {
    const p = get(s.ev.name);
    if (!p) continue;
    const len = pcmLength(p);
    const l = p.channels[0], r = p.channels[1] ?? p.channels[0];
    const a = Math.round(s.from * rate), b = Math.min(n, Math.round(s.to * rate));
    for (let i = a; i < b; i++) {
      const k = (i - a) % len;
      L[i] += l[k]; R[i] += r[k];
    }
  }
  for (let i = 0; i < n; i++) { L[i] = Math.max(-1, Math.min(1, L[i])); R[i] = Math.max(-1, Math.min(1, R[i])); }
  return { rate, channels: [L, R] };
}

/** Peak envelope for timeline waveforms: `buckets` max-abs values (0..1). */
export function peaks(p: Pcm, buckets: number): Float32Array {
  const n = pcmLength(p);
  const out = new Float32Array(buckets);
  if (!n) return out;
  const step = n / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const a = Math.floor(b * step), e = Math.min(n, Math.floor((b + 1) * step));
    for (const ch of p.channels) for (let i = a; i < e; i += 4) { const v = Math.abs(ch[i]); if (v > m) m = v; }
    out[b] = m;
  }
  return out;
}

export function docTimelines(doc: Doc): Timeline[] { return doc.scenes; }
