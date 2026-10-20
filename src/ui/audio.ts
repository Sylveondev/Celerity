// Audio engine: decodes library sounds, plays timeline sounds with the stage
// and Test Movie, renders waveforms and mixes soundtracks for export.
import type { FrameSound, Layer, SoundItem, Timeline } from '../core/types';
import { decodeSoundBytes, mixdown, peaks, pcmLength, soundEvents, soundSchedule, encodeWav, sniffAudio, parseWav, toFlashPcm, flashFormat, type Pcm } from '../core/sound';
import { itemId, uniqueName } from '../core/util';
import { platform } from './platform';
import { frameAt, insertKeyframe, timelineFrameCount } from '../core/timeline';
import { store } from './state';

class AudioEngine {
  private ctx: AudioContext | null = null;
  private decoded = new Map<string, Promise<Pcm | null>>(); // by asset id
  private ready = new Map<string, Pcm | null>();
  private buffers = new Map<string, AudioBuffer>();
  private peakCache = new Map<string, Float32Array>();
  private playing: AudioBufferSourceNode[] = [];
  /** Called when a sound finished decoding (timeline waveforms redraw). */
  onDecoded: (() => void) | null = null;
  private once: (() => void)[] = [];
  onDecodedOnce(fn: () => void) { this.once.push(fn); }
  private notify() {
    this.onDecoded?.();
    const fns = this.once; this.once = [];
    for (const f of fns) f();
  }

  context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    return this.ctx;
  }

  /** Decodes a library sound (cached). */
  decode(item: SoundItem): Promise<Pcm | null> {
    let p = this.decoded.get(item.assetId);
    if (p) return p;
    p = (async () => {
      const asset = store.assets.get(item.assetId);
      if (!asset) return null;
      let pcm = decodeSoundBytes(item, asset.bytes);
      if (!pcm) pcm = await this.decodeWithBrowser(asset.bytes);
      this.ready.set(item.assetId, pcm);
      this.notify();
      return pcm;
    })().catch((e) => { console.warn('Sound decode failed', item.name, e); this.ready.set(item.assetId, null); return null; });
    this.decoded.set(item.assetId, p);
    return p;
  }

  async decodeWithBrowser(bytes: Uint8Array): Promise<Pcm | null> {
    const ctx = this.context();
    if (!ctx) return null;
    const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    return { rate: buf.sampleRate, channels: Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice()) };
  }

  /** Decoded audio if it is ready (starts decoding otherwise). */
  peek(item: SoundItem): Pcm | null {
    if (!this.ready.has(item.assetId)) { void this.decode(item); return null; }
    return this.ready.get(item.assetId) ?? null;
  }

  peaksOf(item: SoundItem, buckets = 2048): Float32Array | null {
    const key = `${item.assetId}:${buckets}`;
    const hit = this.peakCache.get(key);
    if (hit) return hit;
    if (this.ready.has(item.assetId) && !this.ready.get(item.assetId)) return new Float32Array(0); // undecodable
    const p = this.peek(item);
    if (!p) return null;
    const pk = peaks(p, buckets);
    this.peakCache.set(key, pk);
    return pk;
  }

  durationOf(item: SoundItem): number {
    const p = this.peek(item);
    if (p) return pcmLength(p) / p.rate;
    return 0;
  }

  private bufferOf(item: SoundItem, pcm: Pcm): AudioBuffer | null {
    const ctx = this.context();
    if (!ctx) return null;
    let b = this.buffers.get(item.assetId);
    if (b) return b;
    const n = Math.max(1, pcmLength(pcm));
    b = ctx.createBuffer(pcm.channels.length, n, pcm.rate);
    pcm.channels.forEach((ch, i) => b!.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
    this.buffers.set(item.assetId, b);
    return b;
  }

  stop() {
    for (const s of this.playing) { try { s.stop(); } catch { /* already stopped */ } }
    this.playing = [];
  }

  /** Plays a library sound once (library preview). */
  async preview(item: SoundItem) {
    this.stop();
    const pcm = await this.decode(item);
    const ctx = this.context();
    if (!pcm || !ctx) return;
    await ctx.resume().catch(() => {});
    const buf = this.bufferOf(item, pcm);
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    this.playing.push(src);
  }

  /** Starts the timeline's sounds as if playback began at `frame`. */
  async playTimeline(tl: Timeline, frame: number, fps: number) {
    this.stop();
    const ctx = this.context();
    if (!ctx) return;
    const len = timelineFrameCount(tl);
    const events = soundEvents([tl], [len]);
    if (!events.length) return;
    await Promise.all(events.map((e) => { const it = store.lib.get(e.name); return it?.kind === 'sound' ? this.decode(it) : null; }));
    await ctx.resume().catch(() => {});
    const now = ctx.currentTime + 0.02;
    const t0 = frame / fps;
    const inst = soundSchedule(events, fps, (name) => { const it = store.lib.get(name); return it?.kind === 'sound' ? this.durationOf(it) : 0; }, len / fps);
    for (const s of inst) {
      if (s.to <= t0) continue;
      if (s.from < t0 && s.ev.sync !== 'stream') continue; // event sounds that already started are not replayed
      const it = store.lib.get(s.ev.name);
      if (it?.kind !== 'sound') continue;
      const pcm = this.ready.get(it.assetId);
      if (!pcm) continue;
      const buf = this.bufferOf(it, pcm);
      if (!buf) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = s.to - s.from > buf.duration + 1e-3;
      src.connect(ctx.destination);
      const startAt = now + Math.max(0, s.from - t0);
      const offset = s.from < t0 ? (t0 - s.from) % buf.duration : 0;
      src.start(startAt, offset);
      src.stop(now + (s.to - t0));
      this.playing.push(src);
    }
  }

  /** Mixes the soundtrack of frames [f0, f1] of a timeline into a WAV file (null when silent). */
  async soundtrack(tl: Timeline, f0: number, f1: number, fps: number): Promise<Uint8Array | null> {
    const len = timelineFrameCount(tl);
    const events = soundEvents([tl], [len]);
    if (!events.length) return null;
    const decoded = new Map<string, Pcm>();
    for (const e of events) {
      const it = store.lib.get(e.name);
      if (it?.kind !== 'sound' || decoded.has(e.name)) continue;
      const p = await this.decode(it);
      if (p) decoded.set(e.name, p);
    }
    if (!decoded.size) return null;
    const full = mixdown(events, decoded, fps, f1 + 1);
    const a = Math.round((f0 / fps) * full.rate), b = Math.round(((f1 + 1) / fps) * full.rate);
    return encodeWav({ rate: full.rate, channels: full.channels.map((c) => c.slice(a, b)) });
  }

  /** Decoded audio for every sound used by a timeline (SWF publishing). */
  async decodeAll(names: string[]): Promise<Map<string, Pcm>> {
    const out = new Map<string, Pcm>();
    for (const n of names) {
      const it = store.lib.get(n);
      if (it?.kind !== 'sound') continue;
      const p = await this.decode(it);
      if (p) out.set(n, p);
    }
    return out;
  }

  forget(assetId: string) {
    this.decoded.delete(assetId); this.ready.delete(assetId); this.buffers.delete(assetId);
    for (const k of [...this.peakCache.keys()]) if (k.startsWith(assetId + ':')) this.peakCache.delete(k);
  }
}

