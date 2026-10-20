// Writes documents as FLA files (zipped XFL), the format used by Animate CS5+.
import type {
  BitmapItem, ColorEffect, Doc, Element, Fill, Frame, Layer, Matrix, ShapeElement, ShapePath, Stroke, SymbolItem, Timeline, TextElement,
} from '../core/types';
import { XmlWriter } from './xml';
import { encodeEdges, fillSide } from './xfl-edges';
import { writeZip, zlibDeflate, type ZipEntryIn } from './zip';
import { multiply, IDENTITY } from '../core/matrix';
import { transformPath } from '../core/path';
import { fmtNum, baseName, folderOf } from '../core/util';
import { layoutText } from '../core/symbols';
import type { AssetStore } from '../core/assets';

const NS = { 'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance', xmlns: 'http://ns.adobe.com/xfl/2008/' };

export interface PixelSource {
  /** Returns RGBA pixels for a library bitmap (decoded asset). */
  pixels(assetId: string): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null>;
}

const f = (n: number) => fmtNum(n, 6);

function matrixAttrs(m: Matrix): Record<string, string | undefined> {
  return {
    a: m.a !== 1 ? f(m.a) : undefined,
    b: m.b !== 0 ? f(m.b) : undefined,
    c: m.c !== 0 ? f(m.c) : undefined,
    d: m.d !== 1 ? f(m.d) : undefined,
    tx: m.tx !== 0 ? f(m.tx) : undefined,
    ty: m.ty !== 0 ? f(m.ty) : undefined,
  };
}

function writeMatrix(w: XmlWriter, m: Matrix, tag = 'matrix') {
  if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0) return;
  w.open(tag).leaf('Matrix', matrixAttrs(m)).close();
}

function writeFill(w: XmlWriter, fill: Fill) {
  if (fill.kind === 'solid') {
    w.leaf('SolidColor', { color: fill.color.toUpperCase(), alpha: fill.alpha < 1 ? f(fill.alpha) : undefined });
    return;
  }
  const tag = fill.kind === 'linear' ? 'LinearGradient' : 'RadialGradient';
  w.open(tag, { spreadMethod: fill.spread && fill.spread !== 'pad' ? fill.spread : undefined });
  w.open('matrix').leaf('Matrix', matrixAttrs(fill.matrix)).close();
  for (const s of fill.stops) {
    w.leaf('GradientEntry', { color: s.color.toUpperCase(), alpha: s.alpha < 1 ? f(s.alpha) : undefined, ratio: f(s.offset) });
  }
  w.close();
}

function writeStroke(w: XmlWriter, s: Stroke) {
  w.open('SolidStroke', {
    scaleMode: 'normal',
    weight: f(Math.max(0.1, s.width)),
    caps: s.caps === 'butt' ? 'none' : s.caps === 'square' ? 'square' : undefined,
    joints: s.joints === 'round' ? undefined : s.joints,
    miterLimit: s.joints === 'miter' ? f(s.miter ?? 3) : undefined,
  });
  w.open('fill');
  w.leaf('SolidColor', { color: s.color.toUpperCase(), alpha: s.alpha < 1 ? f(s.alpha) : undefined });
  w.close();
  w.close();
}

function writeShapePaths(w: XmlWriter, paths: ShapePath[], m: Matrix, isDrawingObject: boolean) {
  w.open('DOMShape', { isDrawingObject: isDrawingObject ? 'true' : undefined });
  const fills: Fill[] = [];
  const strokes: Stroke[] = [];
  const edges: { d: number[]; fill: number; side: 0 | 1; stroke: number }[] = [];
  for (const p of paths) {
    const d = transformPath(p.d, m);
    let fi = 0, si = 0;
    if (p.fill) {
      const fill = p.fill.kind === 'solid' ? p.fill : { ...p.fill, matrix: multiply(m, p.fill.matrix) };
      fills.push(fill);
      fi = fills.length;
    }
    if (p.stroke) {
      const sc = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;
      strokes.push({ ...p.stroke, width: p.stroke.width * sc });
      si = strokes.length;
    }
    if (fi || si) edges.push({ d, fill: fi, side: fi ? fillSide(d) : 1, stroke: si });
  }
  if (fills.length) {
    w.open('fills');
    fills.forEach((fl, i) => { w.open('FillStyle', { index: i + 1 }); writeFill(w, fl); w.close(); });
    w.close();
  }
  if (strokes.length) {
    w.open('strokes');
    strokes.forEach((s, i) => { w.open('StrokeStyle', { index: i + 1 }); writeStroke(w, s); w.close(); });
    w.close();
  }
  w.open('edges');
  for (const e of edges) {
    const enc = encodeEdges(e.d);
    if (!enc) continue;
    w.leaf('Edge', {
      fillStyle0: e.fill && e.side === 0 ? e.fill : undefined,
      fillStyle1: e.fill && e.side === 1 ? e.fill : undefined,
      strokeStyle: e.stroke || undefined,
      edges: enc,
    });
  }
  w.close();
  w.close();
}

