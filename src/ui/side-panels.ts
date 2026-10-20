import { mapShapeStyles } from '../core/merge';
// Color, Align and Transform panels.
import { store, ui, setUI, onUI } from './state';
import { h, clear, numField, checkbox, select } from './dom';
import { icon } from './icons';
import { pickerBody, gradientCss, type ColorValue } from './colorpicker';
import { currentFill, fitGradient } from './tools';
import { pathBounds } from '../core/path';
import { parseHex, toHex } from '../core/util';
import * as A from './actions';
import { aboutPoint, multiply, rotate, scale, decompose } from '../core/matrix';
import { elementsBounds } from '../core/geometry';
import { isEmptyRect } from '../core/matrix';

const I = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

export class ColorPanel {
  el: HTMLElement;
  private target: 'fill' | 'stroke' = 'fill';
  private body: ReturnType<typeof pickerBody> | null = null;
  private selStop = 0;
  private updating = false;
  constructor(host: HTMLElement) {
    this.el = h('div', { class: 'color-panel' });
    host.append(this.el);
    onUI((k) => {
      if (this.updating) return;
      if (k === 'fillKind' || k === 'fillStops') this.render();
      else if (k.startsWith('fill') || k.startsWith('stroke')) this.body?.set(this.value());
    });
    this.render();
  }
  private gradient() { return this.target === 'fill' && ui.fillKind !== 'solid'; }
  private value(): ColorValue {
    if (this.gradient()) {
      const s = ui.fillStops[Math.min(this.selStop, ui.fillStops.length - 1)];
      return { color: s.color, alpha: s.alpha, none: false };
    }
    return this.target === 'fill'
      ? { color: ui.fillColor, alpha: ui.fillAlpha, none: ui.fillNone }
      : { color: ui.strokeColor, alpha: ui.strokeAlpha, none: ui.strokeNone };
  }
  private render() {
    clear(this.el);
    const tabs = h('div', { class: 'seg' });
    for (const t of ['stroke', 'fill'] as const) {
      const b = h('button', { class: this.target === t ? 'on' : '' }, t === 'fill' ? 'Fill' : 'Stroke');
      b.addEventListener('click', () => { this.target = t; this.render(); });
      tabs.append(b);
    }
    const head = h('div', { class: 'prop-line' }, tabs);
    if (this.target === 'fill') {
      head.append(select(ui.fillKind, [['solid', 'Solid color'], ['linear', 'Linear gradient'], ['radial', 'Radial gradient']], (v) => {
        setUI('fillKind', v);
        setUI('fillNone', false);
        this.applyToSelection();
      }));
    }
    this.el.append(head);
    if (this.gradient()) this.el.append(this.gradientBar());
    this.body = pickerBody(this.value(), (v, final) => this.onPick(v, final), !this.gradient());
    this.el.append(this.body.el);
  }

  private onPick(v: ColorValue, final: boolean) {
    this.updating = true;
    if (this.gradient()) {
      const stops = ui.fillStops.map((s) => ({ ...s }));
      const i = Math.min(this.selStop, stops.length - 1);
      stops[i] = { ...stops[i], color: v.color, alpha: v.alpha };
      setUI('fillStops', stops);
      this.paintBar();
    } else if (this.target === 'fill') { setUI('fillColor', v.color); setUI('fillAlpha', v.alpha); setUI('fillNone', v.none); }
    else { setUI('strokeColor', v.color); setUI('strokeAlpha', v.alpha); setUI('strokeNone', v.none); }
    this.updating = false;
    if (final) this.applyToSelection();
  }

  /** Applies the current fill/stroke to selected shapes, like Animate's Color panel. */
  private applyToSelection() {
    if (!store.selected().some((s) => s.el.type === 'shape')) return;
    store.transact(this.target === 'fill' ? 'Fill Color' : 'Stroke Color', () => {
      for (const s of store.mutableSelection()) {
        if (s.el.type !== 'shape') continue;
        mapShapeStyles(s.el, (p) => {
          if (this.target === 'stroke') {
            if (s.el.type === 'shape' && s.el.planar && !p.stroke) return p;
            return { ...p, stroke: ui.strokeNone ? null : { ...(p.stroke ?? { width: ui.strokeWidth, caps: ui.caps, joints: ui.joints }), color: ui.strokeColor, alpha: ui.strokeAlpha } };
          }
          if (!p.fill && !ui.fillNone) return p;
          if (ui.fillNone) return { ...p, fill: null };
          const f = currentFill();
          if (!f) return p;
          if (f.kind !== 'solid' && p.fill && p.fill.kind === f.kind) return { ...p, fill: { ...f, matrix: p.fill.matrix } };
          return { ...p, fill: f.kind === 'solid' ? f : fitGradient(f, pathBounds(p.d)) };
        });
      }
    });
  }

