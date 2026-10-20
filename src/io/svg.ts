// SVG export of a single frame.
import type { ColorTransform, Doc, Element, Fill, Matrix, Timeline } from '../core/types';
import { multiply, IDENTITY } from '../core/matrix';
import { pathToSvg, transformPath } from '../core/path';
import { resolveLayerFrame, timelineFrameCount } from '../core/timeline';
import { applyCTFill, applyCTStroke, applyCTColor, concatCT, effectToTransform, IDENTITY_CT, fmtNum } from '../core/util';
import { childContext, indexLibrary, instanceFrame, layoutText, type FrameContext, type LibIndex } from '../core/symbols';
import type { AssetStore } from '../core/assets';

interface Ctx { lib: LibIndex; assets: AssetStore; defs: string[]; nextId: number; includeHidden: boolean }

const n = (v: number) => fmtNum(v, 3);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function paint(f: Fill, c: Ctx, m: Matrix): string {
  if (f.kind === 'solid') return `fill="${f.color}"${f.alpha < 1 ? ` fill-opacity="${n(f.alpha)}"` : ''}`;
  const id = `g${c.nextId++}`;
  const gm = multiply(m, f.matrix);
  const stops = f.stops.map((s) => `<stop offset="${n(s.offset)}" stop-color="${s.color}"${s.alpha < 1 ? ` stop-opacity="${n(s.alpha)}"` : ''}/>`).join('');
  const tf = `gradientTransform="matrix(${n(gm.a)} ${n(gm.b)} ${n(gm.c)} ${n(gm.d)} ${n(gm.tx)} ${n(gm.ty)})" gradientUnits="userSpaceOnUse"`;
  const spread = f.spread && f.spread !== 'pad' ? ` spreadMethod="${f.spread}"` : '';
  c.defs.push(f.kind === 'linear'
    ? `<linearGradient id="${id}" x1="-819.2" y1="0" x2="819.2" y2="0" ${tf}${spread}>${stops}</linearGradient>`
    : `<radialGradient id="${id}" cx="0" cy="0" r="819.2" ${tf}${spread}>${stops}</radialGradient>`);
  return `fill="url(#${id})"`;
}

function el(e: Element, m: Matrix, ct: ColorTransform, c: Ctx, fctx: FrameContext, depth: number, out: string[]) {
  const mm = multiply(m, e.matrix);
  switch (e.type) {
    case 'shape':
      for (const p of e.paths) {
        const d = pathToSvg(transformPath(p.d, mm));
        const fill = p.fill ? paint(applyCTFill(p.fill, ct), c, IDENTITY) : 'fill="none"';
        let stroke = '';
        if (p.stroke) {
          const s = applyCTStroke(p.stroke, ct);
          const sc = Math.sqrt(Math.abs(mm.a * mm.d - mm.b * mm.c)) || 1;
          stroke = ` stroke="${s.color}" stroke-width="${n(Math.max(0.1, s.width * sc))}" stroke-linecap="${s.caps}" stroke-linejoin="${s.joints}"${s.alpha < 1 ? ` stroke-opacity="${n(s.alpha)}"` : ''}`;
        }
        out.push(`<path d="${d}" ${fill}${stroke}/>`);
      }
      break;
    case 'group':
      for (const ch of e.children) el(ch, mm, ct, c, fctx, depth, out);
      break;
    case 'symbol': {
      const sym = c.lib.get(e.libraryItem);
      if (!sym || sym.kind !== 'symbol' || depth > 24) break;
      const f = instanceFrame(e, sym, fctx);
      timeline(sym.timeline, f, mm, concatCT(ct, effectToTransform(e.color)), c, { ...fctx, offset: f }, depth + 1, out);
      break;
    }
    case 'bitmap': {
      const it = c.lib.get(e.libraryItem);
      if (!it || it.kind !== 'bitmap') break;
      const a = c.assets.get(it.assetId);
      if (!a) break;
      let b64 = '';
      const bytes = a.bytes;
      for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push(`<image transform="matrix(${n(mm.a)} ${n(mm.b)} ${n(mm.c)} ${n(mm.d)} ${n(mm.tx)} ${n(mm.ty)})" width="${it.width}" height="${it.height}"${ct.am < 1 ? ` opacity="${n(ct.am)}"` : ''} href="data:${a.mime};base64,${btoa(b64)}"/>`);
      break;
    }
    case 'text': {
      const lay = layoutText(e);
      const [col, alpha] = applyCTColor(e.color, e.alpha, ct);
      const anchor = 'start';
      const lines = lay.lines.map((l) => `<tspan x="${n(l.x)}" y="${n(l.y + e.size * 0.1)}">${esc(l.text)}</tspan>`).join('');
      out.push(`<text transform="matrix(${n(mm.a)} ${n(mm.b)} ${n(mm.c)} ${n(mm.d)} ${n(mm.tx)} ${n(mm.ty)})" font-family="${esc(e.font)}" font-size="${n(e.size)}"${e.bold ? ' font-weight="bold"' : ''}${e.italic ? ' font-style="italic"' : ''} fill="${col}"${alpha < 1 ? ` fill-opacity="${n(alpha)}"` : ''} text-anchor="${anchor}" dominant-baseline="text-before-edge"${e.letterSpacing ? ` letter-spacing="${n(e.letterSpacing)}"` : ''}>${lines}</text>`);
      break;
    }
  }
}

function timeline(tl: Timeline, frame: number, m: Matrix, ct: ColorTransform, c: Ctx, fctx: FrameContext, depth: number, out: string[]) {
  const len = timelineFrameCount(tl);
  for (let i = tl.layers.length - 1; i >= 0; i--) {
    const layer = tl.layers[i];
    if (layer.type === 'folder' || layer.type === 'guide') continue;
    if (!c.includeHidden && !layer.visible) continue;
    const parent = layer.parentId ? tl.layers.find((l) => l.id === layer.parentId) : undefined;
    if (parent?.type === 'mask') continue;
    const draw = (l: typeof layer, into: string[]) => {
      const r = resolveLayerFrame(l, frame);
      if (!r) return;
      const sub = childContext(fctx, r.frame.start, r.frame.duration, len, r.offset);
      for (const e of r.elements) el(e, m, ct, c, sub, depth, into);
    };
    if (layer.type === 'mask') {
      const maskOut: string[] = [];
      draw(layer, maskOut);
      const id = `m${c.nextId++}`;
      c.defs.push(`<clipPath id="${id}">${maskOut.join('').replace(/ fill="[^"]*"| stroke="[^"]*"| fill-opacity="[^"]*"/g, '')}</clipPath>`);
      const inner: string[] = [];
      const kids = tl.layers.filter((l) => l.parentId === layer.id);
      for (let k = kids.length - 1; k >= 0; k--) if (c.includeHidden || kids[k].visible) draw(kids[k], inner);
      out.push(`<g clip-path="url(#${id})">${inner.join('')}</g>`);
      continue;
    }
    draw(layer, out);
  }
}

export function frameToSvg(doc: Doc, tl: Timeline, frame: number, assets: AssetStore, background: boolean, includeHidden = true): string {
  const c: Ctx = { lib: indexLibrary(doc), assets, defs: [], nextId: 1, includeHidden };
  const out: string[] = [];
  timeline(tl, frame, IDENTITY, IDENTITY_CT, c, { offset: frame, elapsed: frame, spanAll: true, playback: true }, 0, out);
  const bg = background ? `<rect width="100%" height="100%" fill="${doc.background}"/>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">
<defs>${c.defs.join('')}</defs>
${bg}${out.join('\n')}
</svg>
`;
}
