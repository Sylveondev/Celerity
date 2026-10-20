// Reads FLA (zipped XFL) documents, including files saved by Adobe Animate.
import type {
  BitmapItem, ColorEffect, Doc, Element, Fill, Frame, Layer, LayerType, LibraryItem, Matrix, ShapeElement, ShapePath, Stroke,
  SymbolInstance, SymbolItem, SymbolType, TextElement, Timeline, LoopMode, BlendMode, FilterDef, SoundItem, VideoItem,
} from '../core/types';
import { parseXml, child, kids, attr, num, bool, path, type XNode } from './xml';
import { readZip, isZip, zlibInflate, type ZipFile } from './zip';
import { parseEdges, reverseChain, chainsToFillPath, chainsToStrokePath, type EdgeSeg } from './xfl-edges';
import { defaultColorEffect, emptyFrame, uid, itemId, nextLayerColor, IDENTITY_CT } from '../core/util';
import { identity } from '../core/matrix';
import { ellipsePath, rectPath } from '../core/path';
import { sniffMime, type AssetStore } from '../core/assets';
import { transformPlanar, type PEdge, type Planar } from '../core/planar';
import { mergeShapeElement } from '../core/merge';
import { readAnimationCore } from './xfl-motion';
import { isMp3, sniffAudio, parseWav, toFlashPcm, parseFlashFormat } from '../core/sound';
import { parseFlv, splitVideoDat } from './flv';

let docFps = 24;

export interface ReadFlaOptions {
  assets: AssetStore;
  /** Encodes decoded RGBA pixels (from .dat bitmaps) into PNG bytes. */
  encodePng(width: number, height: number, rgba: Uint8ClampedArray): Promise<Uint8Array>;
}

export interface ReadResult { doc: Doc; warnings: string[] }

function readMatrix(n: XNode | undefined): Matrix {
  const m = child(n, 'Matrix');
  if (!m) return identity();
  return { a: num(m, 'a', 1), b: num(m, 'b', 0), c: num(m, 'c', 0), d: num(m, 'd', 1), tx: num(m, 'tx', 0), ty: num(m, 'ty', 0) };
}

function readColorNode(n: XNode | undefined): { color: string; alpha: number } {
  return { color: (attr(n, 'color', '#000000') || '#000000').toUpperCase(), alpha: num(n, 'alpha', 1) };
}

function readFill(n: XNode | undefined): Fill | null {
  if (!n) return null;
  const solid = child(n, 'SolidColor');
  if (solid) { const c = readColorNode(solid); return { kind: 'solid', color: c.color, alpha: c.alpha }; }
  const lg = child(n, 'LinearGradient') ?? child(n, 'RadialGradient');
  if (lg) {
    const stops = kids(lg, 'GradientEntry').map((g) => ({ offset: num(g, 'ratio', 0), color: (attr(g, 'color', '#000000')).toUpperCase(), alpha: num(g, 'alpha', 1) }));
    const sm = attr(lg, 'spreadMethod', 'pad');
    return {
      kind: lg.name === 'LinearGradient' ? 'linear' : 'radial',
      stops: stops.length ? stops : [{ offset: 0, color: '#000000', alpha: 1 }, { offset: 1, color: '#FFFFFF', alpha: 1 }],
      matrix: readMatrix(child(lg, 'matrix')),
      spread: sm === 'reflect' || sm === 'repeat' ? sm : 'pad',
    };
  }
  const bf = child(n, 'BitmapFill');
  if (bf) return { kind: 'solid', color: '#808080', alpha: 1 }; // bitmap fills: placeholder
  return null;
}

