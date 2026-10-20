import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDoc, newLayer, emptyFrame, uid, defaultColorEffect, effectToTransform } from '../src/core/util';
import {
  insertFrames, insertKeyframe, removeFrames, clearKeyframes, layerLength, frameAt, resolveLayerFrame, copyFrames, pasteFramesInto,
  moveFrames, reverseFrames, extendTo,
} from '../src/core/timeline';
import { easeT, interpolateMatrix, morphPath } from '../src/core/tween';
import { multiply, invert, apply, rotate, translate, decompose, compose } from '../src/core/matrix';
import { pathBounds, rectPath, ellipsePath, toQuadPath, cubicToQuads, flatten } from '../src/core/path';
import { traceBinary, loopsToPath, smoothPolyline } from '../src/core/trace';
import type { Layer, ShapeElement, SymbolInstance } from '../src/core/types';
import { parseXml, XmlWriter } from '../src/io/xml';
import { writeZip, readZip } from '../src/io/zip';
import { parseEdges, encodeEdges, parseEdgeNumber } from '../src/io/xfl-edges';
import { packFrames, sheetData, type SheetFrame } from '../src/io/spritesheet';
import { encodeGif, medianCut } from '../src/io/gif';

function shape(x: number): ShapeElement {
  return { type: 'shape', id: uid(), matrix: translate(x, 0), paths: [{ fill: { kind: 'solid', color: '#FF0000', alpha: 1 }, stroke: null, d: rectPath(0, 0, 10, 10) }] };
}
function inst(x: number): SymbolInstance {
  return { type: 'symbol', id: uid(), matrix: translate(x, 0), libraryItem: 'S', symbolType: 'graphic', loop: 'loop', firstFrame: 0, name: '', color: defaultColorEffect(), transformPoint: { x: 0, y: 0 } };
}
const spans = (l: Layer) => l.frames.map((f) => [f.start, f.duration]);

test('insertFrames extends and inserts', () => {
  const l = newLayer('L');
  insertFrames(l, 9);
  assert.equal(layerLength(l), 10);
  assert.deepEqual(spans(l), [[0, 10]]);
  insertKeyframe(l, 5, false);
  assert.deepEqual(spans(l), [[0, 5], [5, 5]]);
  insertFrames(l, 2, 3);
  assert.deepEqual(spans(l), [[0, 8], [8, 5]]);
});

test('insertKeyframe beyond end copies last content', () => {
  const l = newLayer('L');
  l.frames[0].elements.push(shape(0));
  const kf = insertKeyframe(l, 4, false);
  assert.deepEqual(spans(l), [[0, 4], [4, 1]]);
  assert.equal(kf.elements.length, 1);
  const blank = insertKeyframe(l, 7, true);
  assert.equal(blank.elements.length, 0);
  assert.deepEqual(spans(l), [[0, 4], [4, 3], [7, 1]]);
});

test('removeFrames and clearKeyframes', () => {
  const l = newLayer('L');
  insertFrames(l, 9);
  insertKeyframe(l, 5, true);
  removeFrames(l, 4, 5);
  assert.deepEqual(spans(l), [[0, 4], [4, 4]]);
  clearKeyframes(l, 4, 4);
  assert.deepEqual(spans(l), [[0, 8]]);
});

test('classic tween interpolation with ease', () => {
  const l = newLayer('L');
  l.frames[0].elements.push(inst(0));
  insertFrames(l, 9);
  const k = insertKeyframe(l, 10, false);
  (k.elements[0] as SymbolInstance).matrix = translate(100, 0);
  l.frames[0].tween = 'classic';
  const mid = resolveLayerFrame(l, 5)!;
  assert.ok(mid.tweened);
  assert.ok(Math.abs(mid.elements[0].matrix.tx - 50) < 1e-6);
  l.frames[0].ease = 100;
  const eased = resolveLayerFrame(l, 5)!;
  assert.ok(eased.elements[0].matrix.tx > 50, 'ease out moves faster first');
  assert.equal(easeT(0.5, -100), 0.25);
});

