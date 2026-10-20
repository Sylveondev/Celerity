// New / Open / Save / Import, crash recovery.
import type { BitmapItem, Doc, Element } from '../core/types';
import { newDoc, itemId, uniqueName, uid } from '../core/util';
import { AssetStore, sniffMime } from '../core/assets';
import { readFla, type ReadResult } from '../io/xfl-read';
import { writeFla } from '../io/xfl-write';
import { importSvg } from '../io/svg-import';
import { translate } from '../core/matrix';
import { store, ui } from './state';
import { platform, type OpenedFile } from './platform';
import { alertDialog, modal, row, saveChangesDialog } from './dialogs';
import { h, numField, toast, select } from './dom';
import type { Stage } from './stage';

export const FLA_FILTER = [{ name: 'Animate Document', extensions: ['fla'] }];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

let stageRef: Stage | null = null;
export function bindStage(s: Stage) { stageRef = s; }

// ---------------- pixel helpers ----------------
export async function assetPixels(assetId: string, assets = store.assets): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  const a = assets.get(assetId);
  if (!a || !a.image) return null;
  const w = a.image.width, hh = a.image.height;
  const c = new OffscreenCanvas(w, hh);
  const x = c.getContext('2d')!;
  x.drawImage(a.image as CanvasImageSource, 0, 0);
  return { width: w, height: hh, data: x.getImageData(0, 0, w, hh).data };
}

export async function encodePng(width: number, height: number, rgba: Uint8ClampedArray): Promise<Uint8Array> {
  const c = new OffscreenCanvas(width, height);
  const x = c.getContext('2d')!;
  x.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------- document lifecycle ----------------
export async function confirmDiscard(): Promise<boolean> {
  if (!store.dirty) return true;
  const r = await saveChangesDialog(store.fileName);
  if (r === 'cancel') return false;
  if (r === 'save') return saveDocument(false);
  return true;
}

let untitledCounter = 1;

export function loadDoc(doc: Doc, assets: AssetStore, path: string | null, name: string) {
  store.stack = [];
  store.setAssets(assets);
  store.reset(doc, path);
  store.fileName = name;
  stageRef?.fitStage();
  store.emit('file');
}

export async function newDocument(skipConfirm = false, opts?: { width: number; height: number; fps: number; background: string }) {
  if (!skipConfirm && !(await confirmDiscard())) return;
  const doc = opts ? newDoc(opts.width, opts.height, opts.fps, opts.background) : newDoc();
  loadDoc(doc, new AssetStore(), null, `Untitled-${++untitledCounter}`);
}

export function newDocumentDialog() {
  const presets: [string, number, number][] = [
    ['Default (550 × 400)', 550, 400], ['HD (1280 × 720)', 1280, 720], ['Full HD (1920 × 1080)', 1920, 1080], ['4K (3840 × 2160)', 3840, 2160],
    ['Square (1080 × 1080)', 1080, 1080], ['Portrait / Story (1080 × 1920)', 1080, 1920], ['Game sprite (256 × 256)', 256, 256], ['Banner (728 × 90)', 728, 90],
  ];
  const v = { width: 550, height: 400, fps: 24, background: '#FFFFFF' };
  const wField = numField({ value: v.width, min: 1, max: 8192, digits: 0, onChange: (x) => { v.width = x; } });
  const hField = numField({ value: v.height, min: 1, max: 8192, digits: 0, onChange: (x) => { v.height = x; } });
  const presetSel = select('0', presets.map((p, i) => [String(i), p[0]] as [string, string]), (i) => {
    const p = presets[Number(i)];
    v.width = p[1]; v.height = p[2];
    (wField.querySelector('input') as HTMLInputElement).value = String(p[1]);
    (hField.querySelector('input') as HTMLInputElement).value = String(p[2]);
  });
  const fpsSel = select('24', [['12', '12'], ['15', '15'], ['24', '24'], ['25', '25'], ['30', '30'], ['48', '48'], ['50', '50'], ['60', '60']], (x) => { v.fps = Number(x); });
  const bg = h('input', { type: 'color', value: '#ffffff' }) as HTMLInputElement;
  bg.addEventListener('input', () => { v.background = bg.value.toUpperCase(); });
  modal({
    title: 'New Document', width: 460,
    body: h('div', { class: 'form' },
      row('Preset', presetSel),
      row('Width', wField, 'px'),
      row('Height', hField, 'px'),
      row('Frame rate', fpsSel, 'fps'),
      row('Stage color', bg)),
    buttons: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: () => { newDocument(false, v); } }],
  });
}

