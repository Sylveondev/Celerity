import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDoc, uid, defaultColorEffect, newSymbol, emptyFrame } from '../src/core/util';
import { rectPath, ellipsePath, pathBounds } from '../src/core/path';
import { translate } from '../src/core/matrix';
import { insertFrames, insertKeyframe } from '../src/core/timeline';
import type { Doc, ShapeElement, SymbolInstance } from '../src/core/types';
import { writeFla, encodeDat } from '../src/io/xfl-write';
import { readFla, decodeDat } from '../src/io/xfl-read';
import { writeSwf, compileScript } from '../src/io/swf';
import { AssetStore } from '../src/core/assets';
import { readSwf } from './swf-reader';

function shape(x: number, y: number, d = rectPath(0, 0, 40, 30)): ShapeElement {
  return {
    type: 'shape', id: uid(), matrix: translate(x, y),
    paths: [{ fill: { kind: 'solid', color: '#FF0000', alpha: 0.5 }, stroke: { color: '#000000', alpha: 1, width: 2, caps: 'round', joints: 'round' }, d }],
  };
}

function sampleDoc(): Doc {
  const doc = newDoc(640, 480, 30, '#336699');
  const sym = newSymbol('Ball', 'graphic');
  sym.timeline.layers[0].frames[0].elements.push(shape(-20, -20, ellipsePath(20, 20, 20, 20)));
  insertFrames(sym.timeline.layers[0], 9);
  const mc = newSymbol('Folder/Spinner', 'movieclip');
  mc.timeline.layers[0].frames[0].elements.push(shape(0, 0));
  insertFrames(mc.timeline.layers[0], 4);
  const k = insertKeyframe(mc.timeline.layers[0], 5, false);
  k.elements[0].matrix = translate(30, 0);
  mc.timeline.layers[0].frames[0].tween = 'shape';
  doc.library.push(sym, mc);
  const layer = doc.scenes[0].layers[0];
  const inst: SymbolInstance = {
    type: 'symbol', id: uid(), matrix: translate(50, 60), libraryItem: 'Ball', symbolType: 'graphic', loop: 'loop', firstFrame: 0,
    name: '', color: { ...defaultColorEffect(), mode: 'alpha', alpha: 50 }, transformPoint: { x: 0, y: 0 },
  };
  layer.frames[0].elements.push(inst, shape(200, 200));
  insertFrames(layer, 23);
  const kf = insertKeyframe(layer, 24, false);
  kf.elements[0].matrix = translate(400, 300);
  layer.frames[0].tween = 'classic';
  layer.frames[0].ease = -50;
  layer.frames[0].label = 'start';
  layer.frames[1].script = 'stop();';
  // second layer with a movie clip + mask
  const l2 = { ...structuredClone(layer), id: uid(), name: 'Masked', frames: [emptyFrame(0, 25)] };
  l2.frames[0].elements = [{
    ...inst, id: uid(), libraryItem: 'Folder/Spinner', symbolType: 'movieclip', name: 'spin', color: defaultColorEffect(), blendMode: 'multiply',
    filters: [{ type: 'dropShadow', blurX: 6, blurY: 6, strength: 1, quality: 1, color: '#000000', alpha: 0.5, angle: 45, distance: 4, inner: false, knockout: false, hideObject: false }, { type: 'blur', blurX: 2, blurY: 2, quality: 2 }],
  } as SymbolInstance];
  const mask = { ...structuredClone(layer), id: uid(), name: 'Mask', type: 'mask' as const, frames: [emptyFrame(0, 25)] };
  mask.frames[0].elements = [shape(0, 0, rectPath(0, 0, 300, 300))];
  l2.parentId = mask.id;
  doc.scenes[0].layers = [mask, l2, layer];
  return doc;
}

