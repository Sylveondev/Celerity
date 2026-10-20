import type { Doc, Element, Frame, GroupElement, Layer, LibraryItem, Matrix, SymbolItem, Timeline, SymbolInstance, SymbolType } from './types';
import { AssetStore } from './assets';
import { indexLibrary, type LibIndex } from './symbols';
import { frameAt, insertKeyframe, layerLength, resolveLayerFrame, timelineFrameCount } from './timeline';
import { identity, multiply, translate, invert, apply } from './matrix';
import { elementsBounds } from './geometry';
import {
  baseName, cloneElements, defaultColorEffect, emptyFrame, newDoc, newLayer, newSymbol, uid, uniqueName, itemId, timelineLength,
} from './util';

export interface EditEntry {
  symbol: string | null;     // null = scene
  groupPath: string[];       // ids of groups entered (edit-in-place groups)
  groupLayerId: string | null;
  frame: number;
  layerId: string | null;
  matrix: Matrix;            // maps this context's space to stage space (for edit in place)
  parentVisible: boolean;    // show dimmed parent while editing in place
}

export interface FrameSelection { layerIds: string[]; f0: number; f1: number }

type Listener = (what: Set<string>) => void;

interface Snapshot { doc: string; ctx: string }

const MAX_UNDO = 300;

export class Store {
  doc: Doc = newDoc();
  assets = new AssetStore();
  lib: LibIndex = new Map();
  sceneIndex = 0;
  stack: EditEntry[] = [];
  selection: string[] = [];
  frameSel: FrameSelection | null = null;
  filePath: string | null = null;
  fileName = 'Untitled-1';
  dirty = false;
  playing = false;
  status = '';

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private current: Snapshot | null = null;
  private listeners: Listener[] = [];
  private pending = new Set<string>();
  private scheduled = false;
  private txDepth = 0;

  constructor() {
    this.assets.onLoad = () => this.emit('doc', 'library');
    this.reset(newDoc());
  }

  /** Replaces the asset store (when opening a document). */
  setAssets(a: AssetStore) {
    this.assets = a;
    a.onLoad = () => this.emit('doc', 'library');
  }

