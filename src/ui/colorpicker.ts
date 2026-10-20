// Color swatch control with an Animate-style picker popup (swatches, HSB, alpha, hex).
import { h } from './dom';
import { ui, addRecentColor } from './state';
import { normalizeHex, parseHex, toHex } from '../core/util';

export interface ColorValue { color: string; alpha: number; none: boolean; css?: string }

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
  }
  return [hh, max ? d / max : 0, max];
}
function hsvToRgb(hh: number, s: number, v: number): [number, number, number] {
  const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0]; else if (hh < 120) [r, g, b] = [x, c, 0]; else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c]; else if (hh < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Builds an inline picker (used in the popup and in the Color panel). */
export function pickerBody(initial: ColorValue, onChange: (v: ColorValue, final: boolean) => void, allowNone = true): { el: HTMLElement; set(v: ColorValue): void } {
  let v = { ...initial };
  let [hue, sat, bri] = rgbToHsv(...parseHex(v.color));
  const sv = h('canvas', { class: 'cp-sv', width: 200, height: 130 }) as HTMLCanvasElement;
  const hueBar = h('canvas', { class: 'cp-hue', width: 200, height: 12 }) as HTMLCanvasElement;
  const alphaBar = h('canvas', { class: 'cp-alpha', width: 200, height: 12 }) as HTMLCanvasElement;
  const hex = h('input', { class: 'cp-hex', type: 'text', value: v.color.slice(1), maxlength: 7, spellcheck: false }) as HTMLInputElement;
  const alphaIn = h('input', { class: 'cp-alpha-in', type: 'number', min: 0, max: 100, value: Math.round(v.alpha * 100) }) as HTMLInputElement;
  const preview = h('div', { class: 'cp-preview' });
  const noneBtn = h('button', { class: 'icon-btn cp-none', title: 'No color' }, '');
  noneBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" fill="#fff" stroke="#888"/><path d="M5 19L19 5" stroke="#e33" stroke-width="2"/></svg>';
  const swatchGrid = h('div', { class: 'cp-swatches' });
  const recent = h('div', { class: 'cp-recent' });

  const drawSV = () => {
    const c = sv.getContext('2d')!;
    const [r, g, b] = hsvToRgb(hue, 1, 1);
    c.fillStyle = `rgb(${r},${g},${b})`;
    c.fillRect(0, 0, sv.width, sv.height);
    const wg = c.createLinearGradient(0, 0, sv.width, 0);
    wg.addColorStop(0, '#fff'); wg.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = wg; c.fillRect(0, 0, sv.width, sv.height);
    const bg = c.createLinearGradient(0, 0, 0, sv.height);
    bg.addColorStop(0, 'rgba(0,0,0,0)'); bg.addColorStop(1, '#000');
    c.fillStyle = bg; c.fillRect(0, 0, sv.width, sv.height);
    const x = sat * sv.width, y = (1 - bri) * sv.height;
    c.strokeStyle = bri > 0.5 ? '#000' : '#fff';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.stroke();
  };
  const drawHue = () => {
    const c = hueBar.getContext('2d')!;
    const g = c.createLinearGradient(0, 0, hueBar.width, 0);
    for (let i = 0; i <= 6; i++) { const [r, gg, b] = hsvToRgb((i * 60) % 360, 1, 1); g.addColorStop(i / 6, `rgb(${r},${gg},${b})`); }
    c.fillStyle = g; c.fillRect(0, 0, hueBar.width, hueBar.height);
    const x = (hue / 360) * hueBar.width;
    c.fillStyle = '#fff'; c.fillRect(x - 1.5, 0, 3, hueBar.height);
    c.strokeStyle = '#000'; c.strokeRect(x - 2, 0, 4, hueBar.height);
  };
  const drawAlpha = () => {
    const c = alphaBar.getContext('2d')!;
    for (let x = 0; x < alphaBar.width; x += 6) for (let y = 0; y < alphaBar.height; y += 6) {
      c.fillStyle = ((x + y) / 6) % 2 ? '#ccc' : '#fff'; c.fillRect(x, y, 6, 6);
    }
    const [r, g, b] = parseHex(v.color);
    const gr = c.createLinearGradient(0, 0, alphaBar.width, 0);
    gr.addColorStop(0, `rgba(${r},${g},${b},0)`); gr.addColorStop(1, `rgb(${r},${g},${b})`);
    c.fillStyle = gr; c.fillRect(0, 0, alphaBar.width, alphaBar.height);
    const x = v.alpha * alphaBar.width;
    c.fillStyle = '#fff'; c.fillRect(x - 1.5, 0, 3, alphaBar.height);
    c.strokeStyle = '#000'; c.strokeRect(x - 2, 0, 4, alphaBar.height);
  };
  const sync = (final: boolean, fromHex = false) => {
    if (!fromHex) hex.value = v.color.slice(1);
    alphaIn.value = String(Math.round(v.alpha * 100));
    preview.style.background = v.none ? 'repeating-linear-gradient(45deg,#fff 0 4px,#ddd 4px 8px)' : `rgba(${parseHex(v.color).join(',')},${v.alpha})`;
    drawSV(); drawHue(); drawAlpha();
    onChange({ ...v }, final);
  };
  const fromHSV = (final: boolean) => {
    const [r, g, b] = hsvToRgb(hue, sat, bri);
    v.color = toHex(r, g, b); v.none = false;
    sync(final);
  };
  const drag = (el: HTMLCanvasElement, fn: (x: number, y: number) => void) => {
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      const go = (ev: PointerEvent, final: boolean) => {
        fn(Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)), Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)));
        if (final) onChange({ ...v }, true);
      };
      go(e, false);
      const mv = (ev: PointerEvent) => go(ev, false);
      const up = (ev: PointerEvent) => { go(ev, true); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
    });
  };
  drag(sv, (x, y) => { sat = x; bri = 1 - y; fromHSV(false); });
  drag(hueBar, (x) => { hue = x * 359.9; fromHSV(false); });
  drag(alphaBar, (x) => { v.alpha = Math.round(x * 100) / 100; v.none = false; sync(false); });
  hex.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); });
  hex.addEventListener('change', () => {
    const n = normalizeHex(hex.value);
    if (!n) { hex.value = v.color.slice(1); return; }
    v.color = n; v.none = false;
    [hue, sat, bri] = rgbToHsv(...parseHex(n));
    sync(true, true);
  });
  alphaIn.addEventListener('keydown', (e) => e.stopPropagation());
  alphaIn.addEventListener('change', () => {
    v.alpha = Math.max(0, Math.min(100, Number(alphaIn.value) || 0)) / 100;
    v.none = false;
    sync(true);
  });
  noneBtn.addEventListener('click', () => { v.none = true; sync(true); });
  const setColor = (c: string) => {
    v.color = c; v.none = false; if (v.alpha === 0) v.alpha = 1;
    [hue, sat, bri] = rgbToHsv(...parseHex(c));
    sync(true);
    addRecentColor(c);
  };
  for (const c of ui.swatches) {
    const s = h('button', { class: 'cp-swatch', title: c, style: `background:${c}` });
    s.addEventListener('click', () => setColor(c));
    swatchGrid.append(s);
  }
  const fillRecent = () => {
    recent.innerHTML = '';
    for (const c of ui.recentColors) {
      const s = h('button', { class: 'cp-swatch', title: c, style: `background:${c}` });
      s.addEventListener('click', () => setColor(c));
      recent.append(s);
    }
  };
  fillRecent();
  const el = h('div', { class: 'cp' },
    h('div', { class: 'cp-top' }, preview, h('span', { class: 'cp-hash' }, '#'), hex, h('span', { class: 'dim' }, 'A'), alphaIn, h('span', { class: 'dim' }, '%'), allowNone ? noneBtn : null),
    sv, hueBar, alphaBar,
    ui.recentColors.length ? recent : null,
    swatchGrid);
  sync(false);
  return {
    el,
    set(nv: ColorValue) {
      v = { ...nv };
      [hue, sat, bri] = rgbToHsv(...parseHex(v.color));
      hex.value = v.color.slice(1);
      alphaIn.value = String(Math.round(v.alpha * 100));
      preview.style.background = v.none ? 'repeating-linear-gradient(45deg,#fff 0 4px,#ddd 4px 8px)' : `rgba(${parseHex(v.color).join(',')},${v.alpha})`;
      drawSV(); drawHue(); drawAlpha();
    },
  };
}

