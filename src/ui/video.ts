// Embedded video: import, frame decoding for the stage/exports, placement.
import type { Element, VideoItem } from '../core/types';
import { frameAt, insertFrames } from '../core/timeline';
import { translate } from '../core/matrix';
import { itemId, uid, uniqueName } from '../core/util';
import { parseFlv, sniffVideo } from '../io/flv';
import { store } from './state';
import { platform } from './platform';
import { toast } from './dom';

const MAX_FRAMES = 240; // decoded frames kept in memory

class VideoEngine {
  private sources = new Map<string, Promise<HTMLVideoElement | null>>();
  private preview = new Map<string, { bytes: Uint8Array; mime: string }>();
  private frames = new Map<string, ImageBitmap>();
  private pending = new Map<string, Promise<void>>();
  private chain = new Map<string, Promise<unknown>>();
  onFrame: (() => void) | null = null;
  private missed = false;

  /** True if a render since the last call drew a placeholder or an older frame. */
  consumeMissed() { const m = this.missed; this.missed = false; return m; }

  /** Waits for every frame decode in flight. */
  async settle() { await Promise.all([...this.pending.values()]); }

  /** Bytes the browser can decode for an asset (e.g. the original MP4 of a video stored as FLV). */
  setPreview(assetId: string, bytes: Uint8Array, mime: string) { this.preview.set(assetId, { bytes, mime }); }

  frameCount(item: VideoItem) { return Math.max(1, Math.round(item.duration * (item.fps || store.doc.fps))); }

  frameIndex(item: VideoItem, offset: number): number {
    const t = offset / (store.doc.fps || 24);
    return Math.max(0, Math.min(this.frameCount(item) - 1, Math.floor(t * (item.fps || store.doc.fps) + 1e-6)));
  }

  private source(item: VideoItem): Promise<HTMLVideoElement | null> {
    let p = this.sources.get(item.assetId);
    if (p) return p;
    p = (async () => {
      const asset = store.assets.get(item.assetId);
      if (!asset || typeof document === 'undefined') return null;
      let src = this.preview.get(item.assetId);
      if (!src) {
        if (item.mime === 'video/x-flv') {
          // browsers can't decode Sorenson/VP6: transcode for preview when ffmpeg is available
          if (!platform.media) return null;
          const r = await platform.media.transcode(asset.bytes, 'mp4');
          if (!r.ok || !r.bytes) { console.warn('FLV preview failed', r.error); return null; }
          src = { bytes: r.bytes, mime: 'video/mp4' };
        } else src = { bytes: asset.bytes, mime: item.mime };
        this.preview.set(item.assetId, src);
      }
      const url = URL.createObjectURL(new Blob([src.bytes as BlobPart], { type: src.mime }));
      const el = document.createElement('video');
      el.muted = true; el.preload = 'auto'; el.playsInline = true; el.src = url;
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 15000);
        el.addEventListener('loadeddata', () => { clearTimeout(t); resolve(true); }, { once: true });
        el.addEventListener('error', () => { clearTimeout(t); resolve(false); }, { once: true });
      });
      return ok ? el : null;
    })();
    this.sources.set(item.assetId, p);
    return p;
  }

  /** Reads basic facts about a video stream the browser can play. */
  async probe(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number; duration: number } | null> {
    if (typeof document === 'undefined') return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    const el = document.createElement('video');
    el.muted = true; el.preload = 'metadata'; el.src = url;
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10000);
      el.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve(true); }, { once: true });
      el.addEventListener('error', () => { clearTimeout(t); resolve(false); }, { once: true });
    });
    URL.revokeObjectURL(url);
    return ok ? { width: el.videoWidth, height: el.videoHeight, duration: el.duration } : null;
  }

  private extract(item: VideoItem, idx: number): Promise<void> {
    const key = `${item.assetId}:${idx}`;
    const hit = this.pending.get(key);
    if (hit) return hit;
    const prev = this.chain.get(item.assetId) ?? Promise.resolve();
    const job = prev.then(async () => {
      const el = await this.source(item);
      if (!el || this.frames.has(key)) return;
      const fps = item.fps || store.doc.fps;
      const t = Math.min(Math.max(0, el.duration - 0.001), (idx + 0.5) / fps);
      if (Math.abs(el.currentTime - t) > 1e-4) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          el.addEventListener('seeked', done, { once: true });
          setTimeout(done, 3000);
          el.currentTime = t;
        });
      }
      const bmp = await createImageBitmap(el);
      this.frames.set(key, bmp);
      while (this.frames.size > MAX_FRAMES) {
        const first = this.frames.keys().next().value as string;
        this.frames.get(first)?.close();
        this.frames.delete(first);
      }
      this.onFrame?.();
    }).catch((e) => console.warn('video frame', e)).finally(() => this.pending.delete(key));
    this.chain.set(item.assetId, job);
    this.pending.set(key, job);
    return job;
  }

  /** For the renderer: the frame if decoded (or the nearest earlier one while it decodes). */
  frameSync(name: string, offset: number): CanvasImageSource | null {
    const item = store.lib.get(name);
    if (!item || item.kind !== 'video') return null;
    const idx = this.frameIndex(item, offset);
    const key = `${item.assetId}:${idx}`;
    const bmp = this.frames.get(key);
    if (bmp) { this.frames.delete(key); this.frames.set(key, bmp); return bmp; }
    void this.extract(item, idx);
    this.missed = true;
    for (let k = idx - 1; k >= Math.max(0, idx - 48); k--) {
      const near = this.frames.get(`${item.assetId}:${k}`);
      if (near) return near;
    }
    return null;
  }

  /** Decodes the frame needed at a timeline offset (exports wait for this). */
  async ensure(name: string, offset: number) {
    const item = store.lib.get(name);
    if (!item || item.kind !== 'video') return;
    await this.extract(item, this.frameIndex(item, offset));
  }

  /** RGBA pixels of a video frame (SWF publishing of non-FLV video). */
  async pixels(name: string, idx: number): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
    const item = store.lib.get(name);
    if (!item || item.kind !== 'video') return null;
    await this.extract(item, idx);
    const bmp = this.frames.get(`${item.assetId}:${idx}`);
    if (!bmp) return null;
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0);
    return { width: bmp.width, height: bmp.height, data: x.getImageData(0, 0, bmp.width, bmp.height).data };
  }
}