function readStroke(n: XNode | undefined): Stroke | null {
  if (!n) return null;
  const s = n.children.find((c) => /Stroke$/.test(c.name));
  if (!s) return null;
  const fill = readFill(child(s, 'fill'));
  let color = '#000000', alpha = 1;
  if (fill && fill.kind === 'solid') { color = fill.color; alpha = fill.alpha; }
  else if (fill && fill.stops[0]) { color = fill.stops[0].color; alpha = fill.stops[0].alpha; }
  const caps = attr(s, 'caps', 'round');
  const joints = attr(s, 'joints', 'round');
  return {
    color, alpha,
    width: attr(s, 'solidStyle') === 'hairline' ? 0 : num(s, 'weight', 1),
    caps: caps === 'none' ? 'butt' : caps === 'square' ? 'square' : 'round',
    joints: joints === 'miter' ? 'miter' : joints === 'bevel' ? 'bevel' : 'round',
    miter: num(s, 'miterLimit', 3),
  };
}

/** Raw (merge drawing model) shapes are already planar maps in XFL: keep their edges. */
function readRawShape(n: XNode): ShapeElement {
  const planar: Planar = { fills: [], strokes: [], edges: [] };
  const fIdx = new Map<number, number>(), sIdx = new Map<number, number>();
  for (const fs of kids(child(n, 'fills'), 'FillStyle')) {
    const fl = readFill(fs);
    if (fl) { planar.fills.push(fl); fIdx.set(num(fs, 'index', 0), planar.fills.length); }
  }
  for (const ss of kids(child(n, 'strokes'), 'StrokeStyle')) {
    const st = readStroke(ss);
    if (st) { planar.strokes.push(st); sIdx.set(num(ss, 'index', 0), planar.strokes.length); }
  }
  for (const e of kids(child(n, 'edges'), 'Edge')) {
    const s = attr(e, 'edges');
    if (!s) continue;
    const f0 = fIdx.get(num(e, 'fillStyle0', 0)) ?? 0, f1 = fIdx.get(num(e, 'fillStyle1', 0)) ?? 0, st = sIdx.get(num(e, 'strokeStyle', 0)) ?? 0;
    if (f0 === f1 && !st) continue;
    for (const c of parseEdges(s)) {
      for (const g of c) {
        if (Math.abs(g.x - g.x0) < 1e-9 && Math.abs(g.y - g.y0) < 1e-9 && g.t === 'L') continue;
        const edge: PEdge = g.t === 'L'
          ? [g.x0, g.y0, (g.x0 + g.x) / 2, (g.y0 + g.y) / 2, g.x, g.y, 0, f0, f1, st]
          : [g.x0, g.y0, g.cx, g.cy, g.x, g.y, 1, f0, f1, st];
        planar.edges.push(edge);
      }
    }
  }
  const m = readMatrix(child(n, 'matrix'));
  const ident = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0;
  return mergeShapeElement(uid(), ident ? planar : transformPlanar(planar, m));
}

function readShape(n: XNode): ShapeElement {
  if (!bool(n, 'isDrawingObject', false)) return readRawShape(n);
  const fills = new Map<number, Fill>();
  const strokes = new Map<number, Stroke>();
  for (const fs of kids(child(n, 'fills'), 'FillStyle')) {
    const fl = readFill(fs);
    if (fl) fills.set(num(fs, 'index', 0), fl);
  }
  for (const ss of kids(child(n, 'strokes'), 'StrokeStyle')) {
    const st = readStroke(ss);
    if (st) strokes.set(num(ss, 'index', 0), st);
  }
  const fillChains = new Map<number, EdgeSeg[][]>();
  const strokeChains = new Map<number, EdgeSeg[][]>();
  const push = (m: Map<number, EdgeSeg[][]>, k: number, c: EdgeSeg[]) => {
    const arr = m.get(k);
    if (arr) arr.push(c); else m.set(k, [c]);
  };
  for (const e of kids(child(n, 'edges'), 'Edge')) {
    const s = attr(e, 'edges');
    if (!s) continue;
    const chains = parseEdges(s);
    const f0 = num(e, 'fillStyle0', 0), f1 = num(e, 'fillStyle1', 0), st = num(e, 'strokeStyle', 0);
    for (const c of chains) {
      if (f0) push(fillChains, f0, c);
      if (f1) push(fillChains, f1, reverseChain(c));
      if (st) push(strokeChains, st, c);
    }
  }
  const paths: ShapePath[] = [];
  for (const idx of [...fillChains.keys()].sort((a, b) => a - b)) {
    const fill = fills.get(idx);
    if (!fill) continue;
    paths.push({ fill, stroke: null, d: chainsToFillPath(fillChains.get(idx)!) });
  }
  for (const idx of [...strokeChains.keys()].sort((a, b) => a - b)) {
    const stroke = strokes.get(idx);
    if (!stroke) continue;
    paths.push({ fill: null, stroke, d: chainsToStrokePath(strokeChains.get(idx)!) });
  }
  return { type: 'shape', id: uid(), matrix: readMatrix(child(n, 'matrix')), paths };
}