let openPopup: { close(): void } | null = null;

export function openPicker(anchor: HTMLElement, initial: ColorValue, onChange: (v: ColorValue, final: boolean) => void, onClose?: () => void, allowNone = true) {
  openPopup?.close();
  const body = pickerBody(initial, onChange, allowNone);
  const pop = h('div', { class: 'cp-popup' }, body.el);
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left, top = r.bottom + 4;
  if (left + pr.width > window.innerWidth - 4) left = window.innerWidth - pr.width - 4;
  if (top + pr.height > window.innerHeight - 4) top = Math.max(4, r.top - pr.height - 4);
  pop.style.left = Math.max(4, left) + 'px';
  pop.style.top = top + 'px';
  const onDown = (e: PointerEvent) => { if (!pop.contains(e.target as Node) && e.target !== anchor) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); } };
  const close = () => {
    pop.remove();
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
    openPopup = null;
    onClose?.();
  };
  setTimeout(() => {
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  });
  openPopup = { close };
  return { close };
}

/** A small swatch button that opens the picker. */
export function swatchButton(get: () => ColorValue, onChange: (v: ColorValue, final: boolean) => void, title = '', kind: 'fill' | 'stroke' = 'fill', onOpen?: () => void, onClose?: () => void): HTMLButtonElement {
  const b = h('button', { class: `swatch-btn ${kind}`, title }) as HTMLButtonElement;
  const paint = () => {
    const v = get();
    b.classList.toggle('none', v.none);
    b.classList.toggle('grad', !!v.css && !v.none);
    b.style.setProperty('--c', v.none ? 'transparent' : `rgba(${parseHex(v.color).join(',')},${v.alpha})`);
    b.style.setProperty('--g', v.css ?? 'none');
  };
  paint();
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onOpen?.();
    openPicker(b, get(), (v, final) => { onChange(v, final); paint(); }, () => { paint(); onClose?.(); });
  });
  (b as HTMLButtonElement & { repaint: () => void }).repaint = paint;
  return b;
}

/** CSS preview of gradient stops. */
export function gradientCss(stops: { offset: number; color: string; alpha: number }[]): string {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  return `linear-gradient(90deg, ${sorted.map((s) => `rgba(${parseHex(s.color).join(',')},${s.alpha}) ${Math.round(s.offset * 100)}%`).join(', ')})`;
}
