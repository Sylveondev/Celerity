// Export dialogs: image, video/GIF/PNG sequence, sprite sheet, SWF, test movie.
import type { Matrix, Rect, SymbolItem, Timeline } from '../core/types';
import { renderTimeline, type RenderEnv } from '../core/render';
import { IDENTITY_CT } from '../core/util';
import { timelineFrameCount, labelsOf } from '../core/timeline';
import { timelineBounds } from '../core/geometry';
import { emptyRect, isEmptyRect, unionRect } from '../core/matrix';
import { encodeGif } from '../io/gif';
import { writeZip } from '../io/zip';
import { frameToSvg } from '../io/svg';
import { writeSwf, swfHtmlWrapper } from '../io/swf';
import { packFrames, sheetData, trimBounds, hashPixels, type SheetFormat, type SheetFrame, type SheetAlgorithm } from '../io/spritesheet';
import { store } from './state';
import { platform, isElectron } from './platform';
import { modal, row, progressDialog, alertDialog } from './dialogs';
import { h, numField, select, checkbox, toast, clear } from './dom';
import { assetPixels } from './fileops';

const I: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function env(playback = true, includeHidden = true): RenderEnv {
  return { lib: store.lib, assets: store.assets, playback, includeHidden, showGuides: false, outlines: false };
}

function baseName() { return store.fileName.replace(/\.fla$/i, ''); }

/** Renders a timeline frame. `origin` is the top-left of the area in timeline space. */
export function renderArea(tl: Timeline, frame: number, origin: { x: number; y: number }, w: number, hgt: number, scale: number, bg: string | null, includeHidden = true): ImageData {
  const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(hgt * scale));
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  const m: Matrix = { a: scale, b: 0, c: 0, d: scale, tx: -origin.x * scale, ty: -origin.y * scale };
  renderTimeline(ctx, tl, frame, m, IDENTITY_CT, env(true, includeHidden), { offset: frame, elapsed: frame, spanAll: true, playback: true });
  return ctx.getImageData(0, 0, W, H);
}

function sceneFrame(frame: number, scale: number, transparent: boolean, includeHidden = true): ImageData {
  const d = store.doc;
  return renderArea(store.scene(), frame, { x: 0, y: 0 }, d.width, d.height, scale, transparent ? null : d.background, includeHidden);
}

async function imageDataToBlob(img: ImageData, type: string, quality?: number): Promise<Uint8Array> {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d')!.putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type, quality });
  return new Uint8Array(await blob.arrayBuffer());
}

function rangeFields(len: number, v: { from: number; to: number }) {
  return [
    numField({ value: v.from, min: 1, max: len, digits: 0, width: 60, onChange: (x) => { v.from = x; } }),
    h('span', { class: 'dim' }, 'to'),
    numField({ value: v.to, min: 1, max: len, digits: 0, width: 60, onChange: (x) => { v.to = x; } }),
  ];
}

// ---------------- Export Image ----------------
export function exportImageDialog() {
  const v = { format: 'png', scale: 100, transparent: false, quality: 90, frame: store.stack.length === 1 ? store.frame + 1 : 1 };
  const len = timelineFrameCount(store.scene());
  const qualityRow = row('JPEG quality', numField({ value: v.quality, min: 1, max: 100, digits: 0, onChange: (x) => { v.quality = x; } }));
  const transRow = row('', checkbox('Transparent background', v.transparent, (x) => { v.transparent = x; }));
  const update = () => {
    qualityRow.style.display = v.format === 'jpg' ? '' : 'none';
    transRow.style.display = v.format === 'jpg' ? 'none' : '';
  };
  const fmt = select(v.format as 'png' | 'jpg' | 'svg', [['png', 'PNG'], ['jpg', 'JPEG'], ['svg', 'SVG (vector)']], (x) => { v.format = x; update(); });
  update();
  modal({
    title: 'Export Image', width: 460,
    body: h('div', { class: 'form' },
      row('Format', fmt),
      row('Frame', numField({ value: v.frame, min: 1, max: len, digits: 0, onChange: (x) => { v.frame = x; } }), h('span', { class: 'dim' }, `of ${len}`)),
      row('Scale', numField({ value: v.scale, min: 1, max: 1000, digits: 0, onChange: (x) => { v.scale = x; } }), '%'),
      transRow, qualityRow),
    buttons: [{ label: 'Cancel' }, {
      label: 'Export', primary: true, onClick: async () => {
        const frame = Math.max(0, Math.min(len - 1, Math.round(v.frame) - 1));
        const name = `${baseName()}.${v.format}`;
        if (v.format === 'svg') {
          const svg = frameToSvg(store.doc, store.scene(), frame, store.assets, !v.transparent);
          await platform.saveAs(name, [{ name: 'SVG', extensions: ['svg'] }], svg, 'Export Image');
          return;
        }
        const img = sceneFrame(frame, v.scale / 100, v.transparent && v.format === 'png');
        const data = await imageDataToBlob(img, v.format === 'png' ? 'image/png' : 'image/jpeg', v.quality / 100);
        const p = await platform.saveAs(name, [{ name: v.format.toUpperCase(), extensions: [v.format] }], data, 'Export Image');
        if (p) toast(`Exported ${platform.basename(p)}`, 'ok');
      },
    }],
  });
}