export async function openDocument() {
  if (!(await confirmDiscard())) return;
  const files = await platform.openFiles([...FLA_FILTER, { name: 'All Files', extensions: ['*'] }], false, 'Open');
  if (!files || !files.length) return;
  await openFile(files[0]);
}

export async function openPath(path: string) {
  if (!(await confirmDiscard())) return;
  try {
    const f = await platform.read(path);
    if (f) await openFile(f);
  } catch (e) {
    await alertDialog('Could not open file', `${path}\n\n${(e as Error).message}`);
  }
}

export async function readDocumentBytes(data: Uint8Array): Promise<{ result: ReadResult; assets: AssetStore }> {
  const assets = new AssetStore();
  const result = await readFla(data, { assets, encodePng });
  return { result, assets };
}

export async function openFile(f: OpenedFile) {
  try {
    store.flash(`Opening ${f.name}…`);
    const { result, assets } = await readDocumentBytes(f.data);
    loadDoc(result.doc, assets, f.path, f.name);
    if (result.warnings.length) {
      toast(`Opened with ${result.warnings.length} note(s): ${result.warnings[0]}`, 'info', 6000);
      console.warn('FLA import notes:', result.warnings);
    } else {
      toast(`Opened ${f.name}`, 'ok', 1500);
    }
    clearRecovery();
  } catch (e) {
    console.error(e);
    await alertDialog('Could not open document', `${f.name}\n\n${(e as Error).message}`);
  }
}

export async function serializeDocument(): Promise<Uint8Array> {
  return writeFla(store.doc, { assets: store.assets, pixels: (id) => assetPixels(id) });
}

export async function saveDocument(saveAs: boolean): Promise<boolean> {
  try {
    const defaultName = store.fileName.replace(/\.fla$/i, '') + '.fla';
    if (store.filePath && !saveAs) {
      const bytes = await serializeDocument();
      await platform.writeTo(store.filePath, bytes);
      store.markSaved(store.filePath);
    } else {
      const path = await platform.saveAs(defaultName, FLA_FILTER, () => serializeDocument(), 'Save As');
      if (!path) return false;
      store.markSaved(platform.basename(path) === path ? null : path);
      if (platform.basename(path) === path) { store.fileName = path; store.dirty = false; store.emit('file'); }
    }
    toast(`Saved ${store.fileName}`, 'ok', 1500);
    clearRecovery();
    return true;
  } catch (e) {
    console.error(e);
    await alertDialog('Save failed', (e as Error).message);
    return false;
  }
}

// ---------------- import ----------------
async function addBitmap(f: OpenedFile): Promise<BitmapItem | null> {
  const mime = sniffMime(f.data);
  if (!mime.startsWith('image/')) return null;
  const asset = await store.assets.add(f.data, mime);
  if (!asset.image) { toast(`Could not decode ${f.name}`, 'error'); return null; }
  const name = uniqueName(store.libraryNames(), f.name);
  const item: BitmapItem = { kind: 'bitmap', name, itemID: itemId(), assetId: asset.id, width: asset.width, height: asset.height, smoothing: true };
  return item;
}

export async function importFiles(files: OpenedFile[], toStage: boolean, at?: { x: number; y: number }) {
  const placed: Element[] = [];
  const items: BitmapItem[] = [];
  const svgEls: Element[] = [];
  for (const f of files) {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    try {
      if (ext === 'fla') { await importLibraryFrom(f); continue; }
      if (ext === 'svg') {
        const r = importSvg(new TextDecoder().decode(f.data));
        if (r.elements.length) svgEls.push(r.elements.length === 1 ? r.elements[0] : { type: 'group', id: uid(), matrix: translate(0, 0), children: r.elements });
        continue;
      }
      const item = await addBitmap(f);
      if (item) items.push(item);
      else toast(`Unsupported file: ${f.name}`, 'error');
    } catch (e) {
      toast(`Could not import ${f.name}: ${(e as Error).message}`, 'error', 5000);
    }
  }
  if (!items.length && !svgEls.length) return;
  if (toStage && !store.canDraw()) toStage = false;
  const center = at ?? stageRef?.viewCenter() ?? { x: store.doc.width / 2, y: store.doc.height / 2 };
  store.transact('Import', () => {
    for (const it of items) store.addLibraryItem(it);
    if (!toStage) return;
    const layer = store.layer()!;
    const list = store.editableElements(layer);
    let off = 0;
    for (const it of items) {
      const el: Element = { type: 'bitmap', id: uid(), matrix: translate(Math.round(center.x - it.width / 2 + off), Math.round(center.y - it.height / 2 + off)), libraryItem: it.name };
      list?.push(el);
      placed.push(el);
      off += 10;
    }
    for (const el of svgEls) { list?.push(el); placed.push(el); }
  });
  if (placed.length) store.select(placed.map((e) => e.id));
  toast(`Imported ${items.length + svgEls.length} item(s)`, 'ok', 1500);
}

