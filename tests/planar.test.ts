import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePaths, erasePlanar, planarToPaths, faceAt, recolorPlanar, extractPlanar, transformPlanar, strokeEdgeAt, strokeChain,
  setEdgeStrokes, pathRegion, type Planar,
} from '../src/core/planar';
import { rectPath, ellipsePath, flatten, polygonArea, lineToPath } from '../src/core/path';
import type { Fill, ShapePath, Stroke } from '../src/core/types';

const red: Fill = { kind: 'solid', color: '#FF0000', alpha: 1 };
const blue: Fill = { kind: 'solid', color: '#0000FF', alpha: 1 };
const black: Stroke = { color: '#000000', alpha: 1, width: 1, caps: 'round', joints: 'round' };
const fillPath = (fill: Fill, d: number[], stroke: Stroke | null = null): ShapePath => ({ fill, stroke, d });

/** Filled area per colour (nonzero, via sampling the region on a grid). */
function areaOf(p: Planar, color: string): number {
  let a = 0;
  for (const sp of planarToPaths(p)) {
    if (!sp.fill || sp.fill.kind !== 'solid' || sp.fill.color !== color) continue;
    // signed polygon areas of each loop; holes come out with opposite sign
    for (const pl of flatten(sp.d, 0.05)) a += polygonArea(pl.pts);
  }
  return Math.abs(a);
}

test('planar: overlapping shapes of different colours cut each other', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  p = mergePaths(p, [fillPath(blue, rectPath(50, 50, 100, 100))]);
  assert.ok(Math.abs(areaOf(p, '#FF0000') - 7500) < 1, `red ${areaOf(p, '#FF0000')}`);
  assert.ok(Math.abs(areaOf(p, '#0000FF') - 10000) < 1);
});

test('planar: same colour fuses into one outline', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  p = mergePaths(p, [fillPath(red, rectPath(50, 50, 100, 100))]);
  assert.equal(p.fills.length, 1);
  assert.ok(Math.abs(areaOf(p, '#FF0000') - 17500) < 1);
  // the interior edges are gone: only the 8 outer sides remain (collinear runs joined)
  assert.equal(p.edges.length, 8);
});

test('planar: erasing punches a hole and faceAt finds it', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  p = erasePlanar(p, rectPath(25, 25, 50, 50));
  assert.ok(Math.abs(areaOf(p, '#FF0000') - 7500) < 1);
  const hole = faceAt(p, 50, 50);
  assert.ok(hole);
  assert.equal(hole!.fill, null);
  const ring = faceAt(p, 10, 10);
  assert.ok(ring && ring.fill && ring.fill.kind === 'solid' && ring.fill.color === '#FF0000');
  // the ring face excludes the hole
  assert.ok(!pathRegion(ring!.region).contains(50, 50));
  assert.ok(pathRegion(ring!.region).contains(10, 10));
});

test('planar: bucket fills an enclosed empty area', () => {
  // stroked square outline with nothing inside
  let p = mergePaths(null, [{ fill: null, stroke: black, d: rectPath(0, 0, 40, 40) }]);
  const face = faceAt(p, 20, 20);
  assert.ok(face && face.fill === null);
  p = recolorPlanar(p, face!.region, blue, false);
  assert.ok(Math.abs(areaOf(p, '#0000FF') - 1600) < 1);
  // strokes survive
  assert.equal(planarToPaths(p).filter((s) => s.stroke).length, 1);
});

test('planar: curves intersect lines (circle over square)', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  p = mergePaths(p, [fillPath(blue, ellipsePath(100, 100, 50, 50))]);
  const quarter = Math.PI * 2500 / 4;
  assert.ok(Math.abs(areaOf(p, '#FF0000') - (10000 - quarter)) < 15, `red ${areaOf(p, '#FF0000')}`);
  assert.ok(Math.abs(areaOf(p, '#0000FF') - Math.PI * 2500) < 15);
});

test('planar: a fill drawn over strokes removes the covered strokes', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100), black)]);
  p = mergePaths(p, [fillPath(blue, rectPath(50, 50, 100, 100))]);
  // the stroke inside the blue square (the corner of the red outline) is gone
  const hit = strokeEdgeAt(p, 100, 75, 1);
  assert.equal(hit, -1);
  assert.ok(strokeEdgeAt(p, 0, 50, 1) >= 0);
});

test('planar: a line splits a fill and stroke chains/ink bottle work', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  p = mergePaths(p, [{ fill: null, stroke: black, d: lineToPath(50, -10, 50, 110) }]);
  const left = faceAt(p, 25, 50), right = faceAt(p, 75, 50);
  assert.ok(left && right);
  assert.ok(!pathRegion(left!.region).contains(75, 50));
  const e = strokeEdgeAt(p, 50, 50, 1);
  assert.ok(e >= 0);
  const chain = strokeChain(p, e);
  assert.ok(chain.length >= 3);
  const thick = setEdgeStrokes(p, chain, { ...black, width: 4 });
  assert.ok(thick.strokes.some((s) => s.width === 4));
});