// ---------------- Export Video / GIF / PNG sequence ----------------
type MediaFormat = 'mp4' | 'mov' | 'webm' | 'gif' | 'png-seq';

export async function exportMediaDialog(defaultFormat: MediaFormat = 'mp4') {
  const ffmpeg = platform.video ? await platform.video.probe().catch(() => ({ ok: false })) : { ok: false };
  const len = timelineFrameCount(store.scene());
  const v = { format: defaultFormat as MediaFormat, scale: 100, from: 1, to: len, transparent: false, quality: 80, loop: 0, includeHidden: true };
  if (!ffmpeg.ok && (v.format === 'mp4' || v.format === 'mov')) v.format = isElectron ? 'gif' : 'webm';
  const opts: [MediaFormat, string][] = [
    ['mp4', `MP4 video (H.264)${ffmpeg.ok ? '' : ' — needs ffmpeg'}`],
    ['mov', `QuickTime MOV (ProRes 4444, alpha)${ffmpeg.ok ? '' : ' — needs ffmpeg'}`],
    ['webm', 'WebM video (VP9, alpha)'],
    ['gif', 'Animated GIF'],
    ['png-seq', 'PNG sequence'],
  ];
  const info = h('div', { class: 'hint' });
  const updateInfo = () => {
    const w = Math.round(store.doc.width * v.scale / 100), hh = Math.round(store.doc.height * v.scale / 100);
    const frames = Math.max(0, Math.round(v.to) - Math.round(v.from) + 1);
    info.textContent = `${w} × ${hh} px · ${frames} frames · ${(frames / store.doc.fps).toFixed(2)} s at ${store.doc.fps} fps`;
  };
  updateInfo();
  const qualityRow = row('Quality', numField({ value: v.quality, min: 1, max: 100, digits: 0, onChange: (x) => { v.quality = x; } }), '%');
  const loopRow = row('Loop', select('0', [['0', 'Forever'], ['1', 'Once'], ['3', '3 times']], (x) => { v.loop = Number(x); }));
  const transRow = row('', checkbox('Transparent background', v.transparent, (x) => { v.transparent = x; }, 'MOV, WebM, GIF and PNG support transparency'));
  const update = () => {
    qualityRow.style.display = v.format === 'mp4' || v.format === 'webm' ? '' : 'none';
    loopRow.style.display = v.format === 'gif' ? '' : 'none';
    transRow.style.display = v.format === 'mp4' ? 'none' : '';
  };
  update();
  modal({
    title: 'Export Video / Media', width: 520,
    body: h('div', { class: 'form' },
      row('Format', select(v.format, opts, (x) => { v.format = x; update(); })),
      row('Size', numField({ value: v.scale, min: 1, max: 800, digits: 0, onChange: (x) => { v.scale = x; updateInfo(); } }), '%'),
      row('Frames', ...rangeFields(len, v)),
      transRow, qualityRow, loopRow,
      row('', checkbox('Include hidden layers', v.includeHidden, (x) => { v.includeHidden = x; })),
      info,
      !ffmpeg.ok && isElectron ? h('div', { class: 'hint warn' }, 'ffmpeg was not found. Run "npm install" (installs ffmpeg-static) or install ffmpeg on your PATH for MP4/MOV export.') : null,
    ),
    buttons: [{ label: 'Cancel' }, { label: 'Export', primary: true, onClick: () => { runMediaExport(v, !!ffmpeg.ok); } }],
  });
}