  private bar: HTMLElement | null = null;
  private stopsHost: HTMLElement | null = null;
  private paintBar() {
    if (!this.bar || !this.stopsHost) return;
    this.bar.style.background = `${gradientCss(ui.fillStops)}, repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0/8px 8px`;
    clear(this.stopsHost);
    ui.fillStops.forEach((s, i) => {
      const m = h('div', { class: `gstop${i === this.selStop ? ' on' : ''}`, title: 'Drag to move, drag down to remove', style: `left:calc(6px + (100% - 12px) * ${s.offset}); background:${s.color}` });
      m.addEventListener('pointerdown', (e) => this.dragStop(e, i, m));
      this.stopsHost!.append(m);
    });
  }

  private gradientBar(): HTMLElement {
    this.bar = h('div', { class: 'gbar', title: 'Click to add a color stop' });
    this.stopsHost = h('div');
    const wrap = h('div', { class: 'gbar-wrap' }, this.bar, this.stopsHost);
    this.bar.addEventListener('pointerdown', (e) => {
      const r = this.bar!.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const stops = [...ui.fillStops].sort((a, b) => a.offset - b.offset);
      let color = stops[0].color, alpha = stops[0].alpha;
      for (let i = 0; i + 1 < stops.length; i++) {
        if (t >= stops[i].offset && t <= stops[i + 1].offset) {
          const k = (t - stops[i].offset) / Math.max(1e-6, stops[i + 1].offset - stops[i].offset);
          const a = parseHex(stops[i].color), b = parseHex(stops[i + 1].color);
          color = toHex(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k);
          alpha = stops[i].alpha + (stops[i + 1].alpha - stops[i].alpha) * k;
        }
      }
      if (ui.fillStops.length >= 15) return;
      const next = [...ui.fillStops, { offset: t, color, alpha }];
      this.selStop = next.length - 1;
      this.updating = true; setUI('fillStops', next); this.updating = false;
      this.render();
      this.applyToSelection();
    });
    requestAnimationFrame(() => this.paintBar());
    return wrap;
  }

  private dragStop(e: PointerEvent, i: number, marker: HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    this.selStop = i;
    this.body?.set(this.value());
    this.paintBar();
    const r = this.bar!.getBoundingClientRect();
    marker.setPointerCapture(e.pointerId);
    let removed = false;
    const mv = (ev: PointerEvent) => {
      const stops = ui.fillStops.map((s) => ({ ...s }));
      if (Math.abs(ev.clientY - (r.bottom + 8)) > 36 && stops.length > 2) { removed = true; marker.style.opacity = '0.3'; return; }
      removed = false; marker.style.opacity = '1';
      stops[i].offset = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      this.updating = true; setUI('fillStops', stops); this.updating = false;
      marker.style.left = `calc(6px + (100% - 12px) * ${stops[i].offset})`;
      this.bar!.style.background = `${gradientCss(stops)}, repeating-conic-gradient(#bbb 0 25%, #fff 0 50%) 0 0/8px 8px`;
    };
    const up = () => {
      marker.removeEventListener('pointermove', mv);
      marker.removeEventListener('pointerup', up);
      if (removed) {
        const stops = ui.fillStops.filter((_, k) => k !== i);
        this.selStop = 0;
        setUI('fillStops', stops);
      }
      this.render();
      this.applyToSelection();
    };
    marker.addEventListener('pointermove', mv);
    marker.addEventListener('pointerup', up);
  }
}

export class AlignPanel {
  el: HTMLElement;
  private toStage = false;
  constructor(host: HTMLElement) {
    this.el = h('div', { class: 'align-panel' });
    host.append(this.el);
    const btn = (ic: string, title: string, mode: A.AlignMode) => {
      const b = h('button', { class: 'icon-btn', title, html: icon(ic) });
      b.addEventListener('click', () => A.align(mode, this.toStage));
      return b;
    };
    this.el.append(
      h('div', { class: 'sec-label' }, 'Align'),
      h('div', { class: 'btn-row' }, btn('alignL', 'Align left edge (Ctrl+Alt+1)', 'left'), btn('alignCH', 'Align horizontal center (Ctrl+Alt+2)', 'hcenter'), btn('alignR', 'Align right edge (Ctrl+Alt+3)', 'right'),
        h('span', { class: 'gap' }), btn('alignT', 'Align top edge (Ctrl+Alt+4)', 'top'), btn('alignCV', 'Align vertical center (Ctrl+Alt+5)', 'vcenter'), btn('alignB', 'Align bottom edge (Ctrl+Alt+6)', 'bottom')),
      h('div', { class: 'sec-label' }, 'Distribute'),
      h('div', { class: 'btn-row' }, btn('distH', 'Distribute horizontal centers (Ctrl+Alt+8)', 'distH'), btn('distV', 'Distribute vertical centers (Ctrl+Alt+9)', 'distV')),
      h('div', { class: 'sec-label' }, 'Match size'),
      h('div', { class: 'btn-row' }, btn('matchW', 'Match width', 'matchW'), btn('matchH', 'Match height', 'matchH'), btn('objectDraw', 'Match width and height', 'matchWH')),
      h('div', { class: 'sec-label' }, 'Space'),
      h('div', { class: 'btn-row' }, btn('distH', 'Space evenly horizontally', 'spaceH'), btn('distV', 'Space evenly vertically', 'spaceV')),
      h('div', { class: 'btn-row' }, checkbox('Align to stage', this.toStage, (v) => { this.toStage = v; })),
    );
  }
}