  // ---------------- events ----------------
  on(fn: Listener) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); }; }

  emit(...what: string[]) {
    for (const w of what) this.pending.add(w);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const set = new Set(this.pending);
      this.pending.clear();
      for (const l of this.listeners) {
        try { l(set); } catch (e) { console.error(e); }
      }
    });
  }

  // ---------------- document lifecycle ----------------
  reset(doc: Doc, filePath: string | null = null) {
    this.doc = doc;
    this.lib = indexLibrary(doc);
    this.sceneIndex = 0;
    this.stack = [{ symbol: null, groupPath: [], groupLayerId: null, frame: 0, layerId: doc.scenes[0]?.layers[0]?.id ?? null, matrix: identity(), parentVisible: false }];
    this.selection = [];
    this.frameSel = null;
    this.filePath = filePath;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.current = this.snapshot();
    this.status = '';
    this.emit('doc', 'library', 'context', 'selection', 'frame', 'file', 'status');
  }

  // ---------------- undo/redo ----------------
  private snapshot(): Snapshot {
    return {
      doc: JSON.stringify(this.doc),
      ctx: JSON.stringify({ stack: this.stack, selection: this.selection, sceneIndex: this.sceneIndex }),
    };
  }

  private restore(s: Snapshot) {
    this.doc = JSON.parse(s.doc);
    const c = JSON.parse(s.ctx);
    this.stack = c.stack;
    this.selection = c.selection;
    this.sceneIndex = Math.min(c.sceneIndex ?? 0, this.doc.scenes.length - 1);
    this.lib = indexLibrary(this.doc);
    this.validateContext();
    this.current = s;
  }

  /** Runs a mutation as one undoable step. */
  transact<T>(label: string, fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.txDepth++;
    const before = this.current ?? this.snapshot();
    let result: T;
    try {
      result = fn();
    } catch (e) {
      // roll back partial mutations
      this.restore(before);
      this.txDepth--;
      this.emit('doc', 'library', 'selection', 'frame', 'context');
      throw e;
    }
    this.txDepth--;
    const after = this.snapshot();
    if (after.doc === before.doc) {
      this.current = after;
      this.emit('selection', 'frame', 'context');
      return result;
    }
    // store the context of *before* but keep current selection for redo
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.current = after;
    this.lib = indexLibrary(this.doc);
    this.dirty = true;
    this.status = label;
    this.emit('doc', 'library', 'selection', 'frame', 'file', 'history');
    return result;
  }

  // ---- live edits (drags): mutate directly, commit once at the end ----
  private liveBefore: Snapshot | null = null;

  /** Starts a live edit. Mutations may then be applied directly; call commitLive/cancelLive. */
  beginLive() {
    this.liveBefore = this.current ?? this.snapshot();
  }

  get isLive() { return this.liveBefore !== null; }

  commitLive(label: string) {
    const before = this.liveBefore;
    this.liveBefore = null;
    if (!before) return;
    const after = this.snapshot();
    if (after.doc === before.doc) { this.current = after; return; }
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.current = after;
    this.lib = indexLibrary(this.doc);
    this.dirty = true;
    this.status = label;
    this.emit('doc', 'library', 'selection', 'frame', 'file', 'history');
  }

  cancelLive() {
    const before = this.liveBefore;
    this.liveBefore = null;
    if (before) {
      this.restore(before);
      this.emit('doc', 'library', 'selection', 'frame', 'context');
    }
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.current ?? this.snapshot());
    this.restore(s);
    this.dirty = true;
    this.emit('doc', 'library', 'selection', 'frame', 'context', 'file', 'history');
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.current ?? this.snapshot());
    this.restore(s);
    this.dirty = true;
    this.emit('doc', 'library', 'selection', 'frame', 'context', 'file', 'history');
  }

  /** Called after non-transactional UI state changes (frame, selection) so undo restores them. */
  syncContext() {
    if (this.current) this.current = { doc: this.current.doc, ctx: JSON.stringify({ stack: this.stack, selection: this.selection, sceneIndex: this.sceneIndex }) };
  }

  markSaved(path: string | null) {
    this.dirty = false;
    if (path) {
      this.filePath = path;
      this.fileName = path.split(/[\\/]/).pop() || this.fileName;
    }
    this.emit('file');
  }

  // ---------------- context ----------------
  get ctx(): EditEntry { return this.stack[this.stack.length - 1]; }

  scene(): Timeline { return this.doc.scenes[this.sceneIndex] ?? this.doc.scenes[0]; }

  timeline(): Timeline {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const e = this.stack[i];
      if (e.symbol) {
        const it = this.lib.get(e.symbol);
        if (it && it.kind === 'symbol') return it.timeline;
      }
    }
    return this.scene();
  }

  /** Context matrix mapping current editing space to stage space. */
  contextMatrix(): Matrix { return this.ctx.matrix; }

  get frame(): number { return this.ctx.frame; }

  setFrame(f: number) {
    const max = Math.max(0, timelineFrameCount(this.timeline()) + 500);
    f = Math.max(0, Math.min(max, Math.floor(f)));
    if (f === this.ctx.frame) return;
    // entering another frame while inside a group exits the group
    if (this.ctx.groupPath.length) this.exitGroups();
    this.ctx.frame = f;
    this.selection = this.selection.filter((id) => this.findElement(id));
    this.syncContext();
    this.emit('frame', 'selection');
  }

  layer(): Layer | null {
    const tl = this.timeline();
    const id = this.ctx.groupLayerId ?? this.ctx.layerId;
    return tl.layers.find((l) => l.id === id) ?? tl.layers.find((l) => l.type !== 'folder') ?? null;
  }

  setLayer(id: string) {
    if (this.ctx.layerId === id) return;
    this.ctx.layerId = id;
    this.syncContext();
    this.emit('frame');
  }

  validateContext() {
    // drop entries whose symbol vanished
    this.stack = this.stack.filter((e, i) => i === 0 || (e.symbol && this.lib.get(e.symbol)?.kind === 'symbol'));
    if (this.stack.length === 0) {
      this.stack = [{ symbol: null, groupPath: [], groupLayerId: null, frame: 0, layerId: null, matrix: identity(), parentVisible: false }];
    }
    const tl = this.timeline();
    if (!tl.layers.find((l) => l.id === this.ctx.layerId)) this.ctx.layerId = tl.layers.find((l) => l.type !== 'folder')?.id ?? null;
    if (this.ctx.groupPath.length && !this.groupTarget()) { this.ctx.groupPath = []; this.ctx.groupLayerId = null; }
  }

  enterSymbol(name: string, matrix: Matrix | null, inPlace: boolean) {
    const it = this.lib.get(name);
    if (!it || it.kind !== 'symbol') return;
    const base = matrix ? multiply(this.ctx.matrix, matrix) : translate(this.doc.width / 2, this.doc.height / 2);
    this.stack.push({
      symbol: name, groupPath: [], groupLayerId: null, frame: 0, layerId: it.timeline.layers[0]?.id ?? null,
      matrix: base, parentVisible: inPlace,
    });
    this.selection = [];
    this.frameSel = null;
    this.syncContext();
    this.emit('context', 'frame', 'selection', 'doc');
  }

  enterGroup(group: GroupElement, layerId: string) {
    this.ctx.groupPath = [...this.ctx.groupPath, group.id];
    this.ctx.groupLayerId = layerId;
    this.selection = [];
    this.syncContext();
    this.emit('context', 'selection', 'doc');
  }

  exitGroups() {
    this.ctx.groupPath = [];
    this.ctx.groupLayerId = null;
  }

  /** Steps out one level (group, then symbol). Returns false at the root. */
  exitContext(): boolean {
    if (this.ctx.groupPath.length) {
      const last = this.ctx.groupPath[this.ctx.groupPath.length - 1];
      this.ctx.groupPath = this.ctx.groupPath.slice(0, -1);
      if (!this.ctx.groupPath.length) this.ctx.groupLayerId = null;
      this.selection = [last];
      this.syncContext();
      this.emit('context', 'selection', 'doc');
      return true;
    }
    if (this.stack.length > 1) {
      this.stack.pop();
      this.selection = [];
      this.syncContext();
      this.emit('context', 'frame', 'selection', 'doc');
      return true;
    }
    return false;
  }

  exitToScene() {
    while (this.stack.length > 1) this.stack.pop();
    this.exitGroups();
    this.selection = [];
    this.syncContext();
    this.emit('context', 'frame', 'selection', 'doc');
  }

  setScene(i: number) {
    if (i < 0 || i >= this.doc.scenes.length) return;
    this.exitToScene();
    this.sceneIndex = i;
    this.stack[0].frame = 0;
    this.stack[0].layerId = this.scene().layers[0]?.id ?? null;
    this.syncContext();
    this.emit('context', 'frame', 'doc');
  }

  // ---------------- element access ----------------
  /** The group currently being edited, if any. */
  groupTarget(): GroupElement | null {
    if (!this.ctx.groupPath.length) return null;
    const layer = this.timeline().layers.find((l) => l.id === this.ctx.groupLayerId);
    if (!layer) return null;
    const fr = frameAt(layer, this.frame);
    if (!fr) return null;
    let els: Element[] = fr.elements;
    let g: GroupElement | null = null;
    for (const id of this.ctx.groupPath) {
      const found = els.find((e) => e.id === id);
      if (!found || found.type !== 'group') return null;
      g = found;
      els = found.children;
    }
    return g;
  }

  /** Matrix from the edited group's space to the current timeline space. */
  groupMatrix(): Matrix {
    if (!this.ctx.groupPath.length) return identity();
    const layer = this.timeline().layers.find((l) => l.id === this.ctx.groupLayerId);
    const fr = layer ? frameAt(layer, this.frame) : null;
    let m = identity();
    let els: Element[] = fr ? fr.elements : [];
    for (const id of this.ctx.groupPath) {
      const g = els.find((e) => e.id === id);
      if (!g || g.type !== 'group') break;
      m = multiply(m, g.matrix);
      els = g.children;
    }
    return m;
  }

  /** Elements displayed for a layer at the current frame (read-only). */
  displayed(layer: Layer): Element[] {
    const r = resolveLayerFrame(layer, this.frame);
    return r ? r.elements : [];
  }

  /**
   * Returns the mutable element array for a layer at the current frame,
   * inserting a keyframe if the frame is a tweened in-between or past the end.
   * Must be called inside a transaction.
   */
  editableElements(layer: Layer, create = true): Element[] | null {
    if (this.ctx.groupPath.length && layer.id === this.ctx.groupLayerId) {
      const g = this.groupTarget();
      return g ? g.children : null;
    }
    const f = this.frame;
    const r = resolveLayerFrame(layer, f);
    if (!r) {
      if (!create) return null;
      return insertKeyframe(layer, f, true).elements;
    }
    if (r.tweened) return insertKeyframe(layer, f, false).elements;
    return r.frame.elements;
  }

  /** All selectable layers at the current frame (top first). */
  editLayers(): Layer[] {
    if (this.ctx.groupPath.length) {
      const l = this.layer();
      return l ? [l] : [];
    }
    return this.timeline().layers.filter((l) => l.type !== 'folder');
  }

  /** Elements available to select (top-most first), with their layer. */
  selectable(): { layer: Layer; el: Element }[] {
    const out: { layer: Layer; el: Element }[] = [];
    if (this.ctx.groupPath.length) {
      const g = this.groupTarget();
      const l = this.layer();
      if (g && l) for (let i = g.children.length - 1; i >= 0; i--) out.push({ layer: l, el: g.children[i] });
      return out;
    }
    for (const layer of this.timeline().layers) {
      if (layer.type === 'folder' || !layer.visible || layer.locked) continue;
      if (!this.layerChainVisible(layer)) continue;
      const els = this.displayed(layer);
      for (let i = els.length - 1; i >= 0; i--) out.push({ layer, el: els[i] });
    }
    return out;
  }

  layerChainVisible(layer: Layer): boolean {
    const tl = this.timeline();
    let l: Layer | undefined = layer;
    let guard = 0;
    while (l && guard++ < 64) {
      if (!l.visible || l.locked) return false;
      const pid: string | null = l.parentId;
      if (!pid) return true;
      l = tl.layers.find((x) => x.id === pid);
      if (l && l.type !== 'folder') return true; // masks don't lock their children
    }
    return true;
  }

  findElement(id: string): { layer: Layer; el: Element } | null {
    for (const s of this.selectable()) if (s.el.id === id) return s;
    return null;
  }

  selected(): { layer: Layer; el: Element }[] {
    const all = this.selectable();
    const set = new Set(this.selection);
    return all.filter((s) => set.has(s.el.id)).reverse(); // bottom-to-top order
  }

  select(ids: string[], additive = false) {
    if (additive) {
      const set = new Set(this.selection);
      for (const id of ids) { if (set.has(id)) set.delete(id); else set.add(id); }
      this.selection = [...set];
    } else {
      this.selection = [...ids];
    }
    // selecting on stage moves the current layer to the selection's layer
    if (this.selection.length) {
      const f = this.findElement(this.selection[this.selection.length - 1]);
      if (f && !this.ctx.groupPath.length) this.ctx.layerId = f.layer.id;
    }
    this.frameSel = null;
    this.syncContext();
    this.emit('selection', 'frame');
  }

  clearSelection() {
    if (!this.selection.length) return;
    this.selection = [];
    this.syncContext();
    this.emit('selection');
  }

  /**
   * Gets mutable references to the selected elements (creating keyframes where
   * needed). Call inside a transaction.
   */
  mutableSelection(): { layer: Layer; el: Element; list: Element[] }[] {
    const sel = this.selected();
    const out: { layer: Layer; el: Element; list: Element[] }[] = [];
    for (const s of sel) {
      const list = this.editableElements(s.layer);
      if (!list) continue;
      const el = list.find((e) => e.id === s.el.id);
      if (el) out.push({ layer: s.layer, el, list });
    }
    return out;
  }

  /** Adds an element to the current layer. Returns false if the layer is locked/hidden. */
  addElement(el: Element, select = true): boolean {
    const layer = this.layer();
    if (!layer || layer.locked || !layer.visible || layer.type === 'folder') {
      this.flash(layer?.locked ? 'The current layer is locked.' : 'The current layer is hidden or not editable.');
      return false;
    }
    const label = el.type === 'symbol' || el.type === 'bitmap' ? 'Place Instance' : el.type === 'text' ? 'Add Text' : 'Draw';
    this.transact(label, () => {
      const list = this.editableElements(layer);
      if (!list) return;
      list.push(el);
    });
    if (select) this.select([el.id]);
    return true;
  }

  canDraw(): boolean {
    const layer = this.layer();
    if (!layer || layer.type === 'folder') { this.flash('Select a layer to draw on.'); return false; }
    if (layer.locked) { this.flash('The current layer is locked. Unlock it to draw.'); return false; }
    if (!layer.visible) { this.flash('The current layer is hidden. Show it to draw.'); return false; }
    return true;
  }

  flash(msg: string) {
    this.status = msg;
    this.emit('status');
  }

  // ---------------- library ----------------
  libraryNames(): Set<string> { return new Set(this.doc.library.map((i) => i.name)); }

  addLibraryItem(item: LibraryItem) {
    this.doc.library.push(item);
    this.lib.set(item.name, item);
  }

  createSymbolFromSelection(name: string, type: SymbolType, reg: { x: number; y: number }): SymbolInstance | null {
    const sel = this.selected();
    if (!sel.length) return null;
    let inst: SymbolInstance | null = null;
    this.transact('Convert to Symbol', () => {
      const ms = this.mutableSelection();
      if (!ms.length) return;
      const els = ms.map((s) => s.el);
      const b = elementsBounds(els, identity(), this.lib);
      const rx = b.x + b.w * reg.x, ry = b.y + b.h * reg.y;
      const sym = newSymbol(uniqueName(this.libraryNames(), name), type);
      const moved = els.map((e) => ({ ...structuredClone(e), matrix: multiply(translate(-rx, -ry), e.matrix) }));
      sym.timeline.layers[0].frames[0].elements = moved;
      this.addLibraryItem(sym);
      // replace in the lowest layer containing selection, remove from others
      const target = ms[ms.length - 1];
      let insertAt = target.list.indexOf(target.el);
      for (const s of ms) {
        const idx = s.list.indexOf(s.el);
        if (idx >= 0) {
          s.list.splice(idx, 1);
          if (s.list === target.list && idx < insertAt) insertAt--;
        }
      }
      inst = makeInstance(sym.name, type, translate(rx, ry));
      inst.transformPoint = { x: b.w * 0.5 + (b.x - rx), y: b.h * 0.5 + (b.y - ry) };
      target.list.splice(Math.max(0, insertAt + 1), 0, inst);
    });
    if (inst) this.select([(inst as SymbolInstance).id]);
    return inst;
  }

  renameLibraryItem(oldName: string, newName: string): boolean {
    newName = newName.trim();
    if (!newName || newName === oldName) return false;
    if (this.lib.has(newName)) { this.flash(`"${newName}" already exists in the library.`); return false; }
    this.transact('Rename', () => {
      const isFolder = this.lib.get(oldName)?.kind === 'folder';
      for (const it of this.doc.library) {
        if (it.name === oldName) it.name = newName;
        else if (isFolder && it.name.startsWith(oldName + '/')) it.name = newName + it.name.slice(oldName.length);
      }
      const rename = (n: string) => (n === oldName ? newName : isFolder && n.startsWith(oldName + '/') ? newName + n.slice(oldName.length) : n);
      forEachElement(this.doc, (e) => {
        if (e.type === 'symbol' || e.type === 'bitmap') e.libraryItem = rename(e.libraryItem);
      });
      for (const s of this.stack) if (s.symbol) s.symbol = rename(s.symbol);
    });
    return true;
  }

  deleteLibraryItems(names: string[]) {
    const del = new Set<string>();
    for (const n of names) {
      del.add(n);
      for (const it of this.doc.library) if (it.name.startsWith(n + '/')) del.add(it.name);
    }
    this.transact('Delete Library Item', () => {
      this.doc.library = this.doc.library.filter((i) => !del.has(i.name));
      const strip = (els: Element[]): Element[] => els.filter((e) => {
        if ((e.type === 'symbol' || e.type === 'bitmap') && del.has(e.libraryItem)) return false;
        if (e.type === 'group') e.children = strip(e.children);
        return true;
      });
      forEachFrame(this.doc, (f) => { f.elements = strip(f.elements); });
    });
    this.validateContext();
    this.emit('context');
  }

  duplicateLibraryItem(name: string): string | null {
    const it = this.lib.get(name);
    if (!it || it.kind === 'folder') return null;
    const copyName = uniqueName(this.libraryNames(), `${name} copy`);
    this.transact('Duplicate Symbol', () => {
      const c = structuredClone(it) as LibraryItem;
      c.name = copyName;
      c.itemID = itemId();
      if (c.kind === 'symbol') c.timeline.name = baseName(copyName);
      this.addLibraryItem(c);
    });
    return copyName;
  }

  // ---------------- layers ----------------
  addLayer(type: Layer['type'] = 'normal', name?: string): Layer {
    const tl = this.timeline();
    const existing = new Set(tl.layers.map((l) => l.name));
    const base = type === 'folder' ? 'Folder_1' : 'Layer_1';
    let n = tl.layers.length + 1;
    let nm = name ?? (type === 'folder' ? `Folder_${n}` : `Layer_${n}`);
    while (existing.has(nm)) { n++; nm = type === 'folder' ? `Folder_${n}` : `Layer_${n}`; }
    void base;
    const layer = newLayer(nm, 1);
    layer.type = type;
    if (type === 'folder') { layer.open = true; layer.frames = [emptyFrame(0, 1)]; }
    this.transact('New Layer', () => {
      const cur = this.layer();
      const idx = cur ? tl.layers.indexOf(cur) : 0;
      if (cur && cur.parentId && type !== 'folder') layer.parentId = cur.parentId;
      tl.layers.splice(Math.max(0, idx), 0, layer);
      this.ctx.layerId = layer.id;
    });
    return layer;
  }

  deleteLayers(ids: string[]) {
    const tl = this.timeline();
    const del = new Set(ids);
    // deleting a folder deletes its contents
    let grew = true;
    while (grew) {
      grew = false;
      for (const l of tl.layers) if (l.parentId && del.has(l.parentId) && !del.has(l.id)) {
        const parent = tl.layers.find((p) => p.id === l.parentId);
        if (parent?.type === 'folder') { del.add(l.id); grew = true; }
      }
    }
    if (tl.layers.filter((l) => !del.has(l.id)).length === 0) {
      this.flash('A timeline needs at least one layer.');
      return;
    }
    this.transact('Delete Layer', () => {
      tl.layers = tl.layers.filter((l) => !del.has(l.id));
      for (const l of tl.layers) if (l.parentId && del.has(l.parentId)) l.parentId = null;
      const first = tl.layers.find((l) => l.type !== 'folder');
      this.ctx.layerId = first?.id ?? tl.layers[0].id;
      this.selection = [];
    });
  }

  // ---------------- helpers ----------------
  timelineLength(): number { return timelineLength(this.timeline()); }
}