function readPrimitive(n: XNode): ShapeElement {
  const x = num(n, 'x'), y = num(n, 'y');
  const w = num(n, 'objectWidth'), h = num(n, 'objectHeight');
  const fill = readFill(child(n, 'fill'));
  const stroke = readStroke(child(n, 'stroke'));
  const d = n.name === 'DOMOvalObject'
    ? ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2)
    : rectPath(x, y, w, h, num(n, 'topLeftRadius', 0));
  return { type: 'shape', id: uid(), matrix: readMatrix(child(n, 'matrix')), paths: [{ fill, stroke, d }] };
}

function readColorEffect(n: XNode | undefined): ColorEffect {
  const e = defaultColorEffect();
  const c = child(n, 'Color');
  if (!c) return e;
  const has = (k: string) => c.attrs[k] !== undefined;
  if (has('brightness')) { e.mode = 'brightness'; e.brightness = num(c, 'brightness') * 100; return e; }
  if (has('tintMultiplier') || has('tintColor')) {
    e.mode = 'tint'; e.tintAmount = num(c, 'tintMultiplier', 0) * 100; e.tintColor = attr(c, 'tintColor', '#FFFFFF').toUpperCase(); return e;
  }
  const keys = ['redMultiplier', 'greenMultiplier', 'blueMultiplier', 'redOffset', 'greenOffset', 'blueOffset', 'alphaOffset'];
  if (keys.some(has)) {
    e.mode = 'advanced';
    e.advanced = {
      rm: num(c, 'redMultiplier', 1), gm: num(c, 'greenMultiplier', 1), bm: num(c, 'blueMultiplier', 1), am: num(c, 'alphaMultiplier', 1),
      ro: num(c, 'redOffset', 0), go: num(c, 'greenOffset', 0), bo: num(c, 'blueOffset', 0), ao: num(c, 'alphaOffset', 0),
    };
    return e;
  }
  if (has('alphaMultiplier')) { e.mode = 'alpha'; e.alpha = num(c, 'alphaMultiplier', 1) * 100; }
  return e;
}

function parseFace(face: string): { font: string; bold: boolean; italic: boolean } {
  let f = face || 'Arial';
  const dash = f.indexOf('-');
  const style = dash >= 0 ? f.slice(dash + 1) : '';
  const bold = /bold|black|heavy|semibold/i.test(style);
  const italic = /italic|oblique/i.test(style);
  f = (dash >= 0 ? f.slice(0, dash) : f).replace(/(PSMT|MT|PS)$/, '');
  // split CamelCase family names: "TimesNewRoman" -> "Times New Roman"
  if (!/\s/.test(f)) f = f.replace(/([a-z])([A-Z])/g, '$1 $2');
  return { font: f || 'Arial', bold, italic };
}

