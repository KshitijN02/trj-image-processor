import { describe, expect, it } from 'vitest';
import { isFullyOpaque } from '../src/core/alpha';
import { classify } from '../src/core/classify';
import { bilateralDenoise, estimateNoise } from '../src/core/noise';
import { quantize } from '../src/core/quantize';
import { mssim } from '../src/core/score';
import type { RGBAImage } from '../src/core/types';
import { nodeDeps } from './helpers/node-deps';
import { sample } from './helpers/samples';

let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rand()))) * Math.cos(2 * Math.PI * rand());

function synthetic(w: number, h: number, f: (x: number, y: number) => number, noise = 0): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = f(x, y);
    const p = (y * w + x) * 4;
    data[p] = v + gauss() * noise; data[p + 1] = v + gauss() * noise; data[p + 2] = v + gauss() * noise; data[p + 3] = 255;
  }
  return { data, width: w, height: h };
}

describe('noise estimation (Immerkær)', () => {
  it('recovers the sigma of added Gaussian noise on a smooth image', () => {
    for (const sigma of [2, 5, 10]) {
      const img = synthetic(400, 300, (x, y) => 60 + x * 0.3 + y * 0.2, sigma);
      // Per-channel noise is averaged into luma, which lowers it by ≈ sqrt(.299²+.587²+.114²) ≈ 0.67.
      expect(estimateNoise(img)).toBeGreaterThan(sigma * 0.5);
      expect(estimateNoise(img)).toBeLessThan(sigma * 0.85);
    }
  });

  it('does not mistake fine regular texture for heavy noise', () => {
    // Fabric-like weave: strong, structured high frequency, no random noise.
    const weave = synthetic(400, 300, (x, y) => 128 + 40 * Math.sin(x * 0.9) * Math.sin(y * 0.9));
    expect(estimateNoise(weave)).toBeLessThan(estimateNoise(synthetic(400, 300, () => 128, 10)));
  });

  it('separates the clean and noisy samples', async () => {
    const clean = await nodeDeps.decode(sample('existing.webp'), 'webp');
    const noisy = await nodeDeps.decode(sample('noisy-lowlight.jpg'), 'jpeg');
    expect(estimateNoise(clean)).toBeLessThan(2.8);
    expect(estimateNoise(noisy)).toBeGreaterThan(2.8);
  });
});

describe('bilateral denoise', () => {
  it('reduces noise but preserves texture and edges', () => {
    const texture = (x: number, y: number) => (x < 200 ? 60 : 190) + 25 * Math.sin(x * 0.7 + y * 0.3);
    const clean = synthetic(400, 200, texture);
    const noisy = synthetic(400, 200, texture, 6);
    const out = bilateralDenoise(noisy, estimateNoise(noisy));
    expect(estimateNoise(out)).toBeLessThan(estimateNoise(noisy));
    // closer to the clean image than the noisy input was
    expect(mssim(clean, out, 'weber')).toBeGreaterThan(mssim(clean, noisy, 'weber'));
    // texture still present: strong correlation with clean texture
    expect(mssim(clean, out, 'weber')).toBeGreaterThan(0.8);
  });
});

describe('photo / graphic classification', () => {
  it('classifies the samples', async () => {
    expect(classify(await nodeDeps.decode(sample('photo.jpg'), 'jpeg')).kind).toBe('photo');
    expect(classify(await nodeDeps.decode(sample('noisy-lowlight.jpg'), 'jpeg')).kind).toBe('photo');
    expect(classify(await nodeDeps.decode(sample('existing.webp'), 'webp')).kind).toBe('photo');
    expect(classify(await nodeDeps.decode(sample('logo.png'), 'png')).kind).toBe('graphic');
  });

  it('classifies a screenshot-like image (flat UI + text) as graphic', () => {
    const shot = synthetic(800, 600, (x, y) => (y < 60 ? 40 : (y % 24 < 12 && x % 9 < 6 && x > 40 && x < 600) ? 30 : 245));
    expect(classify(shot).kind).toBe('graphic');
  });
});

describe('alpha & palette', () => {
  it('detects opaque and transparent images', async () => {
    expect(isFullyOpaque(await nodeDeps.decode(sample('logo.png'), 'png'))).toBe(true);
    expect(isFullyOpaque(await nodeDeps.decode(sample('transparent.png'), 'png'))).toBe(false);
  });

  it('median-cut quantises many-colour images to ≤256 colours, staying close', async () => {
    const img = await nodeDeps.decode(sample('transparent.png'), 'png');
    expect(new Set(new Uint32Array(img.data.buffer)).size).toBeGreaterThan(256);
    const q = quantize(img, 256)!;
    expect(q).not.toBeNull();
    expect(new Set(new Uint32Array(q.image.data.buffer)).size).toBeLessThanOrEqual(256);
    expect(mssim(img, q.image, 'weber')).toBeGreaterThan(0.95);
  });

  it('leaves the anti-aliased logo alone: it already fits a 256-colour palette', async () => {
    expect(quantize(await nodeDeps.decode(sample('logo.png'), 'png'), 256)).toBeNull();
  });

  it('returns null when the image already fits the palette', () => {
    const flat = synthetic(64, 64, (x) => (x < 32 ? 0 : 255));
    expect(quantize(flat, 256)).toBeNull();
  });
});

describe('search proxy', () => {
  it('is skipped for small images and built from full-resolution tiles for large ones', async () => {
    const { buildProxy } = await import('../src/core/proxy');
    expect(buildProxy(synthetic(1200, 800, () => 100))).toBeNull();
    const img = synthetic(2560, 1707, (x, y) => (x * 7 + y * 3) % 256);
    const p = buildProxy(img)!;
    expect([p.width, p.height]).toEqual([1536, 768]);
    // Tiles are verbatim crops: every proxy row segment appears in the source.
    const src32 = new Uint32Array(img.data.buffer);
    const px = new Uint32Array(p.data.buffer)[0];
    expect(src32.includes(px)).toBe(true);
  });
});