test('FLA roundtrip preserves structure', async () => {
  const doc = sampleDoc();
  const assets = new AssetStore();
  const bytes = await writeFla(doc, { assets, pixels: async () => null });
  const back = await readFla(bytes, { assets: new AssetStore(), encodePng: async () => new Uint8Array() });
  const d2 = back.doc;
  assert.equal(d2.width, 640);
  assert.equal(d2.height, 480);
  assert.equal(d2.fps, 30);
  assert.equal(d2.background, '#336699');
  assert.deepEqual(d2.library.filter((i) => i.kind !== 'folder').map((i) => i.name).sort(), ['Ball', 'Folder/Spinner']);
  assert.ok(d2.library.some((i) => i.kind === 'folder' && i.name === 'Folder'));
  const layers = d2.scenes[0].layers;
  assert.deepEqual(layers.map((l) => l.name), ['Mask', 'Masked', 'Layer_1']);
  assert.equal(layers[0].type, 'mask');
  assert.equal(layers[1].parentId, layers[0].id);
  const main = layers[2];
  assert.deepEqual(main.frames.map((f) => [f.start, f.duration, f.tween]), [[0, 24, 'classic'], [24, 1, 'none']]);
  assert.equal(main.frames[0].ease, -50);
  assert.equal(main.frames[0].label, 'start');
  assert.equal(main.frames[1].script.trim(), 'stop();');
  const spinInst = layers[1].frames[0].elements[0] as SymbolInstance;
  assert.equal(spinInst.blendMode, 'multiply');
  assert.deepEqual(spinInst.filters?.map((f) => f.type), ['dropShadow', 'blur']);
  assert.equal(spinInst.filters?.[0].type === 'dropShadow' && spinInst.filters[0].alpha, 0.5);
  const inst = main.frames[0].elements[0] as SymbolInstance;
  assert.equal(inst.type, 'symbol');
  assert.equal(inst.libraryItem, 'Ball');
  assert.equal(inst.symbolType, 'graphic');
  assert.equal(inst.color.mode, 'alpha');
  assert.equal(Math.round(inst.color.alpha), 50);
  assert.equal(inst.matrix.tx, 50);
  // shape geometry survives (baked into edges)
  const sh = main.frames[0].elements[1] as ShapeElement;
  assert.equal(sh.type, 'shape');
  const fillPath = sh.paths.find((p) => p.fill)!;
  const b = pathBounds(fillPath.d, sh.matrix);
  assert.ok(Math.abs(b.x - 200) < 0.06 && Math.abs(b.w - 40) < 0.1, JSON.stringify(b));
  assert.equal((fillPath.fill as { color: string }).color, '#FF0000');
  assert.ok(sh.paths.some((p) => p.stroke && p.stroke.width === 2));
  // symbol timeline
  const spinner = d2.library.find((i) => i.name === 'Folder/Spinner');
  assert.ok(spinner && spinner.kind === 'symbol' && spinner.symbolType === 'movieclip');
  if (spinner?.kind === 'symbol') assert.equal(spinner.timeline.layers[0].frames[0].tween, 'shape');
});

test('bitmap .dat encode/decode', async () => {
  const w = 3, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = 200; rgba[i * 4 + 1] = i * 40; rgba[i * 4 + 2] = 10; rgba[i * 4 + 3] = i === 0 ? 128 : 255; }
  const dat = await encodeDat(w, h, rgba);
  assert.equal(dat[0], 0x03); assert.equal(dat[1], 0x05);
  const back = await decodeDat(dat);
  assert.ok(back && back.kind === 'rgba');
  if (back?.kind === 'rgba') {
    assert.equal(back.width, 3);
    assert.equal(back.height, 2);
    for (let i = 1; i < w * h; i++) {
      assert.equal(back.data[i * 4], 200);
      assert.equal(back.data[i * 4 + 1], i * 40);
      assert.equal(back.data[i * 4 + 3], 255);
    }
    assert.ok(Math.abs(back.data[0] - 200) <= 2);
  }
});

test('SWF output parses and has expected structure', async () => {
  const doc = sampleDoc();
  const swf = await writeSwf(doc, { assets: new AssetStore(), pixels: async () => null, compress: true });
  const info = readSwf(swf);
  assert.equal(info.width, 640);
  assert.equal(info.height, 480);
  assert.equal(info.fps, 30);
  assert.equal(info.frames, 25);
  assert.equal(info.showFrames, 25);
  assert.ok(info.shapes.length >= 3);
  assert.ok(info.sprites.length === 1, 'movie clip becomes a sprite');
  assert.equal(info.sprites[0].frames, 6);
  assert.ok(info.places.some((p) => p.clipDepth !== undefined), 'mask uses clip depth');
  assert.ok(info.places.some((p) => p.name === 'spin'), 'instance names are kept');
  const po3 = info.places.find((p) => p.filters);
  assert.ok(po3 && po3.filters!.join() === '0,1' && po3.blend === 3, 'PlaceObject3 carries filters and blend mode');
  assert.deepEqual(info.labels, ['start']);
  assert.equal(info.actions, 1);
  // graphic symbols are flattened: the ball shape appears with a moving matrix across frames
  const moves = info.places.filter((p) => p.move && p.matrix);
  assert.ok(moves.length > 10, 'tween emits per-frame matrix updates');
  // ball geometry is inside its expected range
  const circle = info.shapes.find((s) => Math.abs(s.maxX - s.minX - 40) < 1 && Math.abs(s.maxY - s.minY - 40) < 1);
  assert.ok(circle, 'circle shape found');
  // uncompressed variant too
  const raw = await writeSwf(doc, { assets: new AssetStore(), pixels: async () => null, compress: false });
  assert.equal(String.fromCharCode(raw[0]), 'F');
  readSwf(raw);
});