export class TransformPanel {
  el: HTMLElement;
  private body: HTMLElement;
  constructor(host: HTMLElement) {
    this.body = h('div');
    this.el = h('div', { class: 'transform-panel' }, this.body);
    host.append(this.el);
    store.on((w) => { if ((w.has('selection') || w.has('doc')) && !this.el.contains(document.activeElement)) this.render(); });
    this.render();
  }
  private render() {
    clear(this.body);
    const sel = store.selected();
    if (!sel.length) { this.body.append(h('div', { class: 'hint' }, 'Select objects on the stage to transform them.')); return; }
    const b = elementsBounds(sel.map((s) => s.el), I, store.lib);
    if (isEmptyRect(b)) return;
    const d = sel.length === 1 ? decompose(sel[0].el.matrix) : null;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const apply = (label: string, T: (m: typeof I) => typeof I) => store.transact(label, () => { for (const s of store.mutableSelection()) s.el.matrix = T(s.el.matrix); });
    let sx = 100, sy = 100;
    const scaleRow = h('div', { class: 'prop-line' },
      numField({ label: 'W', value: d ? d.scaleX * 100 : 100, digits: 1, suffix: '%', onChange: (v, f) => { if (!f) return; const k = v / ((d?.scaleX ?? 1) * 100); sx = v; apply('Scale', (m) => multiply(aboutPoint(scale(k, 1), cx, cy), m)); } }),
      numField({ label: 'H', value: d ? d.scaleY * 100 : 100, digits: 1, suffix: '%', onChange: (v, f) => { if (!f) return; const k = v / ((d?.scaleY ?? 1) * 100); sy = v; apply('Scale', (m) => multiply(aboutPoint(scale(1, k), cx, cy), m)); } }),
    );
    void sx; void sy;
    const rotRow = h('div', { class: 'prop-line' },
      numField({ label: 'Rotate', value: d ? (d.skewY * 180) / Math.PI : 0, digits: 1, suffix: '°', onChange: (v, f) => {
        if (!f) return;
        const cur = d ? (d.skewY * 180) / Math.PI : 0;
        apply('Rotate', (m) => multiply(aboutPoint(rotate(((v - cur) * Math.PI) / 180), cx, cy), m));
      } }));
    const skewRow = h('div', { class: 'prop-line' },
      numField({ label: 'Skew H', value: d ? (d.skewX * 180) / Math.PI : 0, digits: 1, suffix: '°', onChange: (v, f) => {
        if (!f || sel.length !== 1) return;
        store.transact('Skew', () => { const s = store.mutableSelection()[0]; if (!s) return; const dd = decompose(s.el.matrix); const nm = { ...dd, skewX: (v * Math.PI) / 180 }; s.el.matrix = composeKeep(nm); });
      } }),
      numField({ label: 'V', value: d ? (d.skewY * 180) / Math.PI : 0, digits: 1, suffix: '°', onChange: (v, f) => {
        if (!f || sel.length !== 1) return;
        store.transact('Skew', () => { const s = store.mutableSelection()[0]; if (!s) return; const dd = decompose(s.el.matrix); const nm = { ...dd, skewY: (v * Math.PI) / 180 }; s.el.matrix = composeKeep(nm); });
      } }));
    const flips = h('div', { class: 'btn-row' },
      iconBtn('flipH', 'Flip horizontal', () => A.flipH()),
      iconBtn('flipV', 'Flip vertical', () => A.flipV()),
      iconBtn('reset', 'Remove transform (Ctrl+Shift+Z)', () => A.removeTransform()));
    this.body.append(scaleRow, rotRow, skewRow, flips);
  }
}

import { compose } from '../core/matrix';
function composeKeep(d: ReturnType<typeof decompose>) { return compose(d); }

function iconBtn(ic: string, title: string, fn: () => void) {
  const b = h('button', { class: 'icon-btn', title, html: icon(ic) });
  b.addEventListener('click', fn);
  return b;
}