test('planar: extract and transform keep fills', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  const part = extractPlanar(p, rectPath(0, 0, 50, 100), true);
  assert.ok(Math.abs(areaOf(part, '#FF0000') - 5000) < 1);
  const moved = transformPlanar(part, { a: -1, b: 0, c: 0, d: 1, tx: 200, ty: 0 });
  assert.ok(Math.abs(areaOf(moved, '#FF0000') - 5000) < 1);
  p = mergePlanarCheck(p, moved);
  assert.ok(Math.abs(areaOf(p, '#FF0000') - 15000) < 1);
});

import { mergePlanar } from '../src/core/planar';
function mergePlanarCheck(a: Planar, b: Planar) { return mergePlanar(a, b); }

test('planar: under mode keeps existing fill on top', () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100))]);
  p = mergePaths(p, [fillPath(blue, rectPath(50, 50, 100, 100))], 'under');
  assert.ok(Math.abs(areaOf(p, '#FF0000') - 10000) < 1);
  assert.ok(Math.abs(areaOf(p, '#0000FF') - 7500) < 1);
});

test('planar: many overlapping strokes stay fast', () => {
  let p: Planar | null = null;
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) {
    p = mergePaths(p, [{ fill: null, stroke: black, d: lineToPath(i * 3, 0, 200 - i * 3, 200) }]);
  }
  const dt = performance.now() - t0;
  assert.ok(p!.edges.length > 60);
  assert.ok(dt < 4000, `took ${dt}ms`);
});

import { newDoc } from '../src/core/util';
import { writeFla } from '../src/io/xfl-write';
import { readFla } from '../src/io/xfl-read';
import { AssetStore } from '../src/core/assets';
import { readZip } from '../src/io/zip';
import { mergeShapeElement } from '../src/core/merge';
import type { ShapeElement } from '../src/core/types';

test('planar: raw shapes round-trip through FLA as merge-mode DOMShapes', async () => {
  let p = mergePaths(null, [fillPath(red, rectPath(0, 0, 100, 100), black)]);
  p = mergePaths(p, [fillPath(blue, ellipsePath(100, 100, 40, 40))]);
  const doc = newDoc();
  doc.scenes[0].layers[0].frames[0].elements.push(mergeShapeElement('s1', p));
  const bytes = await writeFla(doc, { assets: new AssetStore(), pixels: async () => null });
  const xml = await readZip(bytes).readText('DOMDocument.xml');
  assert.ok(xml.includes('<DOMShape>') && !xml.includes('isDrawingObject'), 'written as a raw shape');
  const back = await readFla(bytes, { assets: new AssetStore(), encodePng: async () => new Uint8Array() });
  const el = back.doc.scenes[0].layers[0].frames[0].elements[0] as ShapeElement;
  assert.ok(el.planar);
  assert.ok(Math.abs(areaOf(el.planar!, '#FF0000') - areaOf(p, '#FF0000')) < 2);
  assert.ok(Math.abs(areaOf(el.planar!, '#0000FF') - areaOf(p, '#0000FF')) < 2);
  // still editable after loading: erase part of it
  const er = erasePlanar(el.planar!, rectPath(0, 0, 10, 10));
  assert.ok(areaOf(er, '#FF0000') < areaOf(el.planar!, '#FF0000') - 99);
});

import { Store } from '../src/core/store';
import { SUB } from '../src/core/merge';

test('store: merge drawing, part selection, lift-move-drop and undo', () => {
  const st = new Store();
  st.drawMerged([fillPath(red, rectPath(0, 0, 100, 100))]);
  st.drawMerged([fillPath(blue, rectPath(50, 50, 100, 100))]);
  const els = () => st.doc.scenes[0].layers[0].frames[0].elements;
  assert.equal(els().length, 1, 'one raw shape per layer');
  const raw = els()[0] as ShapeElement;
  // select the blue square and move it away
  const face = faceAt(raw.planar!, 120, 120)!;
  st.selectParts([{ elId: raw.id, sel: { all: false, region: face.region, strokes: false, edges: [], sig: (await_sig(raw)) } }]);
  assert.deepEqual(st.selection, [SUB + raw.id]);
  assert.equal(st.selected().length, 1);
  st.transact('Move', () => {
    for (const s of st.mutableSelection()) s.el.matrix = { ...s.el.matrix, tx: 200 };
  });
  assert.equal(els().length, 1, 'lifted part merged back');
  const after = els()[0] as ShapeElement;
  assert.ok(Math.abs(areaOf(after.planar!, '#FF0000') - 7500) < 1, 'red keeps the bite');
  assert.ok(Math.abs(areaOf(after.planar!, '#0000FF') - 10000) < 1);
  // the moved part is still selected
  assert.deepEqual(st.selection, [SUB + after.id]);
  const sel = st.selected()[0].el as ShapeElement;
  assert.ok(Math.abs(areaOf(sel.planar!, '#0000FF') - 10000) < 1);
  // delete the selection
  st.transact('Delete', () => { for (const s of st.mutableSelection()) s.list.splice(s.list.indexOf(s.el), 1); });
  assert.ok(areaOf((els()[0] as ShapeElement).planar!, '#0000FF') < 1);
  st.undo(); st.undo();
  assert.ok(Math.abs(areaOf((els()[0] as ShapeElement).planar!, '#FF0000') - 7500) < 1);
  assert.ok(Math.abs(areaOf((els()[0] as ShapeElement).planar!, '#0000FF') - 10000) < 1);
});

import { planarSig } from '../src/core/merge';
function await_sig(el: ShapeElement) { return planarSig(el.planar!); }