test('AS2 script compiler', () => {
  assert.deepEqual([...compileScript('stop();', new Map())!], [0x07, 0]);
  assert.deepEqual([...compileScript('gotoAndPlay(5);', new Map())!], [0x81, 2, 0, 4, 0, 0x06, 0]);
  assert.deepEqual([...compileScript('this.gotoAndStop("end")', new Map([['end', 9]]))!], [0x81, 2, 0, 9, 0, 0x07, 0]);
  assert.equal(compileScript('// nothing', new Map()), null);
});

test('reads Animate-style merged shapes (shared edges, hex numbers, S markers)', async () => {
  const { writeZip } = await import('../src/io/zip');
  // Two adjacent squares sharing the middle edge: left is red (fill 1), right is blue (fill 2).
  // Edges are written the way Animate does: each edge carries the fill on its left (0) and right (1).
  const dom = `<?xml version="1.0" encoding="UTF-8"?>
<DOMDocument xmlns="http://ns.adobe.com/xfl/2008/" width="400" height="300" frameRate="12" backgroundColor="#EEEEEE" xflVersion="2.97">
  <timelines>
    <DOMTimeline name="Scene 1">
      <layers>
        <DOMLayer name="Art" color="#4F80FF">
          <frames>
            <DOMFrame index="0" duration="5" keyMode="9728">
              <elements>
                <DOMShape>
                  <fills>
                    <FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle>
                    <FillStyle index="2"><SolidColor color="#0000FF" alpha="0.5"/></FillStyle>
                  </fills>
                  <strokes>
                    <StrokeStyle index="1"><SolidStroke scaleMode="normal" weight="3" caps="none"><fill><SolidColor color="#00FF00"/></fill></SolidStroke></StrokeStyle>
                  </strokes>
                  <edges>
                    <Edge fillStyle1="1" strokeStyle="1" edges="!0 0S2|2000 0!2000 2000|0 2000!0 2000|0 0"/>
                    <Edge fillStyle0="1" fillStyle1="2" edges="!2000 0|#7D0.00 2000"/>
                    <Edge fillStyle1="2" edges="!2000 0|4000 0|4000 2000[4000 2000 2000 2000"/>
                  </edges>
                </DOMShape>
                <DOMRectangleObject x="10" y="10" objectWidth="50" objectHeight="20" topLeftRadius="5">
                  <fill><SolidColor color="#123456"/></fill>
                </DOMRectangleObject>
              </elements>
            </DOMFrame>
          </frames>
        </DOMLayer>
      </layers>
    </DOMTimeline>
  </timelines>
</DOMDocument>`;
  const zip = await writeZip([{ name: 'DOMDocument.xml', data: dom }]);
  const r = await readFla(zip, { assets: new AssetStore(), encodePng: async () => new Uint8Array() });
  const els = r.doc.scenes[0].layers[0].frames[0].elements;
  assert.equal(els.length, 2);
  const sh = els[0] as ShapeElement;
  const red = sh.paths.find((p) => p.fill?.kind === 'solid' && p.fill.color === '#FF0000')!;
  const blue = sh.paths.find((p) => p.fill?.kind === 'solid' && p.fill.color === '#0000FF')!;
  assert.ok(red && blue, 'both fills reconstructed');
  const rb = pathBounds(red.d), bb = pathBounds(blue.d);
  assert.deepEqual([rb.x, rb.y, rb.w, rb.h], [0, 0, 100, 100]);
  assert.deepEqual([bb.x, bb.y, bb.w, bb.h], [100, 0, 100, 100]);
  // red loop must be closed (M ... Z)
  assert.equal(red.d[red.d.length - 1], 4);
  const stroke = sh.paths.find((p) => p.stroke)!;
  assert.equal(stroke.stroke!.width, 3);
  assert.equal(stroke.stroke!.caps, 'butt');
  const rect = els[1] as ShapeElement;
  assert.equal(rect.paths[0].fill?.kind === 'solid' && rect.paths[0].fill.color, '#123456');
});