async function runMediaExport(v: { format: MediaFormat; scale: number; from: number; to: number; transparent: boolean; quality: number; loop: number; includeHidden: boolean }, hasFfmpeg: boolean) {
  const len = timelineFrameCount(store.scene());
  const f0 = Math.max(0, Math.min(len - 1, Math.round(v.from) - 1));
  const f1 = Math.max(f0, Math.min(len - 1, Math.round(v.to) - 1));
  const scale = v.scale / 100;
  const W = Math.max(1, Math.round(store.doc.width * scale)), H = Math.max(1, Math.round(store.doc.height * scale));
  const transparent = v.transparent && v.format !== 'mp4';
  const base = baseName();
  const total = f1 - f0 + 1;

  if (v.format === 'png-seq') {
    const files: { name: string; data: Uint8Array }[] = [];
    const prog = progressDialog('Exporting PNG sequence');
    try {
      for (let f = f0; f <= f1; f++) {
        if (prog.cancelled()) return;
        const img = sceneFrame(f, scale, transparent, v.includeHidden);
        files.push({ name: `${base}_${String(f - f0 + 1).padStart(4, '0')}.png`, data: await imageDataToBlob(img, 'image/png') });
        prog.set((f - f0 + 1) / total, `Frame ${f - f0 + 1} of ${total}`);
      }
      if (isElectron) {
        const dir = await platform.chooseDir('Choose a folder for the PNG sequence');
        if (dir) { await platform.writeMany(dir, files); toast(`Exported ${files.length} PNG files`, 'ok'); }
      } else {
        const zip = await writeZip(files.map((f) => ({ name: f.name, data: f.data, store: true })));
        await platform.saveAs(`${base}_png.zip`, [{ name: 'ZIP', extensions: ['zip'] }], zip);
      }
    } finally { prog.close(); }
    return;
  }

  if (v.format === 'gif' && !hasFfmpeg) {
    const path = await platform.chooseSavePath(`${base}.gif`, [{ name: 'GIF', extensions: ['gif'] }], 'Export Animated GIF');
    if (!path) return;
    const prog = progressDialog('Exporting animated GIF');
    try {
      const frames: { data: Uint8ClampedArray }[] = [];
      for (let f = f0; f <= f1; f++) {
        if (prog.cancelled()) return;
        frames.push({ data: sceneFrame(f, scale, transparent, v.includeHidden).data });
        prog.set(((f - f0 + 1) / total) * 0.7, `Rendering frame ${f - f0 + 1} of ${total}`);
        if ((f - f0) % 8 === 0) await new Promise((r) => setTimeout(r));
      }
      prog.set(0.8, 'Encoding…');
      await new Promise((r) => setTimeout(r));
      const gif = encodeGif(W, H, frames, store.doc.fps, { loop: v.loop, transparent });
      await platform.writeTo(path, gif);
      toast(`Exported ${platform.basename(path)}`, 'ok');
    } finally { prog.close(); }
    return;
  }

  if (hasFfmpeg && platform.video) {
    const ext = v.format;
    const path = await platform.chooseSavePath(`${base}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }], 'Export Video');
    if (!path) return;
    const prog = progressDialog(`Exporting ${ext.toUpperCase()}`);
    let id = 0;
    try {
      id = await platform.video.start({ file: path, width: W, height: H, fps: store.doc.fps, format: ext, quality: v.quality, loop: v.loop });
      for (let f = f0; f <= f1; f++) {
        if (prog.cancelled()) { await platform.video.cancel(id); return; }
        const img = sceneFrame(f, scale, transparent, v.includeHidden);
        await platform.video.frame(id, new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength));
        prog.set((f - f0 + 1) / total, `Frame ${f - f0 + 1} of ${total}`);
      }
      prog.set(1, 'Finishing…');
      const r = await platform.video.finish(id);
      if (!r.ok) throw new Error(r.error || 'ffmpeg failed');
      toast(`Exported ${platform.basename(path)}`, 'ok');
      platform.showItem(path);
    } catch (e) {
      await alertDialog('Export failed', (e as Error).message);
    } finally { prog.close(); }
    return;
  }

  // Browser fallback: WebM via MediaRecorder (real-time)
  if (v.format === 'webm' || v.format === 'mp4' || v.format === 'mov') {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2e6 + v.quality * 1e5 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const prog = progressDialog('Recording WebM (real time)');
    const done = new Promise<void>((r) => { rec.onstop = () => r(); });
    rec.start();
    const frameMs = 1000 / store.doc.fps;
    for (let f = f0; f <= f1; f++) {
      if (prog.cancelled()) break;
      const t0 = performance.now();
      ctx.putImageData(sceneFrame(f, scale, transparent, v.includeHidden), 0, 0);
      track.requestFrame?.();
      prog.set((f - f0 + 1) / total, `Frame ${f - f0 + 1} of ${total}`);
      await new Promise((r) => setTimeout(r, Math.max(0, frameMs - (performance.now() - t0))));
    }
    rec.stop();
    await done;
    prog.close();
    const blob = new Blob(chunks, { type: 'video/webm' });
    await platform.saveAs(`${base}.webm`, [{ name: 'WebM', extensions: ['webm'] }], new Uint8Array(await blob.arrayBuffer()));
  }
}

// ---------------- Sprite sheet ----------------
interface SheetOptions {
  source: string; // '' = current scene, otherwise symbol name
  from: number; to: number;
  scale: number;
  algorithm: SheetAlgorithm;
  format: SheetFormat | 'none';
  padding: number; border: number; columns: number;
  trim: boolean; stack: boolean; pow2: boolean;
  background: 'transparent' | 'stage';
}

function sourceTimeline(src: string): { tl: Timeline; area: Rect; name: string; registration: { x: number; y: number } } | null {
  if (!src) {
    return { tl: store.scene(), area: { x: 0, y: 0, w: store.doc.width, h: store.doc.height }, name: baseName(), registration: { x: 0, y: 0 } };
  }
  const it = store.lib.get(src);
  if (!it || it.kind !== 'symbol') return null;
  const len = timelineFrameCount(it.timeline);
  let r = emptyRect();
  for (let f = 0; f < len; f++) r = unionRect(r, timelineBounds(it.timeline, f, I, store.lib, { offset: f, elapsed: f, spanAll: true, playback: true }));
  if (isEmptyRect(r)) r = { x: 0, y: 0, w: 1, h: 1 };
  const area = { x: Math.floor(r.x), y: Math.floor(r.y), w: Math.ceil(r.x + r.w) - Math.floor(r.x), h: Math.ceil(r.y + r.h) - Math.floor(r.y) };
  return { tl: it.timeline, area, name: it.name.split('/').pop()!.replace(/[^\w-]+/g, '_'), registration: { x: -area.x, y: -area.y } };
}

async function buildSheet(o: SheetOptions, onProgress?: (p: number) => void) {
  const src = sourceTimeline(o.source);
  if (!src) throw new Error('Choose a symbol or the current scene.');
  const len = timelineFrameCount(src.tl);
  const f0 = Math.max(0, Math.min(len - 1, Math.round(o.from) - 1));
  const f1 = Math.max(f0, Math.min(len - 1, Math.round(o.to) - 1));
  const scale = o.scale / 100;
  const bg = o.background === 'stage' ? store.doc.background : null;
  const images: ImageData[] = [];
  const frames: SheetFrame[] = [];
  for (let f = f0; f <= f1; f++) {
    const img = renderArea(src.tl, f, { x: src.area.x, y: src.area.y }, src.area.w, src.area.h, scale, bg);
    images.push(img);
    const t = o.trim && !bg ? trimBounds(img.data, img.width, img.height) : { x: 0, y: 0, w: img.width, h: img.height };
    frames.push({ name: `${src.name}${String(f - f0).padStart(4, '0')}`, srcW: img.width, srcH: img.height, trimX: t.x, trimY: t.y, w: t.w, h: t.h, hash: o.stack ? hashPixels(img.data) : String(f) });
    onProgress?.((f - f0 + 1) / (f1 - f0 + 1));
  }
  const size = packFrames(frames, { algorithm: o.algorithm, padding: o.padding, border: o.border, columns: o.columns, maxSize: 8192, powerOfTwo: o.pow2, stack: o.stack });
  const sheet = new OffscreenCanvas(size.width, size.height);
  const ctx = sheet.getContext('2d')!;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, size.width, size.height); }
  frames.forEach((fr, i) => {
    if (fr.dupOf !== undefined) return;
    ctx.putImageData(images[i], fr.x! - fr.trimX, fr.y! - fr.trimY, fr.trimX, fr.trimY, fr.w, fr.h);
  });
  return { sheet, frames, size, name: src.name, registration: { x: src.registration.x * scale, y: src.registration.y * scale } };
}

export function exportSpriteSheetDialog(symbolName?: string) {
  const symbols = store.doc.library.filter((i): i is SymbolItem => i.kind === 'symbol');
  const o: SheetOptions = {
    source: symbolName ?? '', from: 1, to: 1, scale: 100, algorithm: 'packed', format: 'json', padding: 2, border: 2, columns: 0,
    trim: true, stack: true, pow2: false, background: 'transparent',
  };
  const lenOf = () => { const s = sourceTimeline(o.source); return s ? timelineFrameCount(s.tl) : 1; };
  o.to = lenOf();
  const preview = h('canvas', { class: 'sheet-preview' }) as HTMLCanvasElement;
  const info = h('div', { class: 'hint' });
  const rangeHost = h('div', { class: 'row-controls' });
  let timer = 0;
  const refresh = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const r = await buildSheet(o);
        const maxW = 360, maxH = 300;
        const k = Math.min(1, maxW / r.size.width, maxH / r.size.height);
        preview.width = Math.max(1, Math.round(r.size.width * k));
        preview.height = Math.max(1, Math.round(r.size.height * k));
        const pc = preview.getContext('2d')!;
        pc.clearRect(0, 0, preview.width, preview.height);
        pc.drawImage(r.sheet, 0, 0, preview.width, preview.height);
        const unique = r.frames.filter((f) => f.dupOf === undefined).length;
        info.textContent = `${r.size.width} × ${r.size.height} px · ${r.frames.length} frames (${unique} unique)`;
      } catch (e) { info.textContent = (e as Error).message; }
    }, 120);
  };
  const buildRange = () => {
    clear(rangeHost);
    const len = lenOf();
    o.from = 1; o.to = len;
    rangeHost.append(...rangeFields(len, new Proxy(o, { set(t, k, val) { (t as unknown as Record<string, unknown>)[k as string] = val; refresh(); return true; } })), h('span', { class: 'dim' }, `of ${len}`));
  };
  buildRange();
  const set = <K extends keyof SheetOptions>(k: K) => (val: SheetOptions[K]) => { o[k] = val; refresh(); };
  const colsRow = row('Columns', numField({ value: 0, min: 0, max: 512, digits: 0, onChange: (x) => { o.columns = x; refresh(); }, title: '0 = automatic' }));
  const body = h('div', { class: 'sheet-dialog' },
    h('div', { class: 'form' },
      row('Source', select(o.source, [['', `Current scene (${store.scene().name})`], ...symbols.map((s) => [s.name, s.name] as [string, string])], (x) => { o.source = x; buildRange(); refresh(); })),
      h('div', { class: 'row' }, h('span', { class: 'row-label' }, 'Frames'), rangeHost),
      row('Scale', numField({ value: o.scale, min: 1, max: 800, digits: 0, onChange: (x) => { o.scale = x; refresh(); } }), '%'),
      row('Algorithm', select(o.algorithm, [['packed', 'Packed (MaxRects)'], ['basic', 'Basic (grid)']], (x) => { o.algorithm = x; colsRow.style.display = x === 'basic' ? '' : 'none'; refresh(); })),
      colsRow,
      row('Data format', select(o.format, [['json', 'JSON (Hash)'], ['json-array', 'JSON-Array'], ['phaser3', 'Phaser 3'], ['starling', 'Starling / Sparrow XML'], ['easeljs', 'EaselJS'], ['cocos2d', 'cocos2d-x (plist)'], ['css', 'CSS'], ['none', 'None (image only)']], set('format'))),
      row('Border padding', numField({ value: o.border, min: 0, max: 64, digits: 0, onChange: (x) => { o.border = x; refresh(); } }), 'px'),
      row('Shape padding', numField({ value: o.padding, min: 0, max: 64, digits: 0, onChange: (x) => { o.padding = x; refresh(); } }), 'px'),
      row('Background', select(o.background, [['transparent', 'Transparent'], ['stage', 'Stage color']], set('background'))),
      row('', checkbox('Trim transparent edges', o.trim, set('trim'))),
      row('', checkbox('Stack identical frames', o.stack, set('stack'))),
      row('', checkbox('Power-of-two size', o.pow2, set('pow2'))),
    ),
    h('div', { class: 'sheet-preview-wrap' }, h('div', { class: 'checker' }, preview), info),
  );
  colsRow.style.display = 'none';
  refresh();
  modal({
    title: 'Generate Sprite Sheet', width: 820, body,
    buttons: [{ label: 'Cancel' }, {
      label: 'Export', primary: true, onClick: async () => {
        const r = await buildSheet(o);
        const png = new Uint8Array(await (await r.sheet.convertToBlob({ type: 'image/png' })).arrayBuffer());
        const path = await platform.chooseSavePath(`${r.name}.png`, [{ name: 'PNG', extensions: ['png'] }], 'Export Sprite Sheet');
        if (!path) return false;
        const imageName = platform.basename(path);
        await platform.writeTo(path, png);
        if (o.format !== 'none') {
          const data = sheetData(o.format, r.frames, { image: imageName, width: r.size.width, height: r.size.height, fps: store.doc.fps, scale: o.scale / 100, animationName: r.name, registration: r.registration });
          await platform.writeSiblings(path, [{ name: imageName.replace(/\.png$/i, '') + '.' + data.ext, data: data.text }]);
        }
        toast(`Exported sprite sheet ${imageName}`, 'ok');
      },
    }],
  });
}

// ---------------- Publish SWF ----------------
export function publishDialog() {
  const v = { version: 32, compress: true, includeHidden: true, html: true };
  modal({
    title: 'Publish Settings (Flash SWF)', width: 480,
    body: h('div', { class: 'form' },
      row('Target', select('32', [['10', 'Flash Player 10'], ['11', 'Flash Player 10.2'], ['32', 'Flash Player 32 (latest)']], (x) => { v.version = Number(x); })),
      row('', checkbox('Compress movie (zlib)', v.compress, (x) => { v.compress = x; })),
      row('', checkbox('Include hidden layers', v.includeHidden, (x) => { v.includeHidden = x; })),
      row('', checkbox('Also publish HTML wrapper (plays via Ruffle)', v.html, (x) => { v.html = x; })),
      h('div', { class: 'hint' }, 'Timeline scripts stop(), play(), gotoAndPlay(), gotoAndStop(), nextFrame() and prevFrame() are compiled into the SWF.'),
    ),
    buttons: [{ label: 'Cancel' }, { label: 'Publish', primary: true, onClick: () => { publishSwf(v); } }],
  });
}

export async function publishSwf(v = { version: 32, compress: true, includeHidden: true, html: true }) {
  try {
    const bytes = await writeSwf(store.doc, { version: v.version, compress: v.compress, includeHidden: v.includeHidden, assets: store.assets, pixels: (id) => assetPixels(id) });
    const name = `${baseName()}.swf`;
    const path = await platform.saveAs(name, [{ name: 'Flash Movie', extensions: ['swf'] }], bytes, 'Publish SWF');
    if (!path) return;
    if (v.html) {
      const swfName = platform.basename(path);
      await platform.writeSiblings(path, [{ name: swfName.replace(/\.swf$/i, '') + '.html', data: swfHtmlWrapper(swfName, store.doc.width, store.doc.height, store.doc.background) }]);
    }
    toast(`Published ${platform.basename(path)} (${(bytes.length / 1024).toFixed(1)} KB)`, 'ok');
  } catch (e) {
    console.error(e);
    await alertDialog('Publish failed', (e as Error).message);
  }
}

// ---------------- Test Movie ----------------
export function testMovie() {
  const d = store.doc;
  const tl = store.scene();
  const len = timelineFrameCount(tl);
  const canvas = h('canvas', { class: 'test-canvas' }) as HTMLCanvasElement;
  const status = h('span', { class: 'dim' });
  const playBtn = h('button', null, 'Pause');
  const wrap = h('div', { class: 'test-movie' }, canvas, h('div', { class: 'test-bar' }, playBtn, h('button', { onclick: () => { frame = 0; elapsed = 0; playing = true; playBtn.textContent = 'Pause'; } }, 'Restart'), status));
  const labels = new Map(labelsOf(tl).map((l) => [l.label, l.frame]));
  const scripts = new Map<number, string>();
  for (const l of tl.layers) for (const f of l.frames) if (f.script.trim()) scripts.set(f.start, (scripts.get(f.start) ?? '') + '\n' + f.script);
  let frame = 0, elapsed = 0, playing = true, raf = 0, last = performance.now(), acc = 0;
  playBtn.addEventListener('click', () => { playing = !playing; playBtn.textContent = playing ? 'Pause' : 'Play'; });
  const runScript = (f: number) => {
    const s = scripts.get(f);
    if (!s) return;
    for (let st of s.replace(/\/\/.*$/gm, '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean)) {
      st = st.replace(/^this\./, '');
      let m: RegExpExecArray | null;
      if (/^stop\(\s*\)$/.test(st)) { playing = false; playBtn.textContent = 'Play'; }
      else if (/^play\(\s*\)$/.test(st)) { playing = true; }
      else if ((m = /^goto(?:And)?(Play|Stop)\(\s*(?:(\d+)|["']([^"']+)["'])\s*\)$/.exec(st))) {
        const target = m[2] ? parseInt(m[2], 10) - 1 : labels.get(m[3]) ?? frame;
        frame = Math.max(0, Math.min(len - 1, target)) - 1;
        playing = m[1] === 'Play';
      }
    }
  };
  const draw = () => {
    const box = canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min((box.width - 20) / d.width, (box.height - 60) / d.height);
    const cw = Math.max(1, Math.round(d.width * k)), ch = Math.max(1, Math.round(d.height * k));
    if (canvas.width !== cw * dpr) { canvas.width = cw * dpr; canvas.height = ch * dpr; canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px'; }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = d.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = k * dpr;
    renderTimeline(ctx, tl, frame, { a: s, b: 0, c: 0, d: s, tx: 0, ty: 0 }, IDENTITY_CT, env(true, true), { offset: frame, elapsed, spanAll: true, playback: true });
    status.textContent = `Frame ${frame + 1} / ${len} · ${d.fps} fps`;
  };
  const tick = (now: number) => {
    const dt = now - last; last = now;
    acc += dt;
    const step = 1000 / d.fps;
    let advanced = false;
    while (acc >= step) {
      acc -= step;
      elapsed++; // movie clips keep playing even when the main timeline is stopped
      if (playing) {
        frame++;
        if (frame >= len) frame = 0;
        runScript(frame);
      }
      advanced = true;
      if (acc > step * 5) acc = 0;
    }
    if (advanced) draw();
    raf = requestAnimationFrame(tick);
  };
  runScript(0);
  const m = modal({ title: `Test Movie — ${store.fileName}`, body: wrap, width: 1400, className: 'test-modal', buttons: [{ label: 'Close', primary: true }], onClose: () => cancelAnimationFrame(raf) });
  void m;
  requestAnimationFrame(() => { draw(); raf = requestAnimationFrame(tick); });
}
