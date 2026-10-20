import { mapShapeStyles } from '../core/merge';
// Properties panel: context-sensitive (tool options, document, selection, frame).
import type { BlendMode, ColorEffectMode, Element, FilterDef, Frame, LoopMode, ShapeElement, SymbolInstance, SymbolType, TextElement, CapStyle, JoinStyle } from '../core/types';
import { dropdown } from './menu';
import { aboutPoint, isEmptyRect, multiply, rotate, scale, translate, rotationDeg, decompose } from '../core/matrix';
import { elementsBounds } from '../core/geometry';
import { frameAt } from '../core/timeline';
import { store, ui, setUI, onUI, type ToolId } from './state';
import { h, clear, numField, select, checkbox, textField, button } from './dom';
import { swatchButton, gradientCss, type ColorValue } from './colorpicker';
import * as A from './actions';
import { icon } from './icons';
import { modal, row } from './dialogs';

const I = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function liveEdit(label: string, final: boolean, fn: () => void) {
  if (!store.isLive) store.beginLive();
  fn();
  store.emit('doc');
  if (final) store.commitLive(label);
}

function section(title: string, ...children: (HTMLElement | null | false)[]): HTMLElement {
  const body = h('div', { class: 'sec-body' });
  for (const c of children) if (c) body.append(c);
  const head = h('div', { class: 'sec-head' }, h('span', { class: 'sec-caret' }, '▾'), title);
  const sec = h('div', { class: 'section' }, head, body);
  head.addEventListener('click', () => sec.classList.toggle('collapsed'));
  return sec;
}

function line(...children: (HTMLElement | string | null | false)[]): HTMLElement {
  const d = h('div', { class: 'prop-line' });
  for (const c of children) if (c) d.append(c);
  return d;
}

const FONTS = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Impact', 'Comic Sans MS', 'Segoe UI', 'Roboto', 'Open Sans', 'system-ui', 'monospace', 'serif', 'sans-serif'];

export class PropertiesPanel {
  el: HTMLElement;
  private lastKey = '';

  constructor(host: HTMLElement) {
    this.el = h('div', { class: 'props' });
    host.append(this.el);
    store.on((w) => {
      if (w.has('doc') || w.has('selection') || w.has('frame') || w.has('context') || w.has('library') || w.has('file')) this.render(false);
    });
    onUI((k) => { if (k === 'tool' || k.startsWith('fill') || k.startsWith('stroke') || k === 'zoom') this.render(k === 'tool'); });
    this.render(true);
  }

  private key(): string {
    return [ui.tool, store.selection.join(','), store.frame, store.stack.length, store.ctx.groupPath.join('/'), store.frameSel ? `${store.frameSel.layerIds.join(',')}:${store.frameSel.f0}-${store.frameSel.f1}` : '', store.selected().map((s) => s.el.type).join(',')].join('|');
  }

  render(force: boolean) {
    const k = this.key();
    const focusInside = this.el.contains(document.activeElement) && document.activeElement !== document.body;
    if (!force && k === this.lastKey && (focusInside || store.isLive)) return;
    if (store.isLive && k === this.lastKey) return;
    this.lastKey = k;
    const scroll = this.el.scrollTop;
    clear(this.el);
    const sel = store.selected();
    if (sel.length) this.renderSelection(sel.map((s) => s.el));
    else if (store.frameSel && (store.frameSel.f1 > store.frameSel.f0 || store.frameSel.layerIds.length >= 1) && this.frameForProps()) this.renderFrame(this.frameForProps()!);
    else this.renderDocument();
    this.renderToolOptions();
    this.el.scrollTop = scroll;
  }

  private frameForProps(): Frame | null {
    const l = store.layer();
    if (!l || !store.frameSel) return null;
    return frameAt(l, Math.min(store.frameSel.f0, store.frameSel.f1));
  }

  // ---------------- document ----------------
  private renderDocument() {
    const d = store.doc;
    const tl = store.timeline();
    const title = store.stack.length > 1 ? `Symbol: ${store.ctx.symbol}` : 'Document';
    this.el.append(h('div', { class: 'props-title' }, h('span', { html: icon('scene') }), title, h('span', { class: 'dim' }, store.fileName)));
    this.el.append(section('Document Settings',
      line(
        numField({ label: 'W', value: d.width, min: 1, max: 8192, digits: 0, onChange: (v, f) => { if (f) store.transact('Stage Size', () => { d.width = v; }); } }),
        numField({ label: 'H', value: d.height, min: 1, max: 8192, digits: 0, onChange: (v, f) => { if (f) store.transact('Stage Size', () => { d.height = v; }); } }),
      ),
      line(h('span', { class: 'lbl' }, 'Stage'), swatchButton(() => ({ color: d.background, alpha: 1, none: false }), (v, f) => { if (f) store.transact('Stage Color', () => { d.background = v.color; }); }, 'Stage color')),
      line(numField({ label: 'FPS', value: d.fps, min: 0.5, max: 120, digits: 2, onChange: (v, f) => { if (f) store.transact('Frame Rate', () => { d.fps = v; }); } })),
      line(button('Document Settings…', () => documentSettingsDialog(), 'wide')),
    ));
    void tl;
  }

