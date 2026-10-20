import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, makeInstance } from '../src/core/store';
import { newSymbol } from '../src/core/util';
import { rectPath } from '../src/core/path';
import { translate, rotate, multiply } from '../src/core/matrix';
import { insertFrames, resolveLayerFrame, setTween, insertKeyframe } from '../src/core/timeline';
import { motionKeyOffsets, timeMapEase } from '../src/core/motion';
import { writeFla } from '../src/io/xfl-write';
import { readFla } from '../src/io/xfl-read';
import { writeZip } from '../src/io/zip';
import { AssetStore } from '../src/core/assets';
import type { Matrix, SymbolInstance } from '../src/core/types';

function setup() {
  const st = new Store();
  const sym = newSymbol('Box', 'movieclip');
  sym.timeline.layers[0].frames[0].elements.push({ type: 'shape', id: 'r', matrix: translate(0, 0), paths: [{ fill: { kind: 'solid', color: '#FF0000', alpha: 1 }, stroke: null, d: rectPath(0, 0, 20, 20) }] });
  st.doc.library.push(sym);
  st.lib.set('Box', sym);
  const layer = st.doc.scenes[0].layers[0];
  const inst = makeInstance('Box', 'movieclip', translate(100, 100));
  inst.transformPoint = { x: 10, y: 10 };
  layer.frames[0].elements.push(inst);
  insertFrames(layer, 0, 23);
  setTween(layer, 0, 0, 'motion');
  return { st, layer, inst };
}
const at = (layer: ReturnType<typeof setup>['layer'], f: number) => resolveLayerFrame(layer, f)!.elements[0].matrix;
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test('motion tween: moving the object on a later frame records property keys', () => {
  const { st, layer, inst } = setup();
  st.select([inst.id]);
  st.setFrame(23);
  st.transact('Move', () => { for (const s of st.mutableSelection()) s.el.matrix = { ...s.el.matrix, tx: 300, ty: 160 }; });
  assert.equal(layer.frames.length, 1, 'no keyframe split');
  assert.deepEqual(motionKeyOffsets(layer.frames[0].motion), [0, 23]);
  const m0 = at(layer, 0), m23 = at(layer, 23), mid = at(layer, 23 / 2);
  assert.ok(close(m0.tx, 100) && close(m23.tx, 300) && close(m23.ty, 160));
  assert.ok(close(mid.tx, 200, 1e-3), `mid ${mid.tx}`);
  // rotate on frame 12 about the transform point
  st.setFrame(12);
  st.transact('Rotate', () => {
    for (const s of st.mutableSelection()) {
      const m = s.el.matrix;
      const p = { x: m.a * 10 + m.c * 10 + m.tx, y: m.b * 10 + m.d * 10 + m.ty };
      s.el.matrix = multiply(multiply(translate(p.x, p.y), multiply(rotate(Math.PI / 2), translate(-p.x, -p.y))), m);
    }
  });
  const r12 = at(layer, 12);
  assert.ok(close(Math.atan2(r12.b, r12.a), Math.PI / 2, 1e-6));
  const r6 = at(layer, 6);
  assert.ok(close(Math.atan2(r6.b, r6.a), Math.PI / 4, 1e-6), 'rotation interpolates');
  // the pivot follows the path, unaffected by rotation
  const piv = (m: Matrix) => ({ x: m.a * 10 + m.c * 10 + m.tx, y: m.b * 10 + m.d * 10 + m.ty });
  const p12 = piv(r12);
  const p12b = piv(at(layer, 12));
  assert.ok(close(p12.x, p12b.x));
  // undo removes the rotation key
  st.undo();
  assert.deepEqual(motionKeyOffsets(st.doc.scenes[0].layers[0].frames[0].motion), [0, 23]);
});

test('motion tween: ease and time maps', () => {
  assert.ok(timeMapEase({ type: 'Quadratic', strength: 100 }, 0.5) > 0.7);
  assert.ok(timeMapEase({ type: 'Quadratic', strength: -100 }, 0.5) < 0.3);
  assert.equal(timeMapEase({ type: 'Quadratic', strength: 0 }, 0.3), 0.3);
  const { st, layer, inst } = setup();
  st.select([inst.id]); st.setFrame(23);
  st.transact('Move', () => { for (const s of st.mutableSelection()) s.el.matrix = { ...s.el.matrix, tx: 300 }; });
  layer.frames[0].ease = 100;
  assert.ok(at(layer, 11.5).tx > 240, 'ease out moves faster first');
});

test('motion tween: splitting with F6-style keyframe keeps the motion', () => {
  const { st, layer, inst } = setup();
  st.select([inst.id]); st.setFrame(23);
  st.transact('Move', () => { for (const s of st.mutableSelection()) s.el.matrix = { ...s.el.matrix, tx: 300 }; });
  const before = at(layer, 18).tx;
  insertKeyframe(layer, 10, false);
  assert.equal(layer.frames.length, 2);
  assert.ok(close(at(layer, 18).tx, before, 1e-6), 'second half continues on the same path');
});

