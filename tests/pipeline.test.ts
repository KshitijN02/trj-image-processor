import { describe, expect, it } from 'vitest';
import { metadataKinds } from '../src/core/metadata';
import { processImage, type PipelineDeps } from '../src/core/pipeline';
import { passes, scoreImages } from '../src/core/score';
import { DEFAULT_SETTINGS, thresholdFor } from '../src/core/settings';
import { detectFormat } from '../src/core/sniff';
import type { OutputFile, ProcessReport, RGBAImage, Settings } from '../src/core/types';
import { nodeCodecs, nodeDeps } from './helpers/node-deps';
import { sample } from './helpers/samples';

const settings = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, avifSpeed: 6, ...o });

/** Records the reference image each output was encoded from, keyed by "format@width". */
function spyDeps() {
  const refs = new Map<string, RGBAImage>();
  const deps: PipelineDeps = {
    ...nodeDeps,
    encode: (req) => {
      refs.set(`${req.format}@${req.image.width}`, req.image);
      return nodeDeps.encode(req);
    },
  };
  return { deps, refs };
}

async function run(file: string, s: Settings, deps: PipelineDeps = nodeDeps): Promise<ProcessReport> {
  return processImage({ name: file, bytes: sample(file) }, s, deps);
}

const main = (r: ProcessReport) => r.outputs.filter((o) => !o.variant);
const formats = (r: ProcessReport) => main(r).map((o) => o.format).sort();

async function expectOutputMatchesBytes(o: OutputFile) {
  // What we claim is what's in the file.
  if (o.format === 'gif') return;
  expect(detectFormat(o.bytes)).toBe(o.format);
  const decoded = await nodeCodecs.decodeOutput(o.format, o.bytes);
  expect([decoded.width, decoded.height]).toEqual([o.width, o.height]);
}

describe('pipeline: photo JPEG at default settings', () => {
  let report: ProcessReport;
  const spy = spyDeps();

  it('processes', async () => {
    report = await run('photo.jpg', settings(), spy.deps);
    expect(report.status).toBe('done');
  });

  it('JPEG in → AVIF + WebP out', () => {
    expect(formats(report)).toEqual(['avif', 'webp']);
  });

  it('resizes to the 2560 cap, keeping aspect ratio, and sharpens', async () => {
    expect(report.processed).toMatchObject({ width: 2560, height: 1707, resized: true, sharpened: true, kind: 'photo' });
    for (const o of report.outputs) {
      expect(Math.max(o.width, o.height)).toBeLessThanOrEqual(2560);
      expect(Math.abs(o.width / o.height - 3000 / 2000)).toBeLessThan(0.002);
      await expectOutputMatchesBytes(o);
    }
  });

  it('meets the photo SSIM threshold (independently re-measured)', async () => {
    const t = thresholdFor('standard', 'photo');
    for (const o of main(report)) {
      expect(o.thresholdMet).toBe(true);
      expect(o.ssim!).toBeGreaterThanOrEqual(t);
      const ref = spy.refs.get(`${o.format}@${o.width}`)!;
      const decoded = await nodeCodecs.decodeOutput(o.format as 'avif' | 'webp', o.bytes);
      const score = scoreImages(ref, decoded, { kind: 'photo', hasAlpha: false, algo: 'weber' });
      expect(passes(score, t)).toBe(true);
      expect(score.luma).toBeCloseTo(o.ssim!, 6);
    }
  });

  it('uses qualities inside the configured ranges', () => {
    const webp = main(report).find((o) => o.format === 'webp')!;
    const avif = main(report).find((o) => o.format === 'avif')!;
    expect(webp.quality).toBeGreaterThanOrEqual(60);
    expect(webp.quality).toBeLessThanOrEqual(92);
    expect(avif.quality).toBeGreaterThanOrEqual(35);
    expect(avif.quality).toBeLessThanOrEqual(80);
  });

  it('strips all metadata (input had EXIF, GPS, XMP, comment)', () => {
    expect(metadataKinds(sample('photo.jpg'), 'jpeg').length).toBeGreaterThan(0);
    for (const o of report.outputs) {
      expect(metadataKinds(o.bytes, o.format as 'avif' | 'webp')).toEqual([]);
      const text = new TextDecoder('latin1').decode(o.bytes);
      expect(text).not.toContain('TestCam');
      expect(text).not.toContain('xmpmeta');
    }
  });

  it('is smaller than the input', () => {
    for (const o of main(report)) expect(o.bytes.length).toBeLessThan(sample('photo.jpg').length);
  });

  it('writes no alpha channel for an opaque image', () => {
    const avif = main(report).find((o) => o.format === 'avif')!;
    expect(new TextDecoder('latin1').decode(avif.bytes)).not.toContain('auxiliary:alpha');
    const webp = main(report).find((o) => o.format === 'webp')!;
    expect(new TextDecoder('latin1').decode(webp.bytes.subarray(12, 16))).toBe('VP8 '); // simple lossy, no ALPH
  });

  it('names files originalname-<width>.<ext>', () => {
    expect(main(report).map((o) => o.name).sort()).toEqual(['photo-2560.avif', 'photo-2560.webp']);
  });
});