function readText(n: XNode): TextElement {
  const runs = kids(child(n, 'textRuns'), 'DOMTextRun');
  let text = '';
  let attrsNode: XNode | undefined;
  for (const r of runs) {
    text += (child(r, 'characters')?.text ?? '');
    if (!attrsNode) attrsNode = path(r, 'textAttrs/DOMTextAttrs');
  }
  const face = parseFace(attr(attrsNode, 'face', 'Arial'));
  const align = attr(attrsNode, 'alignment', 'left');
  const autoExpand = bool(n, 'autoExpand', false);
  return {
    type: 'text', id: uid(), matrix: readMatrix(child(n, 'matrix')),
    text: text.replace(/\r\n?/g, '\n'),
    font: face.font, bold: face.bold, italic: face.italic,
    size: num(attrsNode, 'size', 12),
    color: attr(attrsNode, 'fillColor', '#000000').toUpperCase(),
    alpha: num(attrsNode, 'alpha', 1),
    align: align === 'center' || align === 'right' ? align : 'left',
    width: autoExpand ? 0 : num(n, 'width', 0) + 4,
    lineSpacing: num(attrsNode, 'lineSpacing', 0),
    letterSpacing: num(attrsNode, 'letterSpacing', 0),
  };
}

const BLEND_MODES = new Set(['normal', 'layer', 'multiply', 'screen', 'lighten', 'darken', 'difference', 'add', 'subtract', 'invert', 'overlay', 'hardlight']);

function readFilter(f: XNode, warn: (s: string) => void): FilterDef | null {
  const common = { blurX: num(f, 'blurX', 5), blurY: num(f, 'blurY', 5), quality: num(f, 'quality', 1) };
  switch (f.name) {
    case 'BlurFilter': return { type: 'blur', ...common };
    case 'DropShadowFilter':
      return {
        type: 'dropShadow', ...common, strength: num(f, 'strength', 1), color: attr(f, 'color', '#000000').toUpperCase(), alpha: num(f, 'alpha', 1),
        angle: num(f, 'angle', 45), distance: num(f, 'distance', 5), inner: bool(f, 'inner'), knockout: bool(f, 'knockout'), hideObject: bool(f, 'hideObject'),
      };
    case 'GlowFilter':
      return { type: 'glow', ...common, strength: num(f, 'strength', 1), color: attr(f, 'color', '#FF0000').toUpperCase(), alpha: num(f, 'alpha', 1), inner: bool(f, 'inner'), knockout: bool(f, 'knockout') };
    default:
      warn(`Filter <${f.name}> is not supported yet and was skipped.`);
      return null;
  }
}

function readElement(n: XNode, warn: (s: string) => void): Element | null {
  switch (n.name) {
    case 'DOMShape': return readShape(n);
    case 'DOMRectangleObject':
    case 'DOMOvalObject':
      return readPrimitive(n);
    case 'DOMGroup': {
      const children = kids(child(n, 'members')).map((c) => readElement(c, warn)).filter((e): e is Element => !!e);
      return { type: 'group', id: uid(), matrix: identity(), children };
    }
    case 'DOMSymbolInstance': {
      const st = attr(n, 'symbolType', '');
      const symbolType: SymbolType = st === 'graphic' ? 'graphic' : st === 'button' ? 'button' : 'movieclip';
      const tp = path(n, 'transformationPoint/Point');
      const inst: SymbolInstance = {
        type: 'symbol', id: uid(), matrix: readMatrix(child(n, 'matrix')),
        libraryItem: attr(n, 'libraryItemName'),
        symbolType,
        loop: (attr(n, 'loop', 'loop') as LoopMode),
        firstFrame: num(n, 'firstFrame', 0),
        name: attr(n, 'name', ''),
        color: readColorEffect(child(n, 'color')),
        transformPoint: { x: num(tp, 'x', 0), y: num(tp, 'y', 0) },
        blendMode: BLEND_MODES.has(attr(n, 'blendMode', '')) ? attr(n, 'blendMode') as BlendMode : undefined,
      };
      const filters = kids(child(n, 'filters')).map((f) => readFilter(f, warn)).filter((f): f is FilterDef => !!f);
      if (filters.length) inst.filters = filters;
      return inst;
    }
    case 'DOMBitmapInstance':
      return { type: 'bitmap', id: uid(), matrix: readMatrix(child(n, 'matrix')), libraryItem: attr(n, 'libraryItemName') };
    case 'DOMVideoInstance':
      return {
        type: 'video', id: uid(), matrix: readMatrix(child(n, 'matrix')), libraryItem: attr(n, 'libraryItemName'),
        width: num(n, 'frameRight', 6400) / 20, height: num(n, 'frameBottom', 4800) / 20,
      };
    case 'DOMStaticText':
    case 'DOMDynamicText':
    case 'DOMInputText':
      return readText(n);
    case 'DOMTLFText':
      warn('TLF text was converted to static text.');
      return readText(n);
    default:
      warn(`Unsupported element <${n.name}> was skipped.`);
      return null;
  }
}

