import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWav, encodeWav, decodeRawPcm, resample, mixdown, soundEvents, soundSchedule, toFlashPcm, parseFlashFormat, decodeAdpcm, pcmLength, type Pcm,
} from '../src/core/sound';
import { parseFlv, splitVideoDat } from '../src/io/flv';
import { newDoc, emptyFrame, uid } from '../src/core/util';
import { insertFrames } from '../src/core/timeline';
import { translate } from '../src/core/matrix';
import { writeFla } from '../src/io/xfl-write';
import { readFla } from '../src/io/xfl-read';
import { writeSwf } from '../src/io/swf';
import { AssetStore } from '../src/core/assets';
import { readSwf } from './swf-reader';
import type { SoundItem, VideoItem, VideoInstance } from '../src/core/types';

const tone = (rate: number, secs: number, freq = 440, ch = 2): Pcm => {
  const n = Math.round(rate * secs);
  return { rate, channels: Array.from({ length: ch }, () => Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate))) };
};

test('sound: WAV encode/parse and Flash PCM conversion', () => {
  const p = tone(48000, 0.25);
  const wav = encodeWav(p);
  const back = parseWav(wav)!;
  assert.equal(back.rate, 48000);
  assert.equal(pcmLength(back), pcmLength(p));
  assert.ok(Math.abs(back.channels[1][100] - p.channels[1][100]) < 1e-3);
  const f = toFlashPcm(back);
  assert.equal(f.format, '44kHz 16bit Stereo');
  assert.equal(f.sampleCount, Math.round(0.25 * 44100));
  const raw = decodeRawPcm(f.bytes, 16, 2, 44100);
  assert.equal(pcmLength(raw), f.sampleCount);
  assert.deepEqual(parseFlashFormat('11kHz 8bit Mono'), { rate: 11025, bits: 8, channels: 1, adpcm: false });
  assert.equal(parseFlashFormat('22kHz ADPCM 4bit Stereo').adpcm, true);
  assert.equal(pcmLength(resample(tone(22050, 1, 440, 1), 44100)), 44100);
});

test('sound: ADPCM decoder follows the SWF bitstream layout', () => {
  // 2-bit header (code size 4 => value 2), one mono packet: initial sample 1000, index 0, then codes
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(2, 2); put(1000, 16); put(0, 6);
  for (let i = 0; i < 10; i++) put(i % 2 ? 0b0011 : 0b1011, 4); // alternate up/down
  while (bits.length % 8) bits.push(0);
  const bytes = new Uint8Array(bits.length / 8);
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 0x80 >> (i & 7); });
  const p = decodeAdpcm(bytes, 1, 11025);
  assert.equal(p.channels[0].length, 11);
  assert.ok(Math.abs(p.channels[0][0] * 32768 - 1000) < 1);
  assert.ok(p.channels[0][1] < p.channels[0][0], 'sign bit decreases the predictor');
  assert.ok(p.channels[0][2] > p.channels[0][1]);
});

test('sound: sync modes, loops and mixdown', () => {
  const doc = newDoc(100, 100, 10);
  const l = doc.scenes[0].layers[0];
  insertFrames(l, 0, 39); // 40 frames = 4 s
  // event sound at 0 (1 s, repeat 2), stream sound at 20 for 5 frames, stop of "a" at 10
  l.frames = [
    { ...emptyFrame(0, 10), sound: { name: 'a', sync: 'event', loopMode: 'repeat', loops: 3 } },
    { ...emptyFrame(10, 10), sound: { name: 'a', sync: 'stop', loopMode: 'repeat', loops: 1 } },
    { ...emptyFrame(20, 5), sound: { name: 'b', sync: 'stream', loopMode: 'loop', loops: 1 } },
    emptyFrame(25, 15),
  ];
  const ev = soundEvents(doc.scenes, [40]);
  assert.equal(ev.length, 3);
  const inst = soundSchedule(ev, 10, () => 1, 4);
  const a = inst.find((s) => s.ev.name === 'a')!;
  assert.equal(a.to, 1, 'stop sync cuts the event sound');
  const b = inst.find((s) => s.ev.name === 'b')!;
  assert.ok(Math.abs(b.to - 2.5) < 1e-9, 'stream sound ends with its frame span');
  const mix = mixdown(ev, new Map([['a', tone(44100, 1)], ['b', tone(22050, 1, 220, 1)]]), 10, 40);
  assert.equal(mix.channels.length, 2);
  assert.equal(pcmLength(mix), 4 * 44100);
  const rms = (a0: number, a1: number) => { let s = 0; for (let i = a0; i < a1; i++) s += mix.channels[0][i] ** 2; return Math.sqrt(s / (a1 - a0)); };
  assert.ok(rms(0, 44100) > 0.2);
  assert.ok(rms(44100 + 100, 2 * 44100) < 1e-6, 'silence after the stop');
  assert.ok(rms(2 * 44100, 2.5 * 44100) > 0.2);
  assert.ok(rms(2.5 * 44100 + 100, 3 * 44100) < 1e-6);
});