function writeShape(w: XmlWriter, el: ShapeElement, parent: Matrix) {
  const m = multiply(parent, el.matrix);
  if (el.paths.length <= 1) {
    writeShapePaths(w, el.paths, m, true);
    return;
  }
  // Overlapping paths must be separate drawing objects in XFL: wrap in a group.
  w.open('DOMGroup').open('members');
  for (const p of el.paths) writeShapePaths(w, [p], m, true);
  w.close().close();
}

function writeColor(w: XmlWriter, c: ColorEffect) {
  switch (c.mode) {
    case 'alpha':
      w.open('color').leaf('Color', { alphaMultiplier: f(c.alpha / 100) }).close();
      break;
    case 'brightness':
      w.open('color').leaf('Color', { brightness: f(c.brightness / 100) }).close();
      break;
    case 'tint':
      w.open('color').leaf('Color', { tintMultiplier: f(c.tintAmount / 100), tintColor: c.tintColor.toUpperCase() }).close();
      break;
    case 'advanced': {
      const a = c.advanced;
      w.open('color').leaf('Color', {
        redMultiplier: a.rm !== 1 ? f(a.rm) : undefined,
        greenMultiplier: a.gm !== 1 ? f(a.gm) : undefined,
        blueMultiplier: a.bm !== 1 ? f(a.bm) : undefined,
        alphaMultiplier: a.am !== 1 ? f(a.am) : undefined,
        redOffset: a.ro ? Math.round(a.ro) : undefined,
        greenOffset: a.go ? Math.round(a.go) : undefined,
        blueOffset: a.bo ? Math.round(a.bo) : undefined,
        alphaOffset: a.ao ? Math.round(a.ao) : undefined,
      }).close();
      break;
    }
  }
}

function postscriptFace(t: TextElement): string {
  const fam = t.font.replace(/\s+/g, '');
  if (t.bold && t.italic) return `${fam}-BoldItalic`;
  if (t.bold) return `${fam}-Bold`;
  if (t.italic) return `${fam}-Italic`;
  return t.font;
}

function writeText(w: XmlWriter, t: TextElement, parent: Matrix) {
  const lay = layoutText(t);
  w.open('DOMStaticText', {
    width: f(Math.max(1, lay.width - 4)),
    height: f(Math.max(1, lay.height - 4)),
    autoExpand: t.width > 0 ? undefined : 'true',
    isSelectable: 'false',
  });
  writeMatrix(w, multiply(parent, t.matrix));
  w.open('textRuns').open('DOMTextRun');
  w.textEl('characters', t.text.replace(/\n/g, '\r'));
  w.open('textAttrs').leaf('DOMTextAttrs', {
    alignment: t.align !== 'left' ? t.align : undefined,
    aliasText: 'false',
    size: f(t.size),
    bitmapSize: Math.round(t.size * 20),
    face: postscriptFace(t),
    fillColor: t.color.toUpperCase(),
    alpha: t.alpha < 1 ? f(t.alpha) : undefined,
    letterSpacing: t.letterSpacing ? f(t.letterSpacing) : undefined,
    lineSpacing: t.lineSpacing ? f(t.lineSpacing) : undefined,
  }).close();
  w.close().close();
  w.close();
}