function readFrame(n: XNode, warn: (s: string) => void): Frame {
  const fr = emptyFrame(num(n, 'index', 0), Math.max(1, num(n, 'duration', 1)));
  const tt = attr(n, 'tweenType', '');
  fr.tween = tt === 'motion' ? 'classic' : tt === 'shape' ? 'shape' : 'none';
  if (tt === 'motion object') {
    const core = path(n, 'motionObjectXML/AnimationCore');
    if (core) {
      fr.tween = 'motion';
      fr.motion = readAnimationCore(core, docFps);
      // the Properties panel ease maps to the first time map
      const tm = fr.motion.timeMaps[0];
      if (tm && tm.type === 'Quadratic') fr.ease = tm.strength;
    }
  }
  if (fr.tween !== 'motion') fr.ease = num(n, 'acceleration', 0);
  const rot = attr(n, 'motionTweenRotate', 'auto');
  fr.rotate = rot === 'clockwise' ? 'cw' : rot === 'counter-clockwise' ? 'ccw' : rot === 'none' ? 'none' : 'auto';
  fr.rotateTimes = num(n, 'motionTweenRotateTimes', 0);
  fr.label = attr(n, 'name', '');
  const lt = attr(n, 'labelType', 'name');
  fr.labelType = lt === 'comment' ? 'comment' : lt === 'anchor' ? 'anchor' : 'name';
  const script = path(n, 'Actionscript/script');
  if (script) fr.script = script.text;
  const snd = attr(n, 'soundName', '');
  if (snd) {
    const sync = attr(n, 'soundSync', 'event');
    fr.sound = {
      name: snd,
      sync: sync === 'start' || sync === 'stop' || sync === 'stream' ? sync : 'event',
      loopMode: attr(n, 'soundLoopMode', 'repeat') === 'loop' ? 'loop' : 'repeat',
      loops: Math.max(1, num(n, 'soundLoop', 1)),
    };
  }
  fr.elements = kids(child(n, 'elements')).map((e) => readElement(e, warn)).filter((e): e is Element => !!e);
  return fr;
}