export const audio = new AudioEngine();

/** Attaches a library sound to the current keyframe of the current layer (drag to stage). */
export function attachSound(name: string, layer: Layer | null = store.layer()) {
  if (!layer || layer.type === 'folder') { store.flash('Select a layer to add the sound to.'); return; }
  store.transact('Add Sound', () => {
    const f = store.frame;
    // sounds live on the keyframe of the span under the playhead (a blank keyframe past the end)
    const fr = frameAt(layer, f) ?? insertKeyframe(layer, f, true);
    const s: FrameSound = { name, sync: 'event', loopMode: 'repeat', loops: 1 };
    fr.sound = s;
  });
}

/** Creates a library sound from an audio file. MP3 is kept as is; everything else becomes 16-bit PCM like Animate stores WAV. */
export async function addSoundFile(name: string, bytes: Uint8Array): Promise<SoundItem | null> {
  const kind = sniffAudio(bytes);
  if (!kind) return null;
  let pcm: Pcm | null = null;
  if (kind === 'audio/mpeg') {
    pcm = await audio.decodeWithBrowser(bytes).catch(() => null);
    const asset = store.assets.addRaw(bytes, 'audio/mpeg');
    const item: SoundItem = {
      kind: 'sound', name: uniqueName(store.libraryNames(), name), itemID: itemId(), assetId: asset.id, codec: 'mp3',
      format: flashFormat(pcm?.rate ?? 44100, pcm?.channels.length ?? 2), sampleCount: pcm ? pcmLength(pcm) : 0,
    };
    return item;
  }
  if (kind === 'audio/wav') pcm = parseWav(bytes);
  if (!pcm) pcm = await audio.decodeWithBrowser(bytes).catch(() => null);
  if (!pcm && platform.media) {
    const r = await platform.media.transcode(bytes, 'wav');
    if (r.ok && r.bytes) pcm = parseWav(r.bytes);
  }
  if (!pcm) return null;
  const f = toFlashPcm(pcm);
  const asset = store.assets.addRaw(f.bytes, 'audio/x-flash-pcm');
  return { kind: 'sound', name: uniqueName(store.libraryNames(), name), itemID: itemId(), assetId: asset.id, codec: 'pcm', format: f.format, sampleCount: f.sampleCount };
}