/** A tiny FLV: metadata + two Sorenson H.263 tags. */
function makeFlv(): Uint8Array {
  const out: number[] = [0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0];
  const tagOf = (type: number, ts: number, data: number[]) => {
    const n = data.length;
    out.push(type, (n >> 16) & 255, (n >> 8) & 255, n & 255, (ts >> 16) & 255, (ts >> 8) & 255, ts & 255, (ts >> 24) & 255, 0, 0, 0, ...data);
    const total = n + 11;
    out.push((total >> 24) & 255, (total >> 16) & 255, (total >> 8) & 255, total & 255);
  };
  const amfStr = (s: string) => [0, s.length, ...[...s].map((c) => c.charCodeAt(0))];
  const num = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b]; };
  const prop = (k: string, v: number) => [...amfStr(k).slice(0), 0, ...num(v)];
  const meta = [2, ...amfStr('onMetaData'), 8, 0, 0, 0, 4,
    ...prop('width', 64).slice(0), ...prop('height', 48), ...prop('framerate', 12), ...prop('duration', 2 / 12), 0, 0, 9];
  // fix: property keys are AMF strings without the type byte
  tagOf(18, 0, meta.map((x) => x));
  tagOf(9, 0, [0x12, 0, 0, 0x84, 0x00, 1, 2, 3]);
  tagOf(9, 83, [0x22, 0, 0, 0x84, 0x00, 4, 5]);
  return new Uint8Array(out);
}

test('video: FLV parsing and .dat splitting', () => {
  const flv = makeFlv();
  const v = parseFlv(flv)!;
  assert.equal(v.codec, 2);
  assert.equal(v.frames.length, 2);
  assert.equal(v.width, 64);
  assert.equal(v.height, 48);
  assert.equal(v.fps, 12);
  assert.ok(v.frames[0].key && !v.frames[1].key);
  assert.equal(v.frames[0].data.length, 7);
  const dat = new Uint8Array([3, 8, 1, 2, 3, 4, 5, 6, 7, 8, ...flv]);
  const sp = splitVideoDat(dat);
  assert.equal(sp.mime, 'video/x-flv');
  assert.equal(sp.prefix.length, 10);
  assert.equal(sp.stream.length, flv.length);
});

test('media: FLA round trip and SWF publishing of sounds and embedded video', async () => {
  const assets = new AssetStore();
  const doc = newDoc(200, 150, 12);
  const pcm = toFlashPcm(tone(44100, 0.5));
  const sa = assets.addRaw(pcm.bytes, 'audio/x-flash-pcm');
  const snd: SoundItem = { kind: 'sound', name: 'beep.wav', itemID: 'i1', assetId: sa.id, codec: 'pcm', format: pcm.format, sampleCount: pcm.sampleCount };
  const va = assets.addRaw(makeFlv(), 'video/x-flv');
  const vid: VideoItem = { kind: 'video', name: 'clip.flv', itemID: 'i2', assetId: va.id, mime: 'video/x-flv', width: 64, height: 48, fps: 12, duration: 2 / 12, videoType: 'h263 media', datPrefix: [3, 8, 0, 0, 0, 0, 0, 0, 0, 0] };
  doc.library.push(snd, vid);
  const l = doc.scenes[0].layers[0];
  const vi: VideoInstance = { type: 'video', id: uid(), matrix: translate(10, 20), libraryItem: 'clip.flv', width: 128, height: 96 };
  l.frames[0].elements.push(vi);
  insertFrames(l, 0, 3);
  l.frames[0].sound = { name: 'beep.wav', sync: 'start', loopMode: 'repeat', loops: 2 };

  const bytes = await writeFla(doc, { assets, pixels: async () => null });
  const back = await readFla(bytes, { assets: new AssetStore(), encodePng: async () => new Uint8Array() });
  assert.deepEqual(back.warnings.filter((w) => /sound|video|media/i.test(w)), []);
  const s2 = back.doc.library.find((i) => i.kind === 'sound') as SoundItem;
  assert.equal(s2.format, '44kHz 16bit Stereo');
  assert.equal(s2.sampleCount, pcm.sampleCount);
  const v2 = back.doc.library.find((i) => i.kind === 'video') as VideoItem;
  assert.equal(v2.mime, 'video/x-flv');
  assert.deepEqual(v2.datPrefix, vid.datPrefix);
  assert.equal(v2.fps, 12);
  const f0 = back.doc.scenes[0].layers[0].frames[0];
  assert.deepEqual(f0.sound, { name: 'beep.wav', sync: 'start', loopMode: 'repeat', loops: 2 });
  const vi2 = f0.elements[0] as VideoInstance;
  assert.equal(vi2.type, 'video');
  assert.equal(vi2.width, 128);

  const swf = await writeSwf(doc, { assets, pixels: async () => null, sounds: async () => decodeRawPcm(pcm.bytes, 16, 2, 44100) });
  const info = readSwf(swf);
  assert.equal(info.sounds.length, 1);
  assert.equal(info.sounds[0].format, 3);
  assert.equal(info.sounds[0].rate, 3);
  assert.ok(info.sounds[0].stereo && info.sounds[0].bits16);
  assert.equal(info.sounds[0].samples, pcm.sampleCount);
  assert.equal(info.sounds[0].dataLen, pcm.sampleCount * 4);
  assert.equal(info.startSounds.length, 1);
  assert.equal(info.startSounds[0].flags & 0x10, 0x10, 'start sync = no multiple');
  assert.equal(info.startSounds[0].loops, 2);
  assert.equal(info.videos.length, 1);
  assert.deepEqual([info.videos[0].frames, info.videos[0].width, info.videos[0].codec], [2, 64, 2]);
  assert.equal(info.videoFrames.length, 2);
  assert.deepEqual(info.ratios, [0, 1]);
  assert.ok(info.ratios.includes(1), 'the video advances its frame ratio');
});
