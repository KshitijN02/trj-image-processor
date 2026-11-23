import { describe, expect, it } from 'vitest';
import { processImage } from '../src/core/pipeline';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { ProcessReport, Settings } from '../src/core/types';
import { nodeCodecs, nodeDeps } from './helpers/node-deps';
import { sample } from './helpers/samples';

const settings = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, avifSpeed: 6, ...o });
const run = (file: string, s: Settings): Promise<ProcessReport> => processImage({ name: file, bytes: sample(file) }, s, nodeDeps);

async function expectAllUnder(r: ProcessReport, maxBytes: number, srcRatio: number) {
  expect(r.outputs.length).toBeGreaterThan(0);
  for (const o of r.outputs) {
    expect(o.bytes.length, o.name).toBeLessThanOrEqual(maxBytes);
    if (o.format === 'gif') continue;
    // The file really is what the report says, and the aspect ratio survived any downscale.
    const d = await nodeCodecs.decodeOutput(o.format, o.bytes);
    expect([d.width, d.height]).toEqual([o.width, o.height]);
    expect(o.name).toContain(`-${o.width}.`);
    expect(Math.abs(o.width / o.height - srcRatio)).toBeLessThan(2 / Math.min(o.width, o.height) * srcRatio + 0.01);
  }
}

describe('file-size limit (quality compromise allowed)', () => {
  it('50 KB: every output of the 3000×2000 photo fits; only over-limit formats are touched', async () => {
    const r = await run('photo.jpg', settings({ maxFileKB: 50, fallback: true }));
    await expectAllUnder(r, 50_000, 1.5);
    const by = Object.fromEntries(r.outputs.map((o) => [o.format, o]));
    // AVIF was ~32 KB at full quality-safe settings: left as is.
    expect(by.avif.sizeCapped).toBeFalsy();
    expect(by.avif.thresholdMet).toBe(true);
    // WebP (~115 KB) and JPEG (~110 KB) had to give.
    expect(by.webp.sizeCapped).toBe(true);
    expect(by.jpeg.sizeCapped).toBe(true);
    expect(by.webp.note).toMatch(/Size limit 50 KB/);
    expect(r.warnings.some((w) => /Size limit 50 KB/.test(w))).toBe(true);
  });

  it('downscales when the quality floor alone is not enough', async () => {
    const r = await run('photo.jpg', settings({ cap: 1920, maxFileKB: 8, modernFormats: { avif: false, webp: true } }));
    await expectAllUnder(r, 8_000, 1.5);
    const webp = r.outputs[0];
    expect(webp.sizeCapped).toBe(true);
    expect(webp.width).toBeLessThan(1920);
    expect(webp.note).toMatch(/resized to/);
  });

  it('heavy noise (worst case for compression) still ends up under the limit', async () => {
    const r = await run('noisy-lowlight.jpg', settings({ maxFileKB: 50, fallback: true }));
    await expectAllUnder(r, 50_000, 1600 / 1067);
  });

  it('transparent PNG: palette reduction / downscale keeps alpha and fits', async () => {
    const r = await run('transparent.png', settings({ maxFileKB: 3, fallback: true }));
    await expectAllUnder(r, 3_000, 1);
    for (const o of r.outputs) {
      const d = await nodeCodecs.decodeOutput(o.format as 'avif' | 'webp' | 'png', o.bytes);
      let clear = 0;
      for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < 10) clear++;
      expect(clear).toBeGreaterThan(d.width * d.height * 0.2);
    }
  });

  it('a same-format original above the limit is never kept, even if re-encoding saves < 5 %', async () => {
    const r = await run('existing.webp', settings({ maxFileKB: 30 }));
    await expectAllUnder(r, 30_000, 1600 / 1067);
    expect(r.outputs[0].keptOriginal).toBe(false);
  });

  it('applies to responsive variants too', async () => {
    const r = await run('photo.jpg', settings({ cap: 1920, maxFileKB: 20, responsive: true, modernFormats: { avif: false, webp: true } }));
    await expectAllUnder(r, 20_000, 1.5);
    const main = r.outputs.find((o) => !o.variant)!;
    const variants = r.outputs.filter((o) => o.variant);
    expect(variants.length).toBeGreaterThan(0);
    // The limit shrank the main file below 1600 px, so the 1600 variant is dropped: variants stay smaller.
    for (const v of variants) expect(v.width).toBeLessThan(main.width);
  });

  it('off by default: behaviour unchanged', async () => {
    expect(DEFAULT_SETTINGS.maxFileKB).toBeNull();
    const r = await run('logo.png', settings());
    expect(r.outputs.every((o) => !o.sizeCapped)).toBe(true);
  });
});