describe('pipeline: caps', () => {
  it('1920 cap', async () => {
    const r = await run('photo.jpg', settings({ cap: 1920, modernFormats: { avif: false, webp: true } }));
    expect(r.processed).toMatchObject({ width: 1920, height: 1280, resized: true });
  });

  it('3000 cap: image already fits, so no resize and no sharpening', async () => {
    const r = await run('photo.jpg', settings({ cap: 3000, modernFormats: { avif: false, webp: true } }));
    expect(r.processed).toMatchObject({ width: 3000, height: 2000, resized: false, sharpened: false });
  });

  it('never upscales a small image', async () => {
    const r = await run('rotated-exif6.jpg', settings({ modernFormats: { avif: false, webp: true } }));
    expect(r.processed!.resized).toBe(false);
    expect(Math.max(r.processed!.width, r.processed!.height)).toBe(600);
  });
});

describe('pipeline: format rules on real files', () => {
  it('WebP in → WebP out only, never larger than input', async () => {
    const input = sample('existing.webp');
    const r = await run('existing.webp', settings({ fallback: true }));
    expect(formats(r)).toEqual(['webp']);
    for (const o of main(r)) {
      expect(o.bytes.length).toBeLessThanOrEqual(input.length);
      if (!o.keptOriginal) expect(o.bytes.length).toBeLessThanOrEqual(input.length * 0.95);
      await expectOutputMatchesBytes(o);
    }
  });

  it('AVIF in → AVIF out only, never larger than input', async () => {
    const input = sample('existing.avif');
    const r = await run('existing.avif', settings({ fallback: true }));
    expect(formats(r)).toEqual(['avif']);
    for (const o of main(r)) {
      expect(o.bytes.length).toBeLessThanOrEqual(input.length);
      if (o.keptOriginal) expect(o.note).toMatch(/Already optimal/);
      await expectOutputMatchesBytes(o);
    }
  });

  it('"also create the other modern format" for WebP input', async () => {
    const r = await run('existing.webp', settings({ alsoOtherModern: true }));
    expect(formats(r)).toEqual(['avif', 'webp']);
  });
});

describe('pipeline: never larger than input (same format)', () => {
  it('keeps the original JPEG, metadata-stripped, when re-encoding cannot beat it', async () => {
    // A small, already heavily compressed JPEG: passing SSIM needs a higher quality, so the result grows.
    const src = await nodeDeps.decode(sample('rotated-exif6.jpg'), 'jpeg');
    const tiny = await nodeCodecs.encode({ format: 'jpeg', image: src, mode: { kind: 'lossy', quality: 40, chroma: '420' }, avifSpeed: 6 });
    const r = await processImage(
      { name: 'tiny.jpg', bytes: tiny },
      settings({ modernFormats: { avif: false, webp: false }, fallback: true }),
      nodeDeps,
    );
    const jpeg = main(r).find((o) => o.format === 'jpeg')!;
    expect(jpeg.bytes.length).toBeLessThanOrEqual(tiny.length);
    expect(jpeg.keptOriginal).toBe(true);
    expect(jpeg.note).toMatch(/Already optimal/);
  });

  it('a re-encoded JPEG fallback is smaller than the input JPEG', async () => {
    const r = await run('photo.jpg', settings({ cap: 1920, modernFormats: { avif: false, webp: true }, fallback: true }));
    const jpeg = main(r).find((o) => o.format === 'jpeg')!;
    expect(jpeg.bytes.length).toBeLessThan(sample('photo.jpg').length);
    expect(metadataKinds(jpeg.bytes, 'jpeg')).toEqual([]);
  });
});

describe('pipeline: SSIM threshold per safety level', () => {
  for (const safety of ['high', 'maximum'] as const) {
    it(`${safety}`, async () => {
      const spy = spyDeps();
      const r = await run('existing.webp', settings({ safety, modernFormats: { avif: false, webp: true } }), spy.deps);
      const t = thresholdFor(safety, 'photo');
      expect(r.processed!.threshold).toBe(t);
      for (const o of main(r)) {
        if (o.keptOriginal) continue;
        const ref = spy.refs.get(`${o.format}@${o.width}`)!;
        const decoded = await nodeCodecs.decodeOutput('webp', o.bytes);
        const luma = scoreImages(ref, decoded, { kind: 'photo', hasAlpha: false, algo: 'weber' }).luma;
        if (o.thresholdMet) expect(luma).toBeGreaterThanOrEqual(t);
        else expect(o.quality).toBe(92); // only allowed to miss at the top of the range
      }
    });
  }
});