function readTimeline(n: XNode, warn: (s: string) => void): Timeline {
  const layerNodes = kids(child(n, 'layers'), 'DOMLayer');
  const layers: Layer[] = layerNodes.map((ln) => {
    const lt = attr(ln, 'layerType', 'normal');
    const type: LayerType = lt === 'guide' || lt === 'mask' || lt === 'folder' ? lt : 'normal';
    const frames = kids(child(ln, 'frames'), 'DOMFrame').map((f) => readFrame(f, warn)).sort((a, b) => a.start - b.start);
    // normalize: contiguous from 0, no overlaps
    const fixed: Frame[] = [];
    let pos = 0;
    for (const fr of frames) {
      if (fr.start > pos) fixed.push(emptyFrame(pos, fr.start - pos));
      if (fr.start < pos) { fr.duration -= pos - fr.start; fr.start = pos; if (fr.duration <= 0) continue; }
      fixed.push(fr);
      pos = fr.start + fr.duration;
    }
    if (!fixed.length) fixed.push(emptyFrame(0, 1));
    return {
      id: uid(), name: attr(ln, 'name', 'Layer'), type, parentId: null,
      visible: attr(ln, 'visible', 'true') !== 'false',
      locked: bool(ln, 'locked'),
      outline: bool(ln, 'outline') || bool(ln, 'useOutlineView'),
      color: attr(ln, 'color', nextLayerColor()).toUpperCase(),
      open: type === 'folder' ? attr(ln, 'open', 'true') !== 'false' : undefined,
      frames: fixed,
    };
  });
  layerNodes.forEach((ln, i) => {
    const p = ln.attrs.parentLayerIndex;
    if (p !== undefined) {
      const parent = layers[parseInt(p, 10)];
      if (parent && parent !== layers[i]) layers[i].parentId = parent.id;
    }
  });
  if (!layers.length) layers.push({ id: uid(), name: 'Layer_1', type: 'normal', parentId: null, visible: true, locked: false, outline: false, color: nextLayerColor(), frames: [emptyFrame(0, 1)] });
  return { name: attr(n, 'name', 'Scene 1'), layers };
}

/** Decodes Animate's bin/*.dat bitmap format. Returns RGBA or a JPEG/PNG passthrough. */
export async function decodeDat(bytes: Uint8Array): Promise<{ kind: 'rgba'; width: number; height: number; data: Uint8ClampedArray } | { kind: 'encoded'; bytes: Uint8Array } | null> {
  if (bytes.length < 4) return null;
  const mime = sniffMime(bytes);
  if (mime !== 'application/octet-stream') return { kind: 'encoded', bytes };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isLossless = (bytes[0] === 0x03 && bytes[1] === 0x05) || (bytes[0] === 0x05 && bytes[1] === 0x03);
  if (!isLossless || bytes.length < 26) return null;
  const rowBytes = dv.getUint16(2, true);
  const width = dv.getUint16(4, true);
  const height = dv.getUint16(6, true);
  const compressed = bytes[25];
  let p = 26;
  let raw: Uint8Array;
  if (compressed) {
    const parts: Uint8Array[] = [];
    let total = 0;
    while (p + 2 <= bytes.length) {
      const len = dv.getUint16(p, true);
      p += 2;
      if (len === 0) break;
      parts.push(bytes.subarray(p, p + len));
      total += len;
      p += len;
    }
    const z = new Uint8Array(total);
    let o = 0;
    for (const part of parts) { z.set(part, o); o += part.length; }
    raw = await zlibInflate(z);
  } else {
    raw = bytes.subarray(p);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = y * rowBytes + x * 4;
      const d = (y * width + x) * 4;
      const a = raw[s];
      const un = a > 0 && a < 255 ? 255 / a : 1;
      out[d] = Math.min(255, raw[s + 1] * un);
      out[d + 1] = Math.min(255, raw[s + 2] * un);
      out[d + 2] = Math.min(255, raw[s + 3] * un);
      out[d + 3] = a;
    }
  }
  return { kind: 'rgba', width, height, data: out };
}

export async function readFla(bytes: Uint8Array, opts: ReadFlaOptions): Promise<ReadResult> {
  if (!isZip(bytes)) {
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
      throw new Error('This is a legacy binary FLA (Flash CS4 or older). Open and re-save it in Animate CC or Flash CS5+ first.');
    }
    throw new Error('This file is not a valid FLA document.');
  }
  return readXfl(readZip(bytes), opts);
}

async function mediaBytes(zip: ZipFile, prefix: string, dat: string, name: string): Promise<Uint8Array | null> {
  if (dat && zip.has(`${prefix}bin/${dat}`)) return zip.read(`${prefix}bin/${dat}`);
  if (name && zip.has(`${prefix}LIBRARY/${name}`)) return zip.read(`${prefix}LIBRARY/${name}`);
  return null;
}