function writeElement(w: XmlWriter, el: Element, parent: Matrix = IDENTITY) {
  switch (el.type) {
    case 'shape':
      writeShape(w, el, parent);
      break;
    case 'group':
      w.open('DOMGroup').open('members');
      for (const c of el.children) writeElement(w, c, multiply(parent, el.matrix));
      w.close().close();
      break;
    case 'symbol': {
      const m = multiply(parent, el.matrix);
      w.open('DOMSymbolInstance', {
        libraryItemName: el.libraryItem,
        name: el.name || undefined,
        symbolType: el.symbolType === 'movieclip' ? undefined : el.symbolType,
        loop: el.symbolType === 'graphic' && el.loop !== 'loop' ? el.loop : undefined,
        firstFrame: el.symbolType === 'graphic' && el.firstFrame ? el.firstFrame : undefined,
        blendMode: el.blendMode && el.blendMode !== 'normal' ? el.blendMode : undefined,
      });
      writeMatrix(w, m);
      w.open('transformationPoint').leaf('Point', { x: f(el.transformPoint.x), y: f(el.transformPoint.y) }).close();
      writeColor(w, el.color);
      if (el.filters && el.filters.length && el.symbolType !== 'graphic') {
        w.open('filters');
        for (const fl of el.filters) {
          const common = { blurX: f(fl.blurX), blurY: f(fl.blurY), quality: Math.round(fl.quality) };
          if (fl.type === 'blur') w.leaf('BlurFilter', common);
          else if (fl.type === 'dropShadow') {
            w.leaf('DropShadowFilter', { ...common, angle: f(fl.angle), distance: f(fl.distance), color: fl.color, alpha: fl.alpha < 1 ? f(fl.alpha) : undefined, strength: f(fl.strength), inner: fl.inner ? 'true' : undefined, knockout: fl.knockout ? 'true' : undefined, hideObject: fl.hideObject ? 'true' : undefined });
          } else {
            w.leaf('GlowFilter', { ...common, color: fl.color, alpha: fl.alpha < 1 ? f(fl.alpha) : undefined, strength: f(fl.strength), inner: fl.inner ? 'true' : undefined, knockout: fl.knockout ? 'true' : undefined });
          }
        }
        w.close();
      }
      w.close();
      break;
    }
    case 'bitmap':
      w.open('DOMBitmapInstance', { libraryItemName: el.libraryItem });
      writeMatrix(w, multiply(parent, el.matrix));
      w.close();
      break;
    case 'text':
      writeText(w, el, parent);
      break;
  }
}

const KEYMODE = { none: 9728, classic: 22017, shape: 17922 };

function writeFrame(w: XmlWriter, fr: Frame) {
  w.open('DOMFrame', {
    index: fr.start,
    duration: fr.duration > 1 ? fr.duration : undefined,
    tweenType: fr.tween === 'classic' ? 'motion' : fr.tween === 'shape' ? 'shape' : undefined,
    motionTweenSnap: fr.tween === 'classic' ? 'true' : undefined,
    motionTweenRotate: fr.tween === 'classic' && fr.rotate !== 'auto'
      ? (fr.rotate === 'cw' ? 'clockwise' : fr.rotate === 'ccw' ? 'counter-clockwise' : 'none') : undefined,
    motionTweenRotateTimes: fr.tween === 'classic' && (fr.rotate === 'cw' || fr.rotate === 'ccw') && fr.rotateTimes ? fr.rotateTimes : undefined,
    acceleration: fr.tween !== 'none' && fr.ease ? Math.round(fr.ease) : undefined,
    name: fr.label || undefined,
    labelType: fr.label ? fr.labelType : undefined,
    keyMode: KEYMODE[fr.tween],
  });
  if (fr.script && fr.script.trim()) {
    w.open('Actionscript');
    w.cdataEl('script', fr.script);
    w.close();
  }
  w.open('elements');
  for (const el of fr.elements) writeElement(w, el);
  w.close();
  w.close();
}

function writeLayer(w: XmlWriter, layer: Layer, layers: Layer[], current: boolean) {
  const parentIdx = layer.parentId ? layers.findIndex((l) => l.id === layer.parentId) : -1;
  w.open('DOMLayer', {
    name: layer.name,
    color: layer.color.toUpperCase(),
    layerType: layer.type !== 'normal' ? layer.type : undefined,
    parentLayerIndex: parentIdx >= 0 ? parentIdx : undefined,
    current: current ? 'true' : undefined,
    isSelected: current ? 'true' : undefined,
    visible: layer.visible ? undefined : 'false',
    locked: layer.locked ? 'true' : undefined,
    outline: layer.outline ? 'true' : undefined,
    open: layer.type === 'folder' ? (layer.open === false ? 'false' : 'true') : undefined,
    autoNamed: 'false',
  });
  if (layer.type !== 'folder') {
    w.open('frames');
    for (const fr of layer.frames) writeFrame(w, fr);
    w.close();
  }
  w.close();
}

