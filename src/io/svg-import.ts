// Imports SVG files as editable vector shapes (paths, basic shapes, groups,
// transforms, solid fills/strokes and linear/radial gradients approximated).
import type { Element, Fill, Matrix, PathData, ShapePath, Stroke } from '../core/types';
import { OP_C, OP_L, OP_M, OP_Q, OP_Z } from '../core/types';
import { ellipsePath, rectPath, transformPath, pathBounds } from '../core/path';
import { multiply, identity, translate, rotate, scale } from '../core/matrix';
import { uid } from '../core/util';

let colorCtx: CanvasRenderingContext2D | null = null;
function normColor(c: string): { color: string; alpha: number } | null {
  c = c.trim();
  if (!c || c === 'none' || c === 'transparent') return null;
  if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d')!;
  colorCtx.fillStyle = '#000000';
  colorCtx.fillStyle = c;
  const v = colorCtx.fillStyle as string;
  if (v.startsWith('#')) return { color: v.toUpperCase(), alpha: 1 };
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    const hex = '#' + p.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase();
    return { color: hex, alpha: p[3] ?? 1 };
  }
  return { color: '#000000', alpha: 1 };
}

function parseTransform(s: string | null): Matrix {
  let m = identity();
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(parseFloat);
    let t = identity();
    switch (r[1]) {
      case 'matrix': t = { a: a[0], b: a[1], c: a[2], d: a[3], tx: a[4], ty: a[5] }; break;
      case 'translate': t = translate(a[0] || 0, a[1] || 0); break;
      case 'scale': t = scale(a[0], a[1] ?? a[0]); break;
      case 'rotate': {
        const ang = ((a[0] || 0) * Math.PI) / 180;
        t = a.length >= 3 ? multiply(translate(a[1], a[2]), multiply(rotate(ang), translate(-a[1], -a[2]))) : rotate(ang);
        break;
      }
      case 'skewX': t = { a: 1, b: 0, c: Math.tan((a[0] * Math.PI) / 180), d: 1, tx: 0, ty: 0 }; break;
      case 'skewY': t = { a: 1, b: Math.tan((a[0] * Math.PI) / 180), c: 0, d: 1, tx: 0, ty: 0 }; break;
    }
    m = multiply(m, t);
  }
  return m;
}

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phi: number, fa: number, fs: number, x2: number, y2: number, out: number[]) {
  if (rx === 0 || ry === 0) { out.push(OP_L, x2, y2); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const sinP = Math.sin(phi), cosP = Math.cos(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy, y1p = -sinP * dx + cosP * dy;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { lambda = Math.sqrt(lambda); rx *= lambda; ry *= lambda; }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= Math.PI * 2;
  if (fs && dt < 0) dt += Math.PI * 2;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const step = dt / segs;
  const k = (4 / 3) * Math.tan(step / 4);
  let t = t1;
  for (let i = 0; i < segs; i++) {
    const c1 = Math.cos(t), s1 = Math.sin(t), c2 = Math.cos(t + step), s2 = Math.sin(t + step);
    const p = (x: number, y: number) => [cosP * rx * x - sinP * ry * y + cx, sinP * rx * x + cosP * ry * y + cy];
    const [ax, ay] = p(c1 - k * s1, s1 + k * c1);
    const [bx, by] = p(c2 + k * s2, s2 - k * c2);
    const [ex, ey] = p(c2, s2);
    out.push(OP_C, ax, ay, bx, by, ex, ey);
    t += step;
  }
}

export function parsePathData(src: string): PathData {
  const toks = src.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const out: number[] = [];
  let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lastCmd = '';
  const num = () => parseFloat(toks[i++]);
  const isNum = () => i < toks.length && !/[a-zA-Z]/.test(toks[i]);
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    switch (C) {
      case 'M': {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        out.push(OP_M, x, y); cx = sx = x; cy = sy = y;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { let x = num(), y = num(); if (rel) { x += cx; y += cy; } out.push(OP_L, x, y); cx = x; cy = y; break; }
      case 'H': { let x = num(); if (rel) x += cx; out.push(OP_L, x, cy); cx = x; break; }
      case 'V': { let y = num(); if (rel) y += cy; out.push(OP_L, cx, y); cy = y; break; }
      case 'C': {
        let a = num(), b = num(), c = num(), d = num(), x = num(), y = num();
        if (rel) { a += cx; b += cy; c += cx; d += cy; x += cx; y += cy; }
        out.push(OP_C, a, b, c, d, x, y); lcx = c; lcy = d; cx = x; cy = y; break;
      }
      case 'S': {
        let c = num(), d = num(), x = num(), y = num();
        if (rel) { c += cx; d += cy; x += cx; y += cy; }
        const a = /[CS]/i.test(lastCmd) ? 2 * cx - lcx : cx, b = /[CS]/i.test(lastCmd) ? 2 * cy - lcy : cy;
        out.push(OP_C, a, b, c, d, x, y); lcx = c; lcy = d; cx = x; cy = y; break;
      }
      case 'Q': {
        let a = num(), b = num(), x = num(), y = num();
        if (rel) { a += cx; b += cy; x += cx; y += cy; }
        out.push(OP_Q, a, b, x, y); lcx = a; lcy = b; cx = x; cy = y; break;
      }
      case 'T': {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        const a = /[QT]/i.test(lastCmd) ? 2 * cx - lcx : cx, b = /[QT]/i.test(lastCmd) ? 2 * cy - lcy : cy;
        out.push(OP_Q, a, b, x, y); lcx = a; lcy = b; cx = x; cy = y; break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), fa = num(), fs = num();
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        arcToCubics(cx, cy, rx, ry, (rot * Math.PI) / 180, fa, fs, x, y, out);
        cx = x; cy = y; break;
      }
      case 'Z': out.push(OP_Z); cx = sx; cy = sy; break;
      default: i++;
    }
    lastCmd = C;
    if (C === 'Z') continue;
    if (!isNum() && i < toks.length && !/[a-zA-Z]/.test(toks[i])) i++;
  }
  return out.filter((v) => Number.isFinite(v)).length === out.length ? out : out.map((v) => (Number.isFinite(v) ? v : 0));
}

interface Style { fill: string; stroke: string; strokeWidth: number; opacity: number; fillOpacity: number; strokeOpacity: number; linecap: string; linejoin: string; fillRule: string }

function readStyle(el: globalThis.Element, parent: Style): Style {
  const s: Style = { ...parent };
  const get = (name: string): string | null => {
    const style = el.getAttribute('style');
    if (style) {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
      if (m) return m[1].trim();
    }
    return el.getAttribute(name);
  };
  const f = get('fill'); if (f !== null) s.fill = f;
  const st = get('stroke'); if (st !== null) s.stroke = st;
  const sw = get('stroke-width'); if (sw !== null) s.strokeWidth = parseFloat(sw) || 0;
  const o = get('opacity'); if (o !== null) s.opacity = parent.opacity * (parseFloat(o) || 0);
  const fo = get('fill-opacity'); if (fo !== null) s.fillOpacity = parseFloat(fo);
  const so = get('stroke-opacity'); if (so !== null) s.strokeOpacity = parseFloat(so);
  const lc = get('stroke-linecap'); if (lc !== null) s.linecap = lc;
  const lj = get('stroke-linejoin'); if (lj !== null) s.linejoin = lj;
  return s;
}

function gradientFill(doc: Document, ref: string, opacity: number): Fill | null {
  const id = /url\(\s*#([^)]+)\)/.exec(ref)?.[1];
  if (!id) return null;
  const g = doc.getElementById(id);
  if (!g) return null;
  const stopsEl = [...g.querySelectorAll('stop')];
  const href = g.getAttribute('href') || g.getAttribute('xlink:href');
  const src = stopsEl.length ? stopsEl : href ? [...(doc.getElementById(href.slice(1))?.querySelectorAll('stop') ?? [])] : [];
  const stops = src.map((s) => {
    const style = s.getAttribute('style') || '';
    const sc = /stop-color\s*:\s*([^;]+)/.exec(style)?.[1] ?? s.getAttribute('stop-color') ?? '#000';
    const so = parseFloat(/stop-opacity\s*:\s*([^;]+)/.exec(style)?.[1] ?? s.getAttribute('stop-opacity') ?? '1');
    const off = s.getAttribute('offset') ?? '0';
    const c = normColor(sc) ?? { color: '#000000', alpha: 1 };
    return { offset: off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off), color: c.color, alpha: c.alpha * so * opacity };
  });
  if (!stops.length) return null;
  // approximate: use average color (gradient geometry is not mapped)
  if (stops.length === 1) return { kind: 'solid', color: stops[0].color, alpha: stops[0].alpha };
  return { kind: g.tagName.toLowerCase().includes('radial') ? 'radial' : 'linear', stops, matrix: { a: 0.1, b: 0, c: 0, d: 0.1, tx: 0, ty: 0 } };
}

const NUM = (v: string | null, d = 0) => (v === null ? d : parseFloat(v) || 0);

export function importSvg(text: string): { elements: Element[]; width: number; height: number } {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg') throw new Error('Not a valid SVG file.');
  let root = identity();
  const vb = svg.getAttribute('viewBox')?.split(/[\s,]+/).map(parseFloat);
  const w = NUM(svg.getAttribute('width'), vb?.[2] ?? 300), hh = NUM(svg.getAttribute('height'), vb?.[3] ?? 150);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) root = multiply(scale(w / vb[2], hh / vb[3]), translate(-vb[0], -vb[1]));
  const base: Style = { fill: '#000000', stroke: 'none', strokeWidth: 1, opacity: 1, fillOpacity: 1, strokeOpacity: 1, linecap: 'butt', linejoin: 'miter', fillRule: 'nonzero' };
  const out: Element[] = [];

  const walk = (node: globalThis.Element, m: Matrix, style: Style, into: Element[]) => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase().replace(/^svg:/, '');
      if (['defs', 'title', 'desc', 'metadata', 'style', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'symbol', 'filter'].includes(tag)) continue;
      if (child.getAttribute('display') === 'none' || child.getAttribute('visibility') === 'hidden') continue;
      const cm = multiply(m, parseTransform(child.getAttribute('transform')));
      const st = readStyle(child, style);
      if (tag === 'g' || tag === 'a' || tag === 'switch') {
        const kids: Element[] = [];
        walk(child, cm, st, kids);
        if (kids.length === 1) into.push(kids[0]);
        else if (kids.length) into.push({ type: 'group', id: uid(), matrix: identity(), children: kids });
        continue;
      }
      if (tag === 'use') {
        const href = child.getAttribute('href') || child.getAttribute('xlink:href');
        const ref = href ? doc.getElementById(href.slice(1)) : null;
        if (ref) {
          const wrap = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
          wrap.appendChild(ref.cloneNode(true));
          walk(wrap, multiply(cm, translate(NUM(child.getAttribute('x')), NUM(child.getAttribute('y')))), st, into);
        }
        continue;
      }
      let d: PathData | null = null;
      switch (tag) {
        case 'path': d = parsePathData(child.getAttribute('d') || ''); break;
        case 'rect': {
          const rx = NUM(child.getAttribute('rx') ?? child.getAttribute('ry'));
          d = rectPath(NUM(child.getAttribute('x')), NUM(child.getAttribute('y')), NUM(child.getAttribute('width')), NUM(child.getAttribute('height')), rx);
          break;
        }
        case 'circle': { const r = NUM(child.getAttribute('r')); d = ellipsePath(NUM(child.getAttribute('cx')), NUM(child.getAttribute('cy')), r, r); break; }
        case 'ellipse': d = ellipsePath(NUM(child.getAttribute('cx')), NUM(child.getAttribute('cy')), NUM(child.getAttribute('rx')), NUM(child.getAttribute('ry'))); break;
        case 'line': d = [OP_M, NUM(child.getAttribute('x1')), NUM(child.getAttribute('y1')), OP_L, NUM(child.getAttribute('x2')), NUM(child.getAttribute('y2'))]; break;
        case 'polyline':
        case 'polygon': {
          const pts = (child.getAttribute('points') || '').trim().split(/[\s,]+/).map(parseFloat);
          d = [];
          for (let k = 0; k + 1 < pts.length; k += 2) d.push(k ? OP_L : OP_M, pts[k], pts[k + 1]);
          if (tag === 'polygon' && d.length) d.push(OP_Z);
          break;
        }
        default: continue;
      }
      if (!d || !d.length) continue;
      let fill: Fill | null = null;
      if (st.fill.startsWith('url(')) fill = gradientFill(doc, st.fill, st.opacity * st.fillOpacity);
      else {
        const c = normColor(st.fill);
        if (c) fill = { kind: 'solid', color: c.color, alpha: c.alpha * st.opacity * st.fillOpacity };
      }
      if (tag === 'line' || tag === 'polyline') fill = tag === 'polyline' ? fill : null;
      let stroke: Stroke | null = null;
      const sc = st.stroke.startsWith('url(') ? { color: '#000000', alpha: 1 } : normColor(st.stroke);
      if (sc && st.strokeWidth > 0) {
        const sf = Math.sqrt(Math.abs(cm.a * cm.d - cm.b * cm.c)) || 1;
        stroke = {
          color: sc.color, alpha: sc.alpha * st.opacity * st.strokeOpacity, width: st.strokeWidth * sf,
          caps: st.linecap === 'round' ? 'round' : st.linecap === 'square' ? 'square' : 'butt',
          joints: st.linejoin === 'round' ? 'round' : st.linejoin === 'bevel' ? 'bevel' : 'miter',
        };
      }
      if (!fill && !stroke) continue;
      const wd = transformPath(d, cm);
      const b = pathBounds(wd);
      if (fill && fill.kind !== 'solid') {
        // map gradient across the shape's bounding box
        fill = { ...fill, matrix: fill.kind === 'linear'
          ? { a: b.w / 1638.4, b: 0, c: 0, d: b.h / 1638.4, tx: b.x + b.w / 2, ty: b.y + b.h / 2 }
          : { a: b.w / 1638.4, b: 0, c: 0, d: b.h / 1638.4, tx: b.x + b.w / 2, ty: b.y + b.h / 2 } };
      }
      const t = translate(-b.x, -b.y);
      const sp: ShapePath = { fill: fill && fill.kind !== 'solid' ? { ...fill, matrix: multiply(t, fill.matrix) } : fill, stroke, d: transformPath(wd, t) };
      into.push({ type: 'shape', id: uid(), matrix: translate(b.x, b.y), paths: [sp] });
    }
  };
  walk(svg, root, readStyle(svg, base), out);
  return { elements: out, width: w, height: hh };
}