  // ---------------- frame ----------------
  private renderFrame(fr: Frame) {
    this.el.append(h('div', { class: 'props-title' }, h('span', { html: icon('movieclip') }), 'Frame', h('span', { class: 'dim' }, `${fr.start + 1}${fr.duration > 1 ? `–${fr.start + fr.duration}` : ''}`)));
    this.el.append(section('Label',
      line(textField(fr.label, (v) => A.setFrameProps((f) => { f.label = v.trim(); }, 'Frame Label'), 'Label name')),
      line(h('span', { class: 'lbl' }, 'Type'), select(fr.labelType, [['name', 'Name'], ['comment', 'Comment'], ['anchor', 'Anchor']], (v) => A.setFrameProps((f) => { f.labelType = v; }, 'Label Type'))),
    ));
    const tweenSel = select(fr.tween, [['none', 'None'], ['motion', 'Motion Tween'], ['classic', 'Classic Tween'], ['shape', 'Shape Tween']], (v) => A.createTween(v));
    this.el.append(section('Tweening',
      line(h('span', { class: 'lbl' }, 'Tween'), tweenSel),
      fr.tween !== 'none' && line(numField({ label: 'Ease', value: fr.ease, min: -100, max: 100, digits: 0, onChange: (v, f) => { if (f) A.setFrameProps((x) => { x.ease = v; }, 'Ease'); }, title: '-100 = ease in, 100 = ease out' }),
        select(fr.ease === 0 ? 'none' : fr.ease < 0 ? 'in' : 'out', [['none', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out']], (v) => A.setFrameProps((x) => { x.ease = v === 'none' ? 0 : v === 'in' ? -100 : 100; }, 'Ease'))),
      fr.tween === 'motion' && !!fr.motion && h('div', { class: 'hint' }, `${fr.motion.props.filter((p) => p.keys.length > 1).length} animated properties. Move or transform the object on any frame of the span to add property keyframes (F6 keys all properties).`),
      fr.tween === 'classic' && line(h('span', { class: 'lbl' }, 'Rotate'),
        select(fr.rotate, [['auto', 'Auto'], ['none', 'None'], ['cw', 'CW'], ['ccw', 'CCW']], (v) => A.setFrameProps((x) => { x.rotate = v; }, 'Rotate')),
        (fr.rotate === 'cw' || fr.rotate === 'ccw') && numField({ label: '×', value: fr.rotateTimes, min: 0, max: 100, digits: 0, onChange: (v, f) => { if (f) A.setFrameProps((x) => { x.rotateTimes = v; }, 'Rotate'); } })),
    ));
    // sound (Animate's Properties > Sound)
    const sounds = store.doc.library.filter((i) => i.kind === 'sound').map((i) => [i.name, i.name] as [string, string]);
    const snd = fr.sound;
    const setSound = (fn: (f: Frame) => void, label = 'Frame Sound') => A.setFrameProps(fn, label);
    this.el.append(section('Sound',
      line(h('span', { class: 'lbl' }, 'Name'), select(snd?.name ?? '', [['', 'None'], ...sounds], (v) => setSound((f) => {
        if (!v) delete f.sound;
        else f.sound = { name: v, sync: f.sound?.sync ?? 'event', loopMode: f.sound?.loopMode ?? 'repeat', loops: f.sound?.loops ?? 1 };
      }))),
      !!snd && line(h('span', { class: 'lbl' }, 'Sync'), select(snd.sync, [['event', 'Event'], ['start', 'Start'], ['stop', 'Stop'], ['stream', 'Stream']], (v) => setSound((f) => { if (f.sound) f.sound.sync = v; }))),
      !!snd && snd.sync !== 'stop' && line(select(snd.loopMode, [['repeat', 'Repeat'], ['loop', 'Loop']], (v) => setSound((f) => { if (f.sound) f.sound.loopMode = v; })),
        snd.loopMode === 'repeat' && numField({ label: '×', value: snd.loops, min: 1, max: 65535, digits: 0, onChange: (v, fin) => { if (fin) setSound((f) => { if (f.sound) f.sound.loops = v; }); } })),
      !sounds.length && h('div', { class: 'hint' }, 'Import a sound (File › Import) to attach it to this keyframe.'),
    ));
    const ta = h('textarea', { class: 'script', spellcheck: false, placeholder: 'stop();' }) as HTMLTextAreaElement;
    ta.value = fr.script;
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('change', () => A.setFrameProps((x) => { x.script = ta.value; }, 'Frame Script'));
    this.el.append(section('Actions', ta, h('div', { class: 'hint' }, 'Supports stop(), play(), gotoAndPlay(n|"label"), gotoAndStop(), nextFrame(), prevFrame().')));
  }

  // ---------------- selection ----------------
  private renderSelection(els: Element[]) {
    const single = els.length === 1 ? els[0] : null;
    const typeName = single ? (single.type === 'symbol' ? ({ movieclip: 'Movie Clip', graphic: 'Graphic', button: 'Button' } as Record<SymbolType, string>)[single.symbolType]
      : single.type === 'shape' ? 'Shape' : single.type === 'group' ? 'Group' : single.type === 'text' ? 'Static Text' : 'Bitmap') : `${els.length} objects`;
    const ic = single ? (single.type === 'symbol' ? single.symbolType : single.type === 'bitmap' ? 'bitmap' : single.type === 'text' ? 'text' : single.type === 'group' ? 'objectDraw' : 'rect') : 'select';
    this.el.append(h('div', { class: 'props-title' }, h('span', { html: icon(ic) }), typeName, single && (single.type === 'symbol' || single.type === 'bitmap') ? h('span', { class: 'dim' }, single.libraryItem) : null));

    if (single && single.type === 'symbol') this.renderSymbol(single);

    // position & size
    const b = elementsBounds(els, I, store.lib);
    if (!isEmptyRect(b)) {
      const reg = single && single.type === 'symbol';
      const px = reg ? single.matrix.tx : b.x, py = reg ? single.matrix.ty : b.y;
      const lock = { on: true };
      const lockBtn = h('button', { class: 'icon-btn tiny on', title: 'Lock width and height values together', html: icon('lock') });
      lockBtn.addEventListener('click', () => { lock.on = !lock.on; lockBtn.classList.toggle('on', lock.on); lockBtn.innerHTML = icon(lock.on ? 'lock' : 'unlock'); });
      const rot = single ? rotationDeg(single.matrix) : 0;
      this.el.append(section('Position and Size',
        line(
          numField({ label: 'X', value: px, digits: 2, onChange: (v, f) => liveEdit('Move', f, () => { for (const s of store.mutableSelection()) s.el.matrix = { ...s.el.matrix, tx: s.el.matrix.tx + (v - px) }; }) }),
          numField({ label: 'Y', value: py, digits: 2, onChange: (v, f) => liveEdit('Move', f, () => { for (const s of store.mutableSelection()) s.el.matrix = { ...s.el.matrix, ty: s.el.matrix.ty + (v - py) }; }) }),
        ),
        line(
          numField({ label: 'W', value: b.w, min: 0.1, digits: 2, onChange: (v, f) => liveEdit('Resize', f, () => {
            const sx = v / b.w, sy = lock.on ? sx : 1;
            for (const s of store.mutableSelection()) s.el.matrix = multiply(aboutPoint(scale(sx, sy), b.x, b.y), s.el.matrix);
            if (!f) { b.w = v; if (lock.on) b.h *= sx; }
          }) }),
          numField({ label: 'H', value: b.h, min: 0.1, digits: 2, onChange: (v, f) => liveEdit('Resize', f, () => {
            const sy = v / b.h, sx = lock.on ? sy : 1;
            for (const s of store.mutableSelection()) s.el.matrix = multiply(aboutPoint(scale(sx, sy), b.x, b.y), s.el.matrix);
            if (!f) { b.h = v; if (lock.on) b.w *= sy; }
          }) }),
          lockBtn,
        ),
        single ? line(numField({ label: 'Rotate', value: rot, digits: 1, suffix: '°', onChange: (v, f) => liveEdit('Rotate', f, () => {
          for (const s of store.mutableSelection()) {
            const cur = rotationDeg(s.el.matrix);
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
            const piv = s.el.type === 'symbol' ? { x: s.el.matrix.a * s.el.transformPoint.x + s.el.matrix.c * s.el.transformPoint.y + s.el.matrix.tx, y: s.el.matrix.b * s.el.transformPoint.x + s.el.matrix.d * s.el.transformPoint.y + s.el.matrix.ty } : { x: cx, y: cy };
            s.el.matrix = multiply(aboutPoint(rotate(((v - cur) * Math.PI) / 180), piv.x, piv.y), s.el.matrix);
          }
        }) })) : null,
      ));
    }

    // fill & stroke for shapes
    const shapes = els.filter((e): e is ShapeElement => e.type === 'shape');
    if (shapes.length) this.renderShapeStyle(shapes);
    if (single && single.type === 'text') this.renderText(single);
    if (single && single.type === 'bitmap') {
      const it = store.lib.get(single.libraryItem);
      if (it?.kind === 'bitmap') {
        this.el.append(section('Bitmap',
          line(h('span', { class: 'lbl' }, `${it.width} × ${it.height} px`)),
          line(checkbox('Allow smoothing', it.smoothing, (v) => store.transact('Smoothing', () => { it.smoothing = v; }))),
        ));
      }
    }
    if (single && single.type === 'group') {
      this.el.append(section('Group', line(h('span', { class: 'dim' }, `${single.children.length} objects — double-click to edit, Ctrl+Shift+G to ungroup`))));
    }
  }

  private renderSymbol(inst: SymbolInstance) {
    const symbols = store.doc.library.filter((i) => i.kind === 'symbol').map((i) => [i.name, i.name] as [string, string]);
    const nameField = textField(inst.name, (v) => store.transact('Instance Name', () => { const s = store.mutableSelection()[0]; if (s && s.el.type === 'symbol') s.el.name = v.trim(); }), '<Instance Name>');
    const typeSel = select(inst.symbolType, [['movieclip', 'Movie Clip'], ['graphic', 'Graphic'], ['button', 'Button']], (v) => store.transact('Instance Behavior', () => { const s = store.mutableSelection()[0]; if (s && s.el.type === 'symbol') s.el.symbolType = v; }));
    this.el.append(section('Instance',
      inst.symbolType !== 'graphic' && line(nameField),
      line(h('span', { class: 'lbl' }, 'Behavior'), typeSel),
      line(h('span', { class: 'lbl' }, 'Instance of'), select(inst.libraryItem, symbols, (v) => A.swapSymbol(inst.id, v), 'Swap symbol')),
      line(button('Edit Symbol', () => store.enterSymbol(inst.libraryItem, multiply(store.groupMatrix(), inst.matrix), true), 'wide')),
    ));
    if (inst.symbolType === 'graphic') {
      this.el.append(section('Looping',
        line(h('span', { class: 'lbl' }, 'Options'), select(inst.loop, [['loop', 'Loop'], ['play once', 'Play Once'], ['single frame', 'Single Frame'], ['loop reverse', 'Loop Reverse'], ['play once reverse', 'Play Once Reverse']] as [LoopMode, string][], (v) => store.transact('Looping', () => { const s = store.mutableSelection()[0]; if (s && s.el.type === 'symbol') s.el.loop = v; }))),
        line(numField({ label: 'First', value: inst.firstFrame + 1, min: 1, digits: 0, onChange: (v, f) => { if (f) store.transact('First Frame', () => { const s = store.mutableSelection()[0]; if (s && s.el.type === 'symbol') s.el.firstFrame = v - 1; }); } })),
      ));
    }
    const ce = inst.color;
    const setCE = (fn: (s: SymbolInstance) => void, final: boolean) => liveEdit('Color Effect', final, () => {
      const s = store.mutableSelection()[0];
      if (s && s.el.type === 'symbol') fn(s.el);
    });
    const ceSel = select(ce.mode, [['none', 'None'], ['brightness', 'Brightness'], ['tint', 'Tint'], ['alpha', 'Alpha'], ['advanced', 'Advanced']] as [ColorEffectMode, string][], (v) => setCE((s) => { s.color = { ...s.color, mode: v }; }, true));
    const rows: (HTMLElement | null)[] = [line(h('span', { class: 'lbl' }, 'Style'), ceSel)];
    if (ce.mode === 'brightness') rows.push(line(slider('Bright', ce.brightness, -100, 100, (v, f) => setCE((s) => { s.color = { ...s.color, brightness: v }; }, f))));
    if (ce.mode === 'alpha') rows.push(line(slider('Alpha', ce.alpha, 0, 100, (v, f) => setCE((s) => { s.color = { ...s.color, alpha: v }; }, f))));
    if (ce.mode === 'tint') {
      rows.push(line(h('span', { class: 'lbl' }, 'Tint'), swatchButton(() => ({ color: ce.tintColor, alpha: 1, none: false }), (v, f) => setCE((s) => { s.color = { ...s.color, tintColor: v.color }; }, f))));
      rows.push(line(slider('Amount', ce.tintAmount, 0, 100, (v, f) => setCE((s) => { s.color = { ...s.color, tintAmount: v }; }, f))));
    }
    if (ce.mode === 'advanced') {
      const a = ce.advanced;
      const adv = (k: keyof typeof a, label: string, min: number, max: number, mult: boolean) => numField({
        label, value: mult ? a[k] * 100 : a[k], min, max, digits: 0, width: 46,
        onChange: (v, f) => setCE((s) => { s.color = { ...s.color, advanced: { ...s.color.advanced, [k]: mult ? v / 100 : v } }; }, f),
      });
      rows.push(line(adv('am', 'A%', -100, 100, true), adv('ao', '+', -255, 255, false)));
      rows.push(line(adv('rm', 'R%', -100, 100, true), adv('ro', '+', -255, 255, false)));
      rows.push(line(adv('gm', 'G%', -100, 100, true), adv('go', '+', -255, 255, false)));
      rows.push(line(adv('bm', 'B%', -100, 100, true), adv('bo', '+', -255, 255, false)));
    }
    this.el.append(section('Color Effect', ...rows));
    if (inst.symbolType !== 'graphic') this.renderFilters(inst);
  }

  private renderFilters(inst: SymbolInstance) {
    const edit = (label: string, final: boolean, fn: (s: SymbolInstance) => void) => liveEdit(label, final, () => {
      const s = store.mutableSelection()[0];
      if (s && s.el.type === 'symbol') fn(s.el);
    });
    const blendSel = select((inst.blendMode ?? 'normal') as BlendMode, [
      ['normal', 'Normal'], ['layer', 'Layer'], ['darken', 'Darken'], ['multiply', 'Multiply'], ['lighten', 'Lighten'], ['screen', 'Screen'],
      ['overlay', 'Overlay'], ['hardlight', 'Hard Light'], ['add', 'Add'], ['subtract', 'Subtract'], ['difference', 'Difference'], ['invert', 'Invert'],
    ], (v) => edit('Blend Mode', true, (s) => { s.blendMode = v === 'normal' ? undefined : v; }));
    this.el.append(section('Display', line(h('span', { class: 'lbl' }, 'Blending'), blendSel)));
    const filters = inst.filters ?? [];
    const rows: HTMLElement[] = [];
    const setF = (i: number, label: string, final: boolean, patch: Partial<FilterDef>) => edit(label, final, (s) => {
      const list = (s.filters ?? []).map((f) => ({ ...f }));
      list[i] = { ...list[i], ...patch } as FilterDef;
      s.filters = list;
    });
    filters.forEach((f, i) => {
      const title = f.type === 'dropShadow' ? 'Drop Shadow' : f.type === 'blur' ? 'Blur' : 'Glow';
      const rm = h('button', { class: 'icon-btn tiny', title: 'Remove filter', html: icon('trash') });
      rm.addEventListener('click', () => edit('Remove Filter', true, (s) => { s.filters = (s.filters ?? []).filter((_, k) => k !== i); if (!s.filters.length) delete s.filters; }));
      const box = h('div', { class: 'filter-box' }, h('div', { class: 'filter-head' }, h('b', null, title), rm));
      box.append(line(
        numField({ label: 'Blur X', value: f.blurX, min: 0, max: 255, digits: 1, width: 50, onChange: (v, fin) => setF(i, 'Filter', fin, { blurX: v, ...(f.blurX === f.blurY ? { blurY: v } : {}) }) }),
        numField({ label: 'Y', value: f.blurY, min: 0, max: 255, digits: 1, width: 50, onChange: (v, fin) => setF(i, 'Filter', fin, { blurY: v }) }),
      ));
      box.append(line(h('span', { class: 'lbl' }, 'Quality'), select(String(Math.min(3, Math.max(1, Math.round(f.quality)))), [['1', 'Low'], ['2', 'Medium'], ['3', 'High']], (v) => setF(i, 'Filter', true, { quality: Number(v) }))));
      if (f.type !== 'blur') {
        box.append(line(numField({ label: 'Strength', value: Math.round(f.strength * 100), min: 0, max: 1000, digits: 0, suffix: '%', onChange: (v, fin) => setF(i, 'Filter', fin, { strength: v / 100 }) }),
          h('span', { class: 'lbl' }, 'Color'), swatchButton(() => ({ color: f.color, alpha: f.alpha, none: false }), (v, fin) => setF(i, 'Filter Color', fin, { color: v.color, alpha: v.alpha }))));
        box.append(line(checkbox('Knockout', f.knockout, (v) => setF(i, 'Filter', true, { knockout: v })), checkbox(f.type === 'glow' ? 'Inner glow' : 'Inner shadow', f.inner, (v) => setF(i, 'Filter', true, { inner: v }))));
      }
      if (f.type === 'dropShadow') {
        box.append(line(
          numField({ label: 'Angle', value: f.angle, min: -360, max: 360, digits: 0, suffix: '°', width: 46, onChange: (v, fin) => setF(i, 'Filter', fin, { angle: v }) }),
          numField({ label: 'Distance', value: f.distance, min: -255, max: 255, digits: 1, width: 46, onChange: (v, fin) => setF(i, 'Filter', fin, { distance: v }) }),
        ));
      }
      rows.push(box);
    });
    const add = h('button', { class: 'wide' }, '+ Add Filter');
    add.addEventListener('click', () => dropdown([
      { label: 'Drop Shadow', action: () => edit('Add Filter', true, (s) => { s.filters = [...(s.filters ?? []), { type: 'dropShadow', blurX: 5, blurY: 5, strength: 1, quality: 1, color: '#000000', alpha: 1, angle: 45, distance: 5, inner: false, knockout: false, hideObject: false }]; }) },
      { label: 'Blur', action: () => edit('Add Filter', true, (s) => { s.filters = [...(s.filters ?? []), { type: 'blur', blurX: 5, blurY: 5, quality: 1 }]; }) },
      { label: 'Glow', action: () => edit('Add Filter', true, (s) => { s.filters = [...(s.filters ?? []), { type: 'glow', blurX: 5, blurY: 5, strength: 1, quality: 1, color: '#FF0000', alpha: 1, inner: false, knockout: false }]; }) },
    ], add));
    this.el.append(section('Filters', ...rows, line(add)));
  }

  private renderShapeStyle(shapes: ShapeElement[]) {
    const first = shapes[0].paths.find((p) => p.fill)?.fill;
    const firstStroke = shapes[0].paths.find((p) => p.stroke)?.stroke ?? null;
    const fillVal: ColorValue = first && first.kind === 'solid' ? { color: first.color, alpha: first.alpha, none: false }
      : first ? { color: first.stops[0]?.color ?? '#000000', alpha: first.stops[0]?.alpha ?? 1, none: false, css: gradientCss(first.stops) } : { color: ui.fillColor, alpha: 1, none: true };
    const strokeVal: ColorValue = firstStroke ? { color: firstStroke.color, alpha: firstStroke.alpha, none: false } : { color: ui.strokeColor, alpha: 1, none: true };
    const applyFill = (v: ColorValue, final: boolean) => liveEdit('Fill Color', final, () => {
      for (const s of store.mutableSelection()) {
        if (s.el.type !== 'shape') continue;
        mapShapeStyles(s.el, (p) => {
          const closed = p.d[p.d.length - 1] === 4;
          if (v.none) return { ...p, fill: null };
          if (!p.fill && !closed) return p;
          return { ...p, fill: { kind: 'solid' as const, color: v.color, alpha: v.alpha } };
        });
      }
    });
    const applyStroke = (fn: (st: NonNullable<ShapeElement['paths'][number]['stroke']> | null) => ShapeElement['paths'][number]['stroke'], label: string, final: boolean) => liveEdit(label, final, () => {
      for (const s of store.mutableSelection()) {
        if (s.el.type !== 'shape') continue;
        mapShapeStyles(s.el, (p) => ({ ...p, stroke: s.el.type === 'shape' && s.el.planar && !p.stroke ? null : fn(p.stroke) }));
      }
    });
    const sw = firstStroke?.width ?? ui.strokeWidth;
    this.el.append(section('Fill and Stroke',
      line(
        h('span', { class: 'lbl' }, 'Fill'), swatchButton(() => fillVal, (v, f) => { Object.assign(fillVal, v); applyFill(v, f); }, 'Fill color'),
        h('span', { class: 'lbl' }, 'Stroke'), swatchButton(() => strokeVal, (v, f) => { Object.assign(strokeVal, v); applyStroke((st) => (v.none ? null : { ...(st ?? { width: ui.strokeWidth, caps: ui.caps, joints: ui.joints }), color: v.color, alpha: v.alpha }), 'Stroke Color', f); }, 'Stroke color', 'stroke'),
      ),
      line(numField({ label: 'Stroke', value: sw, min: 0, max: 200, step: 0.1, digits: 2, onChange: (v, f) => applyStroke((st) => (st ? { ...st, width: v } : st), 'Stroke Width', f) })),
      line(h('span', { class: 'lbl' }, 'Cap'), select((firstStroke?.caps ?? 'round') as CapStyle, [['round', 'Round'], ['butt', 'None'], ['square', 'Square']], (v) => applyStroke((st) => (st ? { ...st, caps: v } : st), 'Cap', true)),
        h('span', { class: 'lbl' }, 'Join'), select((firstStroke?.joints ?? 'round') as JoinStyle, [['round', 'Round'], ['miter', 'Miter'], ['bevel', 'Bevel']], (v) => applyStroke((st) => (st ? { ...st, joints: v } : st), 'Join', true))),
    ));
  }

  private renderText(t: TextElement) {
    const set = (label: string, final: boolean, fn: (x: TextElement) => void) => liveEdit(label, final, () => {
      for (const s of store.mutableSelection()) if (s.el.type === 'text') fn(s.el);
    });
    const fontIn = h('input', { type: 'text', value: t.font, list: 'font-list', spellcheck: false }) as HTMLInputElement;
    fontIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') fontIn.blur(); });
    fontIn.addEventListener('change', () => set('Font', true, (x) => { x.font = fontIn.value.trim() || 'Arial'; }));
    const dl = h('datalist', { id: 'font-list' }, ...FONTS.map((f) => h('option', { value: f })));
    const bold = h('button', { class: `icon-btn tiny toggle ${t.bold ? 'on' : ''}`, title: 'Bold', style: 'font-weight:bold' }, 'B');
    const ital = h('button', { class: `icon-btn tiny toggle ${t.italic ? 'on' : ''}`, title: 'Italic', style: 'font-style:italic' }, 'I');
    bold.addEventListener('click', () => set('Bold', true, (x) => { x.bold = !t.bold; }));
    ital.addEventListener('click', () => set('Italic', true, (x) => { x.italic = !t.italic; }));
    const alignBtns = (['left', 'center', 'right'] as const).map((a) => {
      const b = h('button', { class: `icon-btn tiny toggle ${t.align === a ? 'on' : ''}`, title: `Align ${a}`, html: icon(a === 'left' ? 'alignL' : a === 'center' ? 'alignCH' : 'alignR') });
      b.addEventListener('click', () => set('Align', true, (x) => { x.align = a; }));
      return b;
    });
    const textArea = h('textarea', { class: 'script', spellcheck: false }) as HTMLTextAreaElement;
    textArea.value = t.text;
    textArea.addEventListener('keydown', (e) => e.stopPropagation());
    textArea.addEventListener('change', () => set('Edit Text', true, (x) => { x.text = textArea.value; }));
    this.el.append(section('Character',
      line(fontIn, dl),
      line(numField({ label: 'Size', value: t.size, min: 1, max: 1000, digits: 1, onChange: (v, f) => set('Font Size', f, (x) => { x.size = v; }) }), bold, ital),
      line(h('span', { class: 'lbl' }, 'Color'), swatchButton(() => ({ color: t.color, alpha: t.alpha, none: false }), (v, f) => set('Text Color', f, (x) => { x.color = v.color; x.alpha = v.alpha; }))),
      line(numField({ label: 'Spacing', value: t.letterSpacing, min: -50, max: 200, digits: 1, onChange: (v, f) => set('Letter Spacing', f, (x) => { x.letterSpacing = v; }) })),
    ));
    this.el.append(section('Paragraph',
      line(...alignBtns),
      line(numField({ label: 'Line', value: t.lineSpacing, min: -100, max: 500, digits: 1, onChange: (v, f) => set('Line Spacing', f, (x) => { x.lineSpacing = v; }) })),
      line(numField({ label: 'Width', value: t.width, min: 0, max: 10000, digits: 0, title: '0 = auto width', onChange: (v, f) => set('Text Width', f, (x) => { x.width = v; }) })),
      textArea,
    ));
  }

  // ---------------- tool options ----------------
  private renderToolOptions() {
    const t: ToolId = ui.tool;
    const drawing = ['line', 'rect', 'oval', 'polystar', 'pencil', 'brush', 'pen', 'bucket', 'ink', 'text', 'eraser'].includes(t);
    if (!drawing || store.selection.length) return;
    const rows: (HTMLElement | null)[] = [];
    const fillSw = swatchButton(() => ({ color: ui.fillColor, alpha: ui.fillAlpha, none: ui.fillNone, css: ui.fillKind !== 'solid' ? gradientCss(ui.fillStops) : undefined }), (v) => { setUI('fillKind', 'solid'); setUI('fillColor', v.color); setUI('fillAlpha', v.alpha); setUI('fillNone', v.none); }, 'Fill color');
    const strokeSw = swatchButton(() => ({ color: ui.strokeColor, alpha: ui.strokeAlpha, none: ui.strokeNone }), (v) => { setUI('strokeColor', v.color); setUI('strokeAlpha', v.alpha); setUI('strokeNone', v.none); }, 'Stroke color', 'stroke');
    if (t !== 'eraser') rows.push(line(h('span', { class: 'lbl' }, 'Fill'), fillSw, h('span', { class: 'lbl' }, 'Stroke'), strokeSw));
    if (['line', 'rect', 'oval', 'polystar', 'pencil', 'pen', 'ink'].includes(t)) {
      rows.push(line(numField({ label: 'Stroke', value: ui.strokeWidth, min: 0, max: 200, step: 0.1, digits: 2, onChange: (v) => setUI('strokeWidth', v) })));
      rows.push(line(h('span', { class: 'lbl' }, 'Cap'), select(ui.caps, [['round', 'Round'], ['butt', 'None'], ['square', 'Square']], (v) => setUI('caps', v)),
        h('span', { class: 'lbl' }, 'Join'), select(ui.joints, [['round', 'Round'], ['miter', 'Miter'], ['bevel', 'Bevel']], (v) => setUI('joints', v))));
    }
    if (t === 'rect') rows.push(line(numField({ label: 'Corner radius', value: ui.rectRadius, min: 0, max: 999, digits: 1, onChange: (v) => setUI('rectRadius', v) })));
    if (t === 'polystar') {
      rows.push(line(h('span', { class: 'lbl' }, 'Style'), select(ui.polyStar ? 'star' : 'polygon', [['polygon', 'Polygon'], ['star', 'Star']], (v) => setUI('polyStar', v === 'star'))));
      rows.push(line(numField({ label: 'Sides', value: ui.polySides, min: 3, max: 32, digits: 0, onChange: (v) => setUI('polySides', v) })));
      rows.push(line(numField({ label: 'Star point', value: ui.polyInner, min: 0.05, max: 1, step: 0.05, digits: 2, onChange: (v) => setUI('polyInner', v) })));
    }
    if (t === 'pencil') rows.push(line(h('span', { class: 'lbl' }, 'Mode'), select(ui.pencilMode, [['smooth', 'Smooth'], ['straighten', 'Straighten'], ['ink', 'Ink']], (v) => setUI('pencilMode', v))));
    if (t === 'brush') {
      rows.push(line(slider('Size', ui.brushSize, 1, 200, (v) => setUI('brushSize', v))));
      rows.push(line(checkbox('Use pen pressure', ui.brushPressure, (v) => setUI('brushPressure', v))));
    }
    if (t === 'eraser') {
      rows.push(line(h('span', { class: 'lbl' }, 'Mode'), select(ui.eraserMode, [['normal', 'Erase normal'], ['fills', 'Erase fills'], ['lines', 'Erase lines'], ['object', 'Erase objects']], (v) => setUI('eraserMode', v))));
      rows.push(line(slider('Size', ui.eraserSize, 2, 200, (v) => setUI('eraserSize', v))));
    }
    if (t === 'bucket') rows.push(line(h('span', { class: 'lbl' }, 'Gap'), select(ui.bucketGap, [['none', "Don't close gaps"], ['small', 'Close small gaps'], ['medium', 'Close medium gaps'], ['large', 'Close large gaps']], (v) => setUI('bucketGap', v))));
    if (t === 'text') {
      const fontIn = h('input', { type: 'text', value: ui.textFont, list: 'font-list-tool', spellcheck: false }) as HTMLInputElement;
      fontIn.addEventListener('keydown', (e) => e.stopPropagation());
      fontIn.addEventListener('change', () => setUI('textFont', fontIn.value || 'Arial'));
      rows.push(line(fontIn, h('datalist', { id: 'font-list-tool' }, ...FONTS.map((f) => h('option', { value: f })))));
      rows.push(line(numField({ label: 'Size', value: ui.textSize, min: 1, max: 1000, digits: 1, onChange: (v) => setUI('textSize', v) })));
    }
    this.el.append(section('Tool Options', ...rows));
  }
}

function slider(label: string, value: number, min: number, max: number, onChange: (v: number, final: boolean) => void): HTMLElement {
  const r = h('input', { type: 'range', min: String(min), max: String(max), value: String(value) }) as HTMLInputElement;
  const n = h('span', { class: 'slider-val' }, String(Math.round(value)));
  r.addEventListener('input', () => { n.textContent = r.value; onChange(Number(r.value), false); });
  r.addEventListener('change', () => onChange(Number(r.value), true));
  return h('label', { class: 'slider' }, h('span', { class: 'lbl' }, label), r, n);
}

export function documentSettingsDialog() {
  const d = store.doc;
  const v = { width: d.width, height: d.height, fps: d.fps, background: d.background, scaleContent: false };
  const bg = h('input', { type: 'color', value: d.background.toLowerCase() }) as HTMLInputElement;
  bg.addEventListener('input', () => { v.background = bg.value.toUpperCase(); });
  modal({
    title: 'Document Settings', width: 440,
    body: h('div', { class: 'form' },
      row('Width', numField({ value: v.width, min: 1, max: 8192, digits: 0, onChange: (x) => { v.width = x; } }), 'px'),
      row('Height', numField({ value: v.height, min: 1, max: 8192, digits: 0, onChange: (x) => { v.height = x; } }), 'px'),
      row('', checkbox('Scale content with stage', false, (x) => { v.scaleContent = x; })),
      row('Frame rate', numField({ value: v.fps, min: 0.5, max: 120, digits: 2, onChange: (x) => { v.fps = x; } }), 'fps'),
      row('Stage color', bg)),
    buttons: [{ label: 'Cancel' }, {
      label: 'OK', primary: true, onClick: () => {
        store.transact('Document Settings', () => {
          if (v.scaleContent && (v.width !== d.width || v.height !== d.height)) {
            const sx = v.width / d.width, sy = v.height / d.height;
            for (const sc of d.scenes) for (const l of sc.layers) for (const f of l.frames) for (const e of f.elements) e.matrix = multiply(scale(sx, sy), e.matrix);
          }
          d.width = v.width; d.height = v.height; d.fps = v.fps; d.background = v.background;
        });
      },
    }],
  });
}

export { translate, decompose };
