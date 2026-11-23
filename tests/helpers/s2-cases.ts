import type { RGBAImage } from '../../src/core/types';
import { nodeCodecs, nodeDeps } from './node-deps';
import { sample } from './samples';

/*
 * Deterministic (source, distorted) pairs for validating the SSIMULACRA 2 port
 * against the Rust reference. Everything is regenerated from the samples with
 * fixed settings, so no image fixtures need to be committed. Only the reference
 * scores live in tests/fixtures/ssimulacra2-reference.json.
 */

export interface S2Case {
  id: string;
  source: RGBAImage;
  distorted: RGBAImage;
}

function crop(img: RGBAImage, x: number, y: number, w: number, h: number): RGBAImage {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.width + x) * 4;
    out.set(img.data.subarray(s, s + w * 4), r * w * 4);
  }
  return { data: out, width: w, height: h };
}

function boxBlur3(img: RGBAImage): RGBAImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            s += data[(yy * w + xx) * 4 + c];
          }
        out[(y * w + x) * 4 + c] = Math.round(s / 9);
      }
  return { data: out, width: w, height: h };
}

function addNoise(img: RGBAImage, amp: number, seed: number): RGBAImage {
  let st = seed >>> 0;
  const rnd = () => ((st = (st * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i++) if ((i & 3) !== 3) out[i] = out[i] + Math.round(rnd() * 2 * amp);
  return { data: out, width: img.width, height: img.height };
}

async function roundTrip(img: RGBAImage, format: 'jpeg' | 'webp' | 'avif', quality: number): Promise<RGBAImage> {
  const bytes = await nodeCodecs.encode({ format, image: img, mode: { kind: 'lossy', quality, chroma: '420' }, avifSpeed: 6 });
  return nodeCodecs.decodeOutput(format, bytes);
}

export async function buildCases(): Promise<S2Case[]> {
  const photo = await nodeDeps.decode(sample('photo.jpg'), 'jpeg');
  const noisy = await nodeDeps.decode(sample('noisy-lowlight.jpg'), 'jpeg');
  const logo = await nodeDeps.decode(sample('logo.png'), 'png');
  const sources: [string, RGBAImage][] = [
    ['photo', crop(photo, 1200, 700, 512, 384)],
    ['noisy', crop(noisy, 500, 300, 333, 251)], // odd size: exercises edge handling at every scale
    ['logo', crop(logo, 40, 100, 512, 384)],
  ];
  const cases: S2Case[] = [];
  for (const [name, src] of sources) {
    cases.push({ id: `${name}/identical`, source: src, distorted: src });
    for (const q of [20, 50, 85]) cases.push({ id: `${name}/jpeg-q${q}`, source: src, distorted: await roundTrip(src, 'jpeg', q) });
    for (const q of [40, 80]) cases.push({ id: `${name}/webp-q${q}`, source: src, distorted: await roundTrip(src, 'webp', q) });
    for (const q of [30, 60]) cases.push({ id: `${name}/avif-q${q}`, source: src, distorted: await roundTrip(src, 'avif', q) });
    cases.push({ id: `${name}/blur3`, source: src, distorted: boxBlur3(src) });
    cases.push({ id: `${name}/noise8`, source: src, distorted: addNoise(src, 8, 7) });
  }
  return cases;
}