export function makeInstance(name: string, type: SymbolType, matrix: Matrix): SymbolInstance {
  return {
    type: 'symbol', id: uid(), matrix, libraryItem: name, symbolType: type, loop: 'loop', firstFrame: 0,
    name: '', color: defaultColorEffect(), transformPoint: { x: 0, y: 0 },
  };
}

export function forEachTimeline(doc: Doc, fn: (tl: Timeline, owner: SymbolItem | null) => void) {
  for (const s of doc.scenes) fn(s, null);
  for (const it of doc.library) if (it.kind === 'symbol') fn(it.timeline, it);
}

export function forEachFrame(doc: Doc, fn: (f: Frame, layer: Layer, tl: Timeline) => void) {
  forEachTimeline(doc, (tl) => {
    for (const l of tl.layers) for (const f of l.frames) fn(f, l, tl);
  });
}

export function forEachElement(doc: Doc, fn: (e: Element) => void) {
  const walk = (els: Element[]) => {
    for (const e of els) {
      fn(e);
      if (e.type === 'group') walk(e.children);
    }
  };
  forEachFrame(doc, (f) => walk(f.elements));
}

export function screenToLocal(view: Matrix, ctxMatrix: Matrix, sx: number, sy: number) {
  return apply(invert(multiply(view, ctxMatrix)), sx, sy);
}

export { layerLength, cloneElements };
