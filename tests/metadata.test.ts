import { describe, expect, it } from 'vitest';
import { metadataKinds, stripJpeg, stripMetadata, stripPng, stripWebp } from '../src/core/metadata';
import { applyOrientation, jpegOrientation } from '../src/core/orientation';
import { nodeCodecs } from './helpers/node-deps';
import { sample } from './helpers/samples';

describe('metadata stripping (lossless)', () => {
  it('sample JPEG really contains EXIF, GPS, XMP and a comment', () => {
    expect(metadataKinds(sample('photo.jpg'), 'jpeg').sort()).toEqual(['comment', 'exif', 'gps', 'xmp']);
  });

  it('removes EXIF/GPS/XMP/comments from JPEG without touching pixels', async () => {
    const src = sample('photo.jpg');
    const out = stripJpeg(src);
    expect(metadataKinds(out, 'jpeg')).toEqual([]);
    expect(out.length).toBeLessThan(src.length);
    const a = await nodeCodecs.decodeOutput('jpeg', src);
    const b = await nodeCodecs.decodeOutput('jpeg', out);
    expect(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data))).toBe(0);
  });

  it('keeps only a minimal orientation tag when the JPEG is rotated', async () => {
    const src = sample('rotated-exif6.jpg');
    expect(jpegOrientation(src)).toBe(6);
    const out = stripJpeg(src);
    expect(metadataKinds(out, 'jpeg')).toEqual(['orientation']);
    expect(jpegOrientation(out)).toBe(6);
    expect(new TextDecoder('latin1').decode(out)).not.toContain('TestCam');
  });

  it('removes PNG text chunks', () => {
    const src = sample('logo.png');
    expect(metadataKinds(src, 'png')).toEqual(['text']);
    const out = stripPng(src);
    expect(metadataKinds(out, 'png')).toEqual([]);
  });

  it('removes WebP EXIF/XMP chunks and fixes the RIFF header', async () => {
    // Build a VP8X WebP with EXIF + XMP from the sample (simple-format) WebP.
    const simple = sample('existing.webp');
    const vp8 = simple.subarray(12);
    const exif = new Uint8Array([...new TextEncoder().encode('EXIF'), 8, 0, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8]);
    const xmp = new Uint8Array([...new TextEncoder().encode('XMP '), 4, 0, 0, 0, 1, 2, 3, 4]);
    const vp8x = new Uint8Array(18);
    vp8x.set(new TextEncoder().encode('VP8X'));
    vp8x[4] = 10;
    vp8x[8] = 0x0c; // EXIF + XMP flags
    const w = 1600 - 1, h = 1067 - 1;
    vp8x.set([w & 255, (w >> 8) & 255, w >> 16, h & 255, (h >> 8) & 255, h >> 16], 12);
    const body = new Uint8Array([...new TextEncoder().encode('WEBP'), ...vp8x, ...vp8, ...exif, ...xmp]);
    const file = new Uint8Array(8 + body.length);
    file.set(new TextEncoder().encode('RIFF'));
    new DataView(file.buffer).setUint32(4, body.length, true);
    file.set(body, 8);
    expect(metadataKinds(file, 'webp').sort()).toEqual(['exif', 'xmp']);

    const out = stripWebp(file);
    expect(metadataKinds(out, 'webp')).toEqual([]);
    expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0);
    const decoded = await nodeCodecs.decodeOutput('webp', out);
    expect(decoded.width).toBe(1600);
  });

  it('leaves AVIF untouched (not supported losslessly) and says so', () => {
    const r = stripMetadata(sample('existing.avif'), 'avif');
    expect(r.stripped).toBe(false);
  });
});

describe('EXIF orientation', () => {
  const img = { width: 3, height: 2, data: new Uint8ClampedArray(3 * 2 * 4) };
  // pixel values 0..5 in the red channel, row-major: [0 1 2; 3 4 5]
  for (let i = 0; i < 6; i++) img.data[i * 4] = i;
  const red = (o: { data: Uint8ClampedArray; width: number }) => Array.from({ length: o.data.length / 4 }, (_, i) => o.data[i * 4]);

  it.each([
    [1, 3, 2, [0, 1, 2, 3, 4, 5]],
    [2, 3, 2, [2, 1, 0, 5, 4, 3]],
    [3, 3, 2, [5, 4, 3, 2, 1, 0]],
    [4, 3, 2, [3, 4, 5, 0, 1, 2]],
    [5, 2, 3, [0, 3, 1, 4, 2, 5]],
    [6, 2, 3, [3, 0, 4, 1, 5, 2]],
    [7, 2, 3, [5, 2, 4, 1, 3, 0]],
    [8, 2, 3, [2, 5, 1, 4, 0, 3]],
  ])('orientation %i', (o, w, h, expected) => {
    const r = applyOrientation(img, o);
    expect([r.width, r.height]).toEqual([w, h]);
    expect(red(r)).toEqual(expected);
  });
});