test('motion tween: FLA round trip and reading Animate XML', async () => {
  const { st, layer, inst } = setup();
  st.select([inst.id]); st.setFrame(23);
  st.transact('Move', () => { for (const s of st.mutableSelection()) s.el.matrix = { ...multiply(s.el.matrix, translate(0, 0)), a: 2, d: 0.5, tx: 300, ty: 50 }; });
  st.doc.scenes[0].layers[0].frames[0].elements[0] = layer.frames[0].elements[0];
  const bytes = await writeFla(st.doc, { assets: new AssetStore(), pixels: async () => null });
  const back = await readFla(bytes, { assets: new AssetStore(), encodePng: async () => new Uint8Array() });
  const l2 = back.doc.scenes[0].layers[0];
  assert.equal(l2.frames[0].tween, 'motion');
  for (const f of [0, 5, 12, 23]) {
    const a = at(layer, f), b = at(l2, f);
    for (const k of ['a', 'b', 'c', 'd', 'tx', 'ty'] as const) assert.ok(close(a[k], b[k], 1e-3), `frame ${f} ${k}: ${a[k]} vs ${b[k]}`);
  }
  assert.ok(!back.warnings.some((w) => /motion/i.test(w)));

  // a file as Animate writes it (TimeScale 24000 @ 24 fps), with alpha fade and a time map
  const dom = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="400" height="300" frameRate="24" xflVersion="2.97">
 <symbols><Include href="Box.xml"/></symbols>
 <timelines><DOMTimeline name="Scene 1"><layers><DOMLayer name="L"><frames>
  <DOMFrame index="0" duration="11" tweenType="motion object" motionTweenRotate="none" motionTweenScale="false" isMotionObject="true" visibleAnimationKeyframes="2097151" keyMode="8195">
   <motionObjectXML><AnimationCore TimeScale="24000" Version="1" duration="11000">
    <TimeMap strength="0" type="Quadratic"/>
    <metadata><names><name langID="en_US" value=""/></names><Settings orientToPath="0" xformPtXOffsetPct="0.5" xformPtYOffsetPct="0.5" xformPtZOffsetPixels="0"/></metadata>
    <PropertyContainer id="headContainer">
     <PropertyContainer id="Basic_Motion">
      <Property enabled="1" id="Motion_X" ignoreTimeMap="0" readonly="0" visible="1">
       <Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/>
       <Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="10000"/>
      </Property>
      <Property enabled="1" id="Motion_Y" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/></Property>
      <Property enabled="1" id="Rotation_Z" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="0"/></Property>
     </PropertyContainer>
     <PropertyContainer id="Colors"><PropertyContainer id="Alpha_ColorXform">
      <Property enabled="1" id="Alpha_Amount" ignoreTimeMap="0" readonly="0" visible="1">
       <Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="0"/>
       <Keyframe anchor="0,0" next="0,0" previous="0,0" roving="0" timevalue="10000"/>
      </Property></PropertyContainer></PropertyContainer>
     <PropertyContainer id="Filters"/>
     <PropertyContainer id="Transformation">
      <Property enabled="1" id="Scale_X" ignoreTimeMap="0" readonly="0" visible="1"><Keyframe anchor="0,100" next="0,100" previous="0,100" roving="0" timevalue="0"/><Keyframe anchor="0,200" next="0,200" previous="0,200" roving="0" timevalue="10000"/></Property>
     </PropertyContainer>
    </PropertyContainer>
   </AnimationCore></motionObjectXML>
   <elements><DOMSymbolInstance libraryItemName="Box" symbolType="movie clip"><matrix><Matrix tx="50" ty="60"/></matrix><transformationPoint><Point x="10" y="10"/></transformationPoint></DOMSymbolInstance></elements>
  </DOMFrame>
 </frames></DOMLayer></layers></DOMTimeline></timelines>
</DOMDocument>`;
  const lib = `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Box" symbolType="movie clip"><timeline><DOMTimeline name="Box"><layers><DOMLayer name="Layer_1"><frames><DOMFrame index="0"><elements/></DOMFrame></frames></DOMLayer></layers></DOMTimeline></timeline></DOMSymbolItem>`;
  const zip = await writeZip([{ name: 'DOMDocument.xml', data: dom }, { name: 'LIBRARY/Box.xml', data: lib }]);
  const r = await readFla(zip, { assets: new AssetStore(), encodePng: async () => new Uint8Array() });
  const L = r.doc.scenes[0].layers[0];
  const e5 = resolveLayerFrame(L, 5)!.elements[0] as SymbolInstance;
  // pivot (60,70) moves +50 by frame 5; scale 150% about the pivot
  assert.ok(close(e5.matrix.a, 1.5, 1e-6), `scale ${e5.matrix.a}`);
  const px = e5.matrix.a * 10 + e5.matrix.c * 10 + e5.matrix.tx;
  assert.ok(close(px, 110, 1e-6), `pivot x ${px}`);
  assert.equal(e5.color.mode, 'alpha');
  assert.ok(close(e5.color.alpha, 50, 1e-6));
  const e10 = resolveLayerFrame(L, 10)!.elements[0] as SymbolInstance;
  assert.ok(close(e10.color.alpha, 0));
});