async function readSoundItem(n: XNode, zip: ZipFile, prefix: string, opts: ReadFlaOptions, warn: (s: string) => void): Promise<SoundItem | null> {
  const name = attr(n, 'name');
  let bytes = await mediaBytes(zip, prefix, attr(n, 'soundDataHRef'), attr(n, 'href', name)).catch(() => null);
  if (!bytes) { warn(`Sound "${name}" has no data and was skipped.`); return null; }
  let format = attr(n, 'format', '44kHz 16bit Stereo');
  let codec: SoundItem['codec'];
  let sampleCount = num(n, 'sampleCount', 0);
  if (isMp3(bytes)) {
    // Animate appends a PCM preview cache after the MP3 frames
    const len = num(n, 'dataLength', 0);
    if (len > 0 && len < bytes.length) bytes = bytes.slice(0, len);
    codec = 'mp3';
  } else if (sniffAudio(bytes) === 'audio/wav') {
    const pcm = parseWav(bytes);
    if (!pcm) { warn(`Sound "${name}" could not be decoded.`); return null; }
    const f = toFlashPcm(pcm);
    bytes = f.bytes; format = f.format; sampleCount = f.sampleCount; codec = 'pcm';
  } else codec = parseFlashFormat(format).adpcm ? 'adpcm' : 'pcm';
  const asset = opts.assets.addRaw(bytes, codec === 'mp3' ? 'audio/mpeg' : 'audio/x-flash-pcm');
  return { kind: 'sound', name, itemID: attr(n, 'itemID', itemId()), assetId: asset.id, codec, format, sampleCount };
}

async function readVideoItem(n: XNode, zip: ZipFile, prefix: string, opts: ReadFlaOptions, warn: (s: string) => void): Promise<VideoItem | null> {
  const name = attr(n, 'name');
  const bytes = await mediaBytes(zip, prefix, attr(n, 'videoDataHRef'), name).catch(() => null);
  if (!bytes) { warn(`Video "${name}" has no data and was skipped.`); return null; }
  const { prefix: pre, stream, mime } = splitVideoDat(bytes);
  const flv = mime === 'video/x-flv' ? parseFlv(stream) : null;
  const asset = opts.assets.addRaw(stream.slice(), mime);
  return {
    kind: 'video', name, itemID: attr(n, 'itemID', itemId()), assetId: asset.id, mime,
    width: num(n, 'width', 0) || flv?.width || 320,
    height: num(n, 'height', 0) || flv?.height || 240,
    fps: num(n, 'fps', 0) || flv?.fps || docFps,
    duration: num(n, 'length', 0) || flv?.duration || 0,
    videoType: attr(n, 'videoType', '') || undefined,
    datPrefix: pre.length ? [...pre] : undefined,
  };
}