describe('pipeline: content-specific handling', () => {
  it('logo → graphic; tries lossless/palette/4:4:4 and passes the graphic threshold', async () => {
    const input = sample('logo.png');
    const r = await run('logo.png', settings({ fallback: true }));
    expect(r.processed!.kind).toBe('graphic');
    expect(r.processed!.threshold).toBe(0.99);
    expect(formats(r)).toEqual(['avif', 'png', 'webp']);
    for (const o of main(r)) {
      expect(o.thresholdMet).toBe(true);
      expect(o.ssim ?? 1).toBeGreaterThanOrEqual(0.99);
      await expectOutputMatchesBytes(o);
    }
    const avif = main(r).find((o) => o.format === 'avif')!;
    expect(avif.modeLabel === 'lossless' || avif.modeLabel.includes('4:4:4')).toBe(true);
    const png = main(r).find((o) => o.format === 'png')!;
    expect(png.bytes.length).toBeLessThanOrEqual(input.length);
    expect(metadataKinds(png.bytes, 'png')).toEqual([]);
  });

  it('transparent PNG keeps its alpha channel', async () => {
    const r = await run('transparent.png', settings());
    expect(r.processed!.hasAlpha).toBe(true);
    for (const o of main(r)) {
      const d = await nodeCodecs.decodeOutput(o.format as 'avif' | 'webp', o.bytes);
      let transparent = 0;
      for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < 10) transparent++;
      expect(transparent).toBeGreaterThan(d.width * d.height * 0.2);
      expect(o.thresholdMet).toBe(true);
    }
  });

  it('noisy low-light photo gets denoised; clean photo does not', async () => {
    const noisy = await run('noisy-lowlight.jpg', settings({ modernFormats: { avif: false, webp: true } }));
    expect(noisy.processed!.denoised).toBe(true);
    expect(noisy.processed!.sharpened).toBe(false); // not resized (1600 px)
    const clean = await run('existing.webp', settings());
    expect(clean.processed!.denoised).toBe(false);
    const off = await run('noisy-lowlight.jpg', settings({ denoise: 'off', modernFormats: { avif: false, webp: true } }));
    expect(off.processed!.denoised).toBe(false);
  });

  it('applies EXIF orientation (600×400 stored, orientation 6 → 400×600)', async () => {
    const r = await run('rotated-exif6.jpg', settings({ modernFormats: { avif: false, webp: true } }));
    expect([r.input.width, r.input.height]).toEqual([400, 600]);
    expect([main(r)[0].width, main(r)[0].height]).toEqual([400, 600]);
  });

  it('passes animated GIFs through unchanged with a warning', async () => {
    const input = sample('animated.gif');
    const r = await run('animated.gif', settings());
    expect(r.status).toBe('passthrough');
    expect(r.warnings.join(' ')).toMatch(/Animated/);
    expect(Buffer.compare(Buffer.from(r.outputs[0].bytes), Buffer.from(input))).toBe(0);
  });
});

describe('pipeline: responsive sizes', () => {
  it('exports 400/800/1600 widths below the processed width, same formats and adaptive quality', async () => {
    const r = await run('photo.jpg', settings({ cap: 1920, responsive: true, modernFormats: { avif: false, webp: true } }));
    const variants = r.outputs.filter((o) => o.variant);
    expect(variants.map((o) => o.name).sort()).toEqual(['photo-1600.webp', 'photo-400.webp', 'photo-800.webp']);
    for (const v of variants) {
      expect(v.thresholdMet).toBe(true);
      expect(v.height).toBe(Math.round((2000 * v.width) / 3000));
    }
  });

  it('skips widths that are not smaller than the image', async () => {
    const r = await run('rotated-exif6.jpg', settings({ responsive: true, modernFormats: { avif: false, webp: true } }));
    expect(r.outputs.filter((o) => o.variant).map((o) => o.width)).toEqual([]); // 400 wide: nothing smaller in the list
  });
});

describe('pipeline: errors', () => {
  it('reports a clear error for a corrupt file', async () => {
    const logo = sample('logo.png');
    const corrupt = new Uint8Array(4060);
    corrupt.set(logo.subarray(0, 60));
    corrupt.fill(7, 60);
    await expect(processImage({ name: 'corrupt.png', bytes: corrupt }, settings(), nodeDeps)).rejects.toThrow(/corrupt or truncated/);
  });
});