export const video = new VideoEngine();

/** Video instances used on the given timeline frame (recursively through graphic symbols is not needed for embedded video). */
export function videosAt(els: Element[], out: { name: string }[] = []) {
  for (const e of els) {
    if (e.type === 'video') out.push({ name: e.libraryItem });
    else if (e.type === 'group') videosAt(e.children, out);
  }
  return out;
}

/** Creates a library video item from a file (FLV, MP4, MOV, WebM…). */
export async function addVideoFile(name: string, bytes: Uint8Array): Promise<VideoItem | null> {
  const mime = sniffVideo(bytes);
  if (!mime) return null;
  let stored = bytes, storedMime = mime;
  let fps = 0, width = 0, height = 0, duration = 0;
  const original = { bytes, mime };
  if (mime !== 'video/x-flv' && platform.media) {
    // Animate embeds video as FLV; convert so the FLA opens in Animate and the SWF can stream it
    const r = await platform.media.transcode(bytes, 'flv');
    if (r.ok && r.bytes) { stored = r.bytes; storedMime = 'video/x-flv'; fps = r.fps ?? 0; }
  }
  if (storedMime === 'video/x-flv') {
    const flv = parseFlv(stored);
    if (flv) { width = flv.width; height = flv.height; fps = flv.fps || fps; duration = flv.duration; }
  }
  if (!width || !duration) {
    const p = await video.probe(original.bytes, original.mime);
    if (p) { width ||= p.width; height ||= p.height; duration ||= p.duration; }
  }
  if (!width || !height) { width = width || 320; height = height || 240; }
  if (!fps) fps = store.doc.fps;
  const asset = store.assets.addRaw(stored, storedMime);
  if (original.mime !== 'video/x-flv') video.setPreview(asset.id, original.bytes, original.mime);
  if (storedMime !== 'video/x-flv') toast('Video kept as ' + mime.split('/')[1].toUpperCase() + '. Install ffmpeg (desktop app) to embed it as FLV for Animate and SWF.', 'info', 5000);
  return {
    kind: 'video', name: uniqueName(store.libraryNames(), name), itemID: itemId(), assetId: asset.id, mime: storedMime,
    width, height, fps, duration, videoType: storedMime === 'video/x-flv' ? 'h263 media' : 'h264 media',
  };
}

/** Places a video instance and extends the layer so every video frame has a timeline frame. */
export function placeVideo(name: string, x: number, y: number) {
  const it = store.lib.get(name);
  if (!it || it.kind !== 'video' || !store.canDraw()) return;
  const layer = store.layer()!;
  const el: Element = { type: 'video', id: uid(), matrix: translate(Math.round(x - it.width / 2), Math.round(y - it.height / 2)), libraryItem: name, width: it.width, height: it.height };
  const need = Math.max(1, Math.ceil(it.duration * store.doc.fps));
  store.transact('Place Video', () => {
    const list = store.editableElements(layer);
    list?.push(el);
    const fr = frameAt(layer, store.frame);
    if (fr && fr.duration < need) insertFrames(layer, fr.start, need - fr.duration);
  });
  store.select([el.id]);
}