test('editing inside a tween span inserts a keyframe with interpolated content', () => {
  const l = newLayer('L');
  const a = inst(0);
  l.frames[0].elements.push(a);
  insertFrames(l, 9);
  const k = insertKeyframe(l, 10, false);
  (k.elements[0] as SymbolInstance).matrix = translate(100, 0);
  l.frames[0].tween = 'classic';
  const mid = insertKeyframe(l, 5, false);
  assert.equal(mid.elements[0].id, a.id, 'keyframes keep element ids');
  assert.ok(Math.abs(mid.elements[0].matrix.tx - 50) < 1e-6);
  assert.equal(mid.tween, 'classic');
  assert.deepEqual(spans(l), [[0, 5], [5, 5], [10, 1]]);
});

test('matrix interpolation rotates through shortest path and cw', () => {
  const m0 = rotate(0), m1 = rotate(Math.PI / 2);
  const half = interpolateMatrix(m0, m1, 0.5);
  assert.ok(Math.abs(Math.atan2(half.b, half.a) - Math.PI / 4) < 1e-9);
  const cw = interpolateMatrix(m0, m0, 0.5, 'cw', 1);
  assert.ok(Math.abs(Math.atan2(cw.b, cw.a) - Math.PI) < 1e-9 || Math.abs(Math.atan2(cw.b, cw.a) + Math.PI) < 1e-9);
  const d = compose(decompose({ a: 2, b: 0.5, c: 0.25, d: 3, tx: 5, ty: 6 }));
  for (const [k, v] of Object.entries({ a: 2, b: 0.5, c: 0.25, d: 3, tx: 5, ty: 6 })) assert.ok(Math.abs((d as any)[k] - v) < 1e-9, k);
});

test('matrix invert', () => {
  const m = multiply(translate(10, 20), multiply(rotate(0.3), { a: 2, b: 0, c: 0.5, d: 1.5, tx: 0, ty: 0 }));
  const p = apply(m, 3, 4);
  const q = apply(invert(m), p.x, p.y);
  assert.ok(Math.abs(q.x - 3) < 1e-9 && Math.abs(q.y - 4) < 1e-9);
});

test('copy/paste/move/reverse frames', () => {
  const l = newLayer('L');
  l.frames[0].elements.push(shape(0));
  insertFrames(l, 4);
  insertKeyframe(l, 5, true);
  insertFrames(l, 7);
  const clip = copyFrames([l], 0, 1);
  pasteFramesInto(l, 10, clip.layers[0]);
  assert.equal(layerLength(l), 12);
  assert.equal(frameAt(l, 10)!.elements.length, 1);
  moveFrames(l, 5, 5, 1);
  assert.equal(frameAt(l, 6)!.start, 6);
  reverseFrames(l, 0, 11);
  assert.equal(layerLength(l), 12);
  extendTo(l, 20);
  assert.equal(layerLength(l), 21);
});

test('shape morph between different structures', () => {
  const a = rectPath(0, 0, 10, 10);
  const b = ellipsePath(50, 50, 20, 20);
  const m = morphPath(a, b, 0.5);
  const r = pathBounds(m);
  assert.ok(r.w > 10 && r.w < 40);
  assert.deepEqual(morphPath(a, b, 0), a);
});

test('path bounds include curve extrema', () => {
  const r = pathBounds(ellipsePath(0, 0, 10, 5));
  assert.ok(Math.abs(r.x + 10) < 1e-6 && Math.abs(r.w - 20) < 1e-6 && Math.abs(r.h - 10) < 1e-6);
});

test('cubic to quads approximates', () => {
  const q = cubicToQuads({ x0: 0, y0: 0, c1x: 0, c1y: 50, c2x: 100, c2y: 50, x: 100, y: 0 }, 0.1);
  assert.ok(q.length >= 2);
  const last = q[q.length - 1];
  assert.equal(last[2], 100);
  const qp = toQuadPath(ellipsePath(0, 0, 50, 50));
  assert.ok(!qp.includes(3));
});

test('trace binary mask produces loops with holes', () => {
  const w = 20, h = 20;
  const mask = new Uint8Array(w * h);
  for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) mask[y * w + x] = 1;
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) mask[y * w + x] = 0;
  const loops = traceBinary(mask, w, h);
  assert.equal(loops.length, 2);
  const d = loopsToPath(loops, 1, 0, 0);
  const r = pathBounds(d);
  assert.ok(r.w > 14 && r.w <= 17, `width ${r.w}`);
});