export async function readXfl(zip: ZipFile, opts: ReadFlaOptions): Promise<ReadResult> {
  const warnings = new Set<string>();
  const warn = (s: string) => warnings.add(s);
  const domName = zip.names().find((n) => /(^|\/)DOMDocument\.xml$/i.test(n));
  if (!domName) throw new Error('DOMDocument.xml not found in FLA.');
  const prefix = domName.slice(0, domName.length - 'DOMDocument.xml'.length);
  const dom = parseXml(await zip.readText(domName));
  docFps = num(dom, 'frameRate', 24) || 24;
  const doc: Doc = {
    width: num(dom, 'width', 550),
    height: num(dom, 'height', 400),
    fps: num(dom, 'frameRate', 24),
    background: attr(dom, 'backgroundColor', '#FFFFFF').toUpperCase(),
    scenes: [],
    library: [],
  };
  const library: LibraryItem[] = [];
  for (const fn of kids(child(dom, 'folders'), 'DOMFolderItem')) {
    library.push({ kind: 'folder', name: attr(fn, 'name'), itemID: attr(fn, 'itemID', itemId()) });
  }
  // bitmaps
  for (const bn of kids(child(dom, 'media'))) {
    if (bn.name === 'DOMSoundItem') { const it = await readSoundItem(bn, zip, prefix, opts, warn); if (it) library.push(it); continue; }
    if (bn.name === 'DOMVideoItem') { const it = await readVideoItem(bn, zip, prefix, opts, warn); if (it) library.push(it); continue; }
    if (bn.name !== 'DOMBitmapItem') {
      warn(`Media item <${bn.name}> is not supported and was skipped.`);
      continue;
    }
    const name = attr(bn, 'name');
    let asset = null;
    try {
      const dat = attr(bn, 'bitmapDataHRef');
      const href = attr(bn, 'href');
      let decoded: Awaited<ReturnType<typeof decodeDat>> = null;
      if (dat && zip.has(`${prefix}bin/${dat}`)) decoded = await decodeDat(await zip.read(`${prefix}bin/${dat}`));
      if (!decoded && href && zip.has(`${prefix}LIBRARY/${href}`)) decoded = { kind: 'encoded', bytes: await zip.read(`${prefix}LIBRARY/${href}`) };
      if (decoded?.kind === 'encoded') asset = await opts.assets.add(decoded.bytes, sniffMime(decoded.bytes));
      else if (decoded?.kind === 'rgba') {
        const png = await opts.encodePng(decoded.width, decoded.height, decoded.data);
        asset = await opts.assets.add(png, 'image/png');
      }
    } catch (e) {
      console.warn(e);
    }
    if (!asset) warn(`Bitmap "${name}" could not be decoded.`);
    const item: BitmapItem = {
      kind: 'bitmap', name, itemID: attr(bn, 'itemID', itemId()), assetId: asset?.id ?? '',
      width: asset?.width || num(bn, 'frameRight', 400) / 20,
      height: asset?.height || num(bn, 'frameBottom', 400) / 20,
      smoothing: attr(bn, 'allowSmoothing', 'true') !== 'false',
    };
    library.push(item);
  }
  // symbols
  for (const inc of kids(child(dom, 'symbols'), 'Include')) {
    const href = attr(inc, 'href');
    const file = `${prefix}LIBRARY/${href}`;
    if (!zip.has(file)) { warn(`Library symbol file "${href}" is missing.`); continue; }
    try {
      const sx = parseXml(await zip.readText(file));
      const st = attr(sx, 'symbolType', '');
      const tln = path(sx, 'timeline/DOMTimeline');
      const sym: SymbolItem = {
        kind: 'symbol',
        name: attr(sx, 'name', href.replace(/\.xml$/i, '')),
        symbolType: st === 'graphic' ? 'graphic' : st === 'button' ? 'button' : 'movieclip',
        timeline: tln ? readTimeline(tln, warn) : { name: 'Symbol', layers: [] },
        itemID: attr(sx, 'itemID', itemId()),
      };
      if (!sym.timeline.layers.length) sym.timeline.layers.push({ id: uid(), name: 'Layer_1', type: 'normal', parentId: null, visible: true, locked: false, outline: false, color: nextLayerColor(), frames: [emptyFrame(0, 1)] });
      library.push(sym);
    } catch (e) {
      warn(`Symbol "${href}" could not be read: ${(e as Error).message}`);
    }
  }
  doc.library = library;
  doc.scenes = kids(child(dom, 'timelines'), 'DOMTimeline').map((t) => readTimeline(t, warn));
  if (!doc.scenes.length) doc.scenes.push({ name: 'Scene 1', layers: [{ id: uid(), name: 'Layer_1', type: 'normal', parentId: null, visible: true, locked: false, outline: false, color: nextLayerColor(), frames: [emptyFrame(0, 1)] }] });
  void IDENTITY_CT;
  return { doc, warnings: [...warnings] };
}