export function writeTimeline(w: XmlWriter, tl: Timeline) {
  w.open('DOMTimeline', { name: tl.name });
  w.open('layers');
  const firstNormal = tl.layers.findIndex((l) => l.type !== 'folder');
  tl.layers.forEach((l, i) => writeLayer(w, l, tl.layers, i === firstNormal));
  w.close();
  w.close();
}

function symbolXml(sym: SymbolItem, now: number): string {
  const w = new XmlWriter();
  w.open('DOMSymbolItem', {
    ...NS,
    name: sym.name,
    itemID: sym.itemID,
    symbolType: sym.symbolType === 'movieclip' ? undefined : sym.symbolType,
    lastModified: now,
  });
  w.open('timeline');
  writeTimeline(w, sym.timeline);
  w.close();
  w.close();
  return w.toString();
}

/** Encodes RGBA pixels into Animate's lossless bitmap .dat format. */
export async function encodeDat(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  const argb = new Uint8Array(width * height * 4);
  let hasAlpha = 0;
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a !== 255) hasAlpha = 1;
    // premultiplied ARGB
    argb[i * 4] = a;
    argb[i * 4 + 1] = Math.round((r * a) / 255);
    argb[i * 4 + 2] = Math.round((g * a) / 255);
    argb[i * 4 + 3] = Math.round((b * a) / 255);
  }
  const z = await zlibDeflate(argb);
  const header = new Uint8Array(28);
  const dv = new DataView(header.buffer);
  header[0] = 0x03; header[1] = 0x05;
  dv.setUint16(2, width * 4, true);
  dv.setUint16(4, width, true);
  dv.setUint16(6, height, true);
  dv.setUint32(8, 0, true);
  dv.setUint32(12, width * 20, true);
  dv.setUint32(16, 0, true);
  dv.setUint32(20, height * 20, true);
  header[24] = hasAlpha;
  header[25] = 1; // compressed
  // zlib stream split into chunks: [u16 len][bytes]... terminated by u16 0.
  // The 2-byte zlib header is written as its own chunk like Animate does.
  const chunks: Uint8Array[] = [z.subarray(0, 2)];
  for (let o = 2; o < z.length; o += 4096) chunks.push(z.subarray(o, Math.min(z.length, o + 4096)));
  let total = header.length - 2 + 2; // header without trailing 2 reserved bytes + terminator
  for (const c of chunks) total += 2 + c.length;
  const out = new Uint8Array(total);
  out.set(header.subarray(0, 26), 0);
  let p = 26;
  const ov = new DataView(out.buffer);
  for (const c of chunks) {
    ov.setUint16(p, c.length, true); p += 2;
    out.set(c, p); p += c.length;
  }
  ov.setUint16(p, 0, true);
  return out;
}

export interface WriteFlaOptions { assets: AssetStore; pixels: PixelSource['pixels'] }