test('pencil smoothing fits curves', () => {
  const pts = Array.from({ length: 50 }, (_, i) => ({ x: i * 2, y: Math.sin(i / 5) * 20 }));
  const d = smoothPolyline(pts, 1, false);
  assert.ok(d.length > 0);
  const polys = flatten(d);
  assert.equal(polys.length, 1);
});

test('color effects', () => {
  const e = defaultColorEffect();
  e.mode = 'tint'; e.tintAmount = 50; e.tintColor = '#FF0000';
  const ct = effectToTransform(e);
  assert.equal(ct.rm, 0.5); assert.equal(ct.ro, 128);
});

test('xml parse/write roundtrip', () => {
  const w = new XmlWriter();
  w.open('Root', { a: 'x"<&>' }).leaf('Child', { v: 1 }).textEl('T', 'hello & <world>').close();
  const x = parseXml(w.toString());
  assert.equal(x.name, 'Root');
  assert.equal(x.attrs.a, 'x"<&>');
  assert.equal(x.children[1].text, 'hello & <world>');
});

test('zip roundtrip', async () => {
  const big = 'abc'.repeat(1000);
  const z = await writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.txt', data: big }]);
  const r = readZip(z);
  assert.deepEqual(r.names().sort(), ['a.txt', 'dir/b.txt']);
  assert.equal(await r.readText('dir/b.txt'), big);
  assert.equal(await r.readText('a.txt'), 'hello');
});

test('xfl edge numbers & strings', () => {
  assert.equal(parseEdgeNumber('200'), 10);
  assert.equal(parseEdgeNumber('#C8'), 10);
  assert.equal(parseEdgeNumber('#C8.80'), 10.025);
  const chains = parseEdges('!0 0S2|200 0!200 0[400 0 400 200|0 200');
  assert.equal(chains.length, 1);
  assert.equal(chains[0].length, 3);
  const enc = encodeEdges(rectPath(0, 0, 10, 10));
  assert.equal(enc, '!0 0|200 0|200 200|0 200|0 0');
});

test('sprite sheet packing', () => {
  const frames: SheetFrame[] = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, srcW: 50, srcH: 40, trimX: 2, trimY: 3, w: 30 + i, h: 20, hash: String(i % 7) }));
  const r = packFrames(frames, { algorithm: 'packed', padding: 2, border: 1, maxSize: 4096, powerOfTwo: false, stack: true });
  assert.ok(r.width > 0 && r.height > 0);
  for (const f of frames) {
    assert.ok(f.x! >= 1 && f.y! >= 1 && f.x! + f.w <= r.width && f.y! + f.h <= r.height);
  }
  // no overlaps among unique frames
  const u = frames.filter((f) => f.dupOf === undefined);
  for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
    const a = u[i], b = u[j];
    const overlap = a.x! < b.x! + b.w && b.x! < a.x! + a.w && a.y! < b.y! + b.h && b.y! < a.y! + a.h;
    assert.ok(!overlap, `overlap ${a.name} ${b.name}`);
  }
  const data = sheetData('json', frames, { image: 's.png', width: r.width, height: r.height, fps: 24, scale: 1, animationName: 'anim', registration: { x: 0, y: 0 } });
  const parsed = JSON.parse(data.text);
  assert.equal(Object.keys(parsed.frames).length, 10);
  for (const fmt of ['json-array', 'starling', 'easeljs', 'cocos2d', 'phaser3', 'css'] as const) {
    assert.ok(sheetData(fmt, frames, { image: 's.png', width: r.width, height: r.height, fps: 24, scale: 1, animationName: 'anim', registration: { x: 0, y: 0 } }).text.length > 10);
  }
});

test('gif encoder structure', () => {
  const w = 8, h = 8;
  const frame = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { frame[i * 4] = i * 4; frame[i * 4 + 1] = 255 - i * 4; frame[i * 4 + 2] = 128; frame[i * 4 + 3] = 255; }
  const gif = encodeGif(w, h, [{ data: frame }, { data: frame }], 12);
  assert.equal(String.fromCharCode(...gif.subarray(0, 6)), 'GIF89a');
  assert.equal(gif[gif.length - 1], 0x3b);
  assert.ok(medianCut([1, 2, 3, 4, 5], 2).length === 2);
});

test('new doc defaults', () => {
  const d = newDoc();
  assert.equal(d.width, 550);
  assert.equal(d.scenes[0].layers.length, 1);
  assert.deepEqual(emptyFrame(3).start, 3);
});
