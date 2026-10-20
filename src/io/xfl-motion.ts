// <motionObjectXML><AnimationCore> reading and writing for object-based motion tweens.
import type { Frame } from '../core/types';
import type { MotionData, MotionKey, MotionProp } from '../core/motion';
import { baseParts } from '../core/motion';
import { child, kids, attr, type XNode } from './xml';
import type { XmlWriter } from './xml';

const pair = (s: string | undefined): [number, number] | null => {
  if (!s) return null;
  const [a, b] = s.split(',').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
};

/** Parses an <AnimationCore> element. Times become frames at `fps`. */
export function readAnimationCore(core: XNode, fps: number): MotionData {
  const timeScale = Number(attr(core, 'TimeScale', '')) || fps * 1000;
  const toFrames = (ticks: number) => (ticks * fps) / timeScale;
  const data: MotionData = { timeMaps: [], props: [] };
  for (const tm of kids(core, 'TimeMap')) data.timeMaps.push({ type: attr(tm, 'type', 'Linear'), strength: Number(attr(tm, 'strength', '0')) || 0 });
  if (!data.timeMaps.length) data.timeMaps.push({ type: 'Quadratic', strength: 0 });
  const settings = child(child(core, 'metadata'), 'Settings');
  if (settings && attr(settings, 'orientToPath', '0') === '1') data.orientToPath = true;
  const walk = (n: XNode, path: string[]) => {
    for (const c of n.children) {
      if (c.name === 'PropertyContainer') walk(c, [...path, attr(c, 'id', '')]);
      else if (c.name === 'Property') {
        const id = attr(c, 'id', '');
        if (!id) continue;
        const keys: MotionKey[] = [];
        for (const k of kids(c, 'Keyframe')) {
          const t = toFrames(Number(attr(k, 'timevalue', '0')) || 0);
          const anchor = pair(k.attrs.anchor);
          if (anchor) {
            const key: MotionKey = { t, v: anchor[1] };
            const nx = pair(k.attrs.next), pv = pair(k.attrs.previous);
            if (nx && (nx[0] !== 0 || nx[1] !== anchor[1])) key.next = [toFrames(nx[0]), nx[1]];
            if (pv && (pv[0] !== 0 || pv[1] !== anchor[1])) key.prev = [toFrames(pv[0]), pv[1]];
            keys.push(key);
          } else if (k.attrs.value && /^0x[0-9a-f]{8}$/i.test(k.attrs.value)) {
            const n2 = parseInt(k.attrs.value.slice(2), 16);
            keys.push({ t, v: 0, rgba: [(n2 >>> 24) & 255, (n2 >>> 16) & 255, (n2 >>> 8) & 255, n2 & 255] });
          } else if (k.attrs.value !== undefined && Number.isFinite(Number(k.attrs.value))) {
            keys.push({ t, v: Number(k.attrs.value) });
          }
        }
        keys.sort((a, b) => a.t - b.t);
        const prop: MotionProp = { id, container: path.filter((x) => x !== 'headContainer').join('/'), keys };
        if (c.attrs.enabled === '0') continue;
        if (c.attrs.ignoreTimeMap === '1') prop.ignoreTimeMap = true;
        if (c.attrs.TimeMapIndex) prop.timeMap = Number(c.attrs.TimeMapIndex) || 0;
        if (!keys.length && c.attrs.value !== undefined) prop.value = c.attrs.value;
        data.props.push(prop);
      }
    }
  };
  walk(core, []);
  return data;
}

const num = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

const DEFAULTS: [string, string][] = [
  ['Motion_X', 'Basic_Motion'], ['Motion_Y', 'Basic_Motion'], ['Rotation_Z', 'Basic_Motion'],
  ['Skew_X', 'Transformation'], ['Skew_Y', 'Transformation'], ['Scale_X', 'Transformation'], ['Scale_Y', 'Transformation'],
];

/** Writes the <motionObjectXML> block of a motion tween frame. */
export function writeMotionObject(w: XmlWriter, fr: Frame, fps: number) {
  const data = fr.motion!;
  const ts = Math.round(fps * 1000);
  const ticks = (frames: number) => Math.round((frames * ts) / fps);
  // Animate always stores the basic transform properties: add flat ones for any missing
  const props = data.props.slice();
  const base = fr.elements[0];
  const b = base ? baseParts(base.matrix) : { rotation: 0, skewX: 0, skewY: 0, scaleX: 100, scaleY: 100 };
  const flat: Record<string, number> = { Motion_X: 0, Motion_Y: 0, Rotation_Z: b.rotation, Skew_X: b.skewX, Skew_Y: b.skewY, Scale_X: b.scaleX, Scale_Y: b.scaleY };
  for (const [id, container] of DEFAULTS) {
    if (!props.some((p) => p.id === id)) props.push({ id, container, keys: [{ t: 0, v: flat[id] }] });
  }
  // build the container tree
  interface Node { id: string; kids: Node[]; props: MotionProp[] }
  const root: Node = { id: 'headContainer', kids: [], props: [] };
  const get = (path: string) => {
    let n = root;
    for (const part of path.split('/').filter(Boolean)) {
      let c = n.kids.find((k) => k.id === part);
      if (!c) { c = { id: part, kids: [], props: [] }; n.kids.push(c); }
      n = c;
    }
    return n;
  };
  for (const id of ['Basic_Motion', 'Colors', 'Filters', 'Transformation']) get(id);
  for (const p of props) get(p.container || 'Basic_Motion').props.push(p);

  w.open('motionObjectXML');
  w.open('AnimationCore', { TimeScale: ts, Version: 1, duration: ticks(fr.duration) });
  for (const tm of data.timeMaps) w.leaf('TimeMap', { strength: num(tm.strength), type: tm.type });
  w.open('metadata');
  w.open('names').leaf('name', { langID: 'en_US', value: '' }).close();
  w.leaf('Settings', { orientToPath: data.orientToPath ? 1 : 0, xformPtXOffsetPct: '0.5', xformPtYOffsetPct: '0.5', xformPtZOffsetPixels: '0' });
  w.close();
  const writeNode = (n: Node) => {
    if (!n.kids.length && !n.props.length) { w.leaf('PropertyContainer', { id: n.id }); return; }
    w.open('PropertyContainer', { id: n.id });
    for (const p of n.props) {
      if (!p.keys.length) {
        w.leaf('Property', { enabled: 1, id: p.id, readonly: 0, value: p.value ?? '0', visible: 1 });
        continue;
      }
      w.open('Property', { TimeMapIndex: p.timeMap ? p.timeMap : undefined, enabled: 1, id: p.id, ignoreTimeMap: p.ignoreTimeMap ? 1 : 0, readonly: 0, visible: 1 });
      for (const k of p.keys) {
        if (k.rgba) {
          const hex = k.rgba.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
          w.leaf('Keyframe', { roving: 0, timevalue: ticks(k.t), value: '0x' + hex });
        } else {
          w.leaf('Keyframe', {
            anchor: `0,${num(k.v)}`,
            next: k.next ? `${ticks(k.next[0])},${num(k.next[1])}` : `0,${num(k.v)}`,
            previous: k.prev ? `${ticks(k.prev[0])},${num(k.prev[1])}` : `0,${num(k.v)}`,
            roving: 0,
            timevalue: ticks(k.t),
          });
        }
      }
      w.close();
    }
    for (const c of n.kids) writeNode(c);
    w.close();
  };
  writeNode(root);
  w.close();
  w.close();
}