export async function writeFla(doc: Doc, opts: WriteFlaOptions): Promise<Uint8Array> {
  const now = Math.floor(Date.now() / 1000);
  const entries: ZipEntryIn[] = [{ name: 'mimetype', data: 'application/vnd.adobe.xfl', store: true }];
  const w = new XmlWriter();
  w.open('DOMDocument', {
    ...NS,
    backgroundColor: doc.background.toUpperCase(),
    width: Math.round(doc.width),
    height: Math.round(doc.height),
    frameRate: f(doc.fps),
    currentTimeline: 1,
    xflVersion: '2.97',
    creatorInfo: 'Celerity',
    platform: typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'Macintosh' : 'Windows',
    versionInfo: 'Saved by Celerity',
    majorVersion: '19',
    buildNumber: '0',
    nextSceneIdentifier: doc.scenes.length + 1,
    playOptionsPlayLoop: 'false',
    playOptionsPlayPages: 'false',
    playOptionsPlayFrameActions: 'false',
  });

  // folders (explicit + implied by item paths)
  const folderNames = new Set<string>();
  for (const it of doc.library) {
    if (it.kind === 'folder') folderNames.add(it.name);
    let p = folderOf(it.name);
    while (p) { folderNames.add(p); p = folderOf(p); }
  }
  if (folderNames.size) {
    w.open('folders');
    for (const name of [...folderNames].sort()) {
      const it = doc.library.find((i) => i.name === name);
      w.leaf('DOMFolderItem', { name, itemID: it?.itemID ?? `${(Math.random() * 1e8) | 0}-folder`, isExpanded: 'true' });
    }
    w.close();
  }

  const bitmaps = doc.library.filter((i): i is BitmapItem => i.kind === 'bitmap');
  if (bitmaps.length) {
    w.open('media');
    let k = 0;
    for (const b of bitmaps) {
      const asset = opts.assets.get(b.assetId);
      const datName = `M ${++k} ${now}.dat`;
      const ext = asset?.mime === 'image/jpeg' ? '' : (/\.(png|jpe?g|gif|bmp)$/i.test(b.name) ? '' : '.png');
      const href = b.name + ext;
      const px = await opts.pixels(b.assetId);
      if (px) entries.push({ name: `bin/${datName}`, data: await encodeDat(px.width, px.height, px.data) });
      if (asset) entries.push({ name: `LIBRARY/${href}`, data: asset.bytes });
      w.leaf('DOMBitmapItem', {
        name: b.name,
        itemID: b.itemID,
        sourceExternalFilepath: `./LIBRARY/${href}`,
        sourceLastImported: now,
        allowSmoothing: b.smoothing ? 'true' : undefined,
        useImportedJPEGData: 'false',
        compressionType: 'lossless',
        originalCompressionType: 'lossless',
        quality: 50,
        href,
        bitmapDataHRef: px ? datName : undefined,
        frameRight: Math.round(b.width * 20),
        frameBottom: Math.round(b.height * 20),
      });
    }
    w.close();
  }

  const symbols = doc.library.filter((i): i is SymbolItem => i.kind === 'symbol');
  if (symbols.length) {
    w.open('symbols');
    for (const s of symbols) {
      const href = `${s.name}.xml`;
      entries.push({ name: `LIBRARY/${href}`, data: symbolXml(s, now) });
      w.leaf('Include', {
        href,
        itemIcon: s.symbolType === 'graphic' ? 1 : s.symbolType === 'button' ? 0 : undefined,
        loadImmediate: 'false',
        itemID: s.itemID,
        lastModified: now,
      });
    }
    w.close();
  }

  w.open('timelines');
  for (const tl of doc.scenes) writeTimeline(w, tl);
  w.close();
  w.close();
  entries.splice(1, 0, { name: 'DOMDocument.xml', data: w.toString() });
  entries.push({ name: 'PublishSettings.xml', data: publishSettings(doc) });
  entries.push({ name: 'META-INF/metadata.xml', data: metadataXml() });
  return writeZip(entries);
}

function publishSettings(doc: Doc): string {
  void doc;
  return `<?xml version="1.0" encoding="UTF-8"?>
<flash_profiles>
<flash_profile version="1.0" name="Default" current="true">
  <PublishFormatProperties enabled="true">
    <defaultNames>1</defaultNames>
    <flash>1</flash>
    <projectorWin>0</projectorWin>
    <projectorMac>0</projectorMac>
    <html>1</html>
    <gif>0</gif>
    <jpeg>0</jpeg>
    <png>0</png>
    <svg>0</svg>
    <swc>0</swc>
  </PublishFormatProperties>
  <PublishFlashProperties enabled="true">
    <Version>32</Version>
    <ExternalPlayer>FlashPlayer32</ExternalPlayer>
    <ActionScriptVersion>3</ActionScriptVersion>
    <Compress>1</Compress>
    <IncludeHiddenLayers>1</IncludeHiddenLayers>
    <FrameLabels>1</FrameLabels>
  </PublishFlashProperties>
</flash_profile>
</flash_profiles>
`;
}

function metadataXml(): string {
  const date = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Celerity" xmp:CreateDate="${date}" xmp:ModifyDate="${date}"/>
  </rdf:RDF>
</x:xmpmeta>
`;
}

export { baseName };