export async function importDialog(toStage: boolean) {
  const files = await platform.openFiles([
    { name: 'All Supported', extensions: [...IMAGE_EXT, 'fla'] },
    { name: 'Images', extensions: IMAGE_EXT.filter((e) => e !== 'svg') },
    { name: 'SVG', extensions: ['svg'] },
    { name: 'Animate Document (library)', extensions: ['fla'] },
  ], true, toStage ? 'Import to Stage' : 'Import to Library');
  if (files) await importFiles(files, toStage);
}

/** File > Import > Open External Library: copies all items of another FLA. */
export async function importLibraryFrom(f: OpenedFile) {
  const { result, assets } = await readDocumentBytes(f.data);
  let added = 0;
  store.transact('Import Library', () => {
    for (const it of result.doc.library) {
      if (store.lib.has(it.name)) continue;
      const copy = structuredClone(it);
      if (copy.kind === 'bitmap') {
        const a = assets.get(it.kind === 'bitmap' ? it.assetId : '');
        if (a) copy.assetId = store.assets.adopt(a).id;
      }
      store.addLibraryItem(copy);
      added++;
    }
  });
  toast(`Imported ${added} library item(s) from ${f.name}`, 'ok');
}

// ---------------- crash recovery (IndexedDB) ----------------
const DB = 'celerity-recovery';
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key: string, value: unknown) {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('docs', 'readwrite');
    tx.objectStore('docs').put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb();
  const v = await new Promise<T | undefined>((res, rej) => {
    const tx = db.transaction('docs', 'readonly');
    const r = tx.objectStore('docs').get(key);
    r.onsuccess = () => res(r.result as T);
    r.onerror = () => rej(r.error);
  });
  db.close();
  return v;
}

let recoveryTimer = 0;
let lastRecoveryVersion = -1;
let version = 0;
export function startAutoRecovery() {
  store.on((w) => { if (w.has('doc')) version++; });
  recoveryTimer = window.setInterval(async () => {
    if (!store.dirty || version === lastRecoveryVersion || store.isLive) return;
    lastRecoveryVersion = version;
    try {
      const bytes = await serializeDocument();
      await idbPut('last', { bytes, name: store.fileName, path: store.filePath, time: Date.now() });
    } catch (e) {
      console.warn('auto-recovery failed', e);
    }
  }, 30000);
}

export async function clearRecovery() {
  try { await idbPut('last', null); } catch { /* ignore */ }
}

export async function checkRecovery() {
  try {
    const rec = await idbGet<{ bytes: Uint8Array; name: string; path: string | null; time: number } | null>('last');
    if (!rec || !rec.bytes) return;
    const when = new Date(rec.time).toLocaleString();
    modal({
      title: 'Recover unsaved work?', width: 460,
      body: h('p', { class: 'msg' }, `Celerity found unsaved changes to "${rec.name}" from ${when}. Do you want to recover them?`),
      buttons: [
        { label: 'Discard', danger: true, onClick: () => { clearRecovery(); } },
        {
          label: 'Recover', primary: true, onClick: async () => {
            const { result, assets } = await readDocumentBytes(rec.bytes);
            loadDoc(result.doc, assets, rec.path, rec.name);
            store.dirty = true;
            store.emit('file');
          },
        },
      ],
    });
  } catch { /* IndexedDB unavailable */ }
}

export function stopAutoRecovery() { clearInterval(recoveryTimer); }

export { ui };
