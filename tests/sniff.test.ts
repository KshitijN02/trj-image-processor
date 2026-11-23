import { describe, expect, it } from 'vitest';
import { admit } from '../src/core/limits';
import { detectFormat, isAnimated, readDimensions } from '../src/core/sniff';
import { sample } from './helpers/samples';

describe('format detection & dimensions', () => {
  const cases = [
    ['photo.jpg', 'jpeg', 3000, 2000],
    ['rotated-exif6.jpg', 'jpeg', 600, 400],
    ['logo.png', 'png', 1200, 600],
    ['transparent.png', 'png', 800, 800],
    ['existing.webp', 'webp', 1600, 1067],
    ['existing.avif', 'avif', 1600, 1067],
    ['animated.gif', 'gif', 2, 2],
  ] as const;
  for (const [file, fmt, w, h] of cases) {
    it(file, () => {
      const b = sample(file);
      expect(detectFormat(b)).toBe(fmt);
      expect(readDimensions(b, fmt)).toEqual({ width: w, height: h });
    });
  }

  it('recognises HEIC by its ftyp brand', () => {
    const ftyp = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1heic')]);
    expect(detectFormat(ftyp)).toBe('heic');
    const avif = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode('ftypmif1'), 0, 0, 0, 0, ...new TextEncoder().encode('mif1avif')]);
    expect(detectFormat(avif)).toBe('avif');
  });
});

describe('animation detection', () => {
  it('flags animated GIF, not static images', () => {
    expect(isAnimated(sample('animated.gif'), 'gif')).toBe(true);
    expect(isAnimated(sample('existing.webp'), 'webp')).toBe(false);
    expect(isAnimated(sample('existing.avif'), 'avif')).toBe(false);
    expect(isAnimated(sample('logo.png'), 'png')).toBe(false);
  });

  it('flags animated WebP (VP8X animation bit) and AVIF sequences (avis)', () => {
    const webp = new Uint8Array(30);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8);
    webp[20] = 0x02;
    expect(isAnimated(webp, 'webp')).toBe(true);
    const avis = new Uint8Array([0, 0, 0, 20, ...new TextEncoder().encode('ftypavis'), 0, 0, 0, 0, ...new TextEncoder().encode('avif')]);
    expect(isAnimated(avis, 'avif')).toBe(true);
  });
});

describe('admission limits', () => {
  it('accepts normal files', () => {
    const r = admit(sample('photo.jpg'));
    expect(r.ok).toBe(true);
  });

  it('rejects files over 50 MB', () => {
    const big = new Uint8Array(50 * 1024 * 1024 + 1);
    big.set(sample('photo.jpg').subarray(0, 1000));
    const r = admit(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/50\.0 MB/);
  });

  it('rejects images above 100 megapixels using header dimensions only', () => {
    const png = sample('logo.png').slice();
    new DataView(png.buffer).setUint32(16, 12000); // width
    new DataView(png.buffer).setUint32(20, 9000); // height → 108 MP
    const r = admit(png);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/100 MP/);
  });

  it('rejects unknown formats', () => {
    expect(admit(new TextEncoder().encode('definitely not an image file')).ok).toBe(false);
  });
});
