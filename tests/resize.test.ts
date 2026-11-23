import { describe, expect, it } from 'vitest';
import { fitToWidth, fitWithinCap } from '../src/core/resize';

describe('fitWithinCap', () => {
  const cases: [number, number][] = [
    [6000, 4000], [4000, 6000], [3000, 3000], [8192, 1000], [1000, 8192], [2561, 1], [1, 2561], [5472, 3648], [4032, 3024],
  ];
  for (const cap of [1920, 2560, 3000]) {
    for (const [w, h] of cases) {
      it(`${w}×${h} within ${cap}`, () => {
        const r = fitWithinCap({ width: w, height: h }, cap);
        expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(cap);
        expect(r.width).toBeLessThanOrEqual(w);
        expect(r.height).toBeLessThanOrEqual(h);
        expect(r.width).toBeGreaterThanOrEqual(1);
        expect(r.height).toBeGreaterThanOrEqual(1);
        // Longest edge hits the cap exactly when the source exceeds it.
        if (Math.max(w, h) > cap) expect(Math.max(r.width, r.height)).toBe(cap);
        // Aspect ratio preserved to within rounding of the short edge.
        const short = Math.min(r.width, r.height);
        expect(Math.abs(r.width / r.height - w / h)).toBeLessThanOrEqual((w / h) * (1 / Math.max(short, 1)) + 1e-9);
      });
    }
  }

  it('never upscales small images', () => {
    expect(fitWithinCap({ width: 800, height: 600 }, 2560)).toEqual({ width: 800, height: 600 });
    expect(fitWithinCap({ width: 2560, height: 1440 }, 2560)).toEqual({ width: 2560, height: 1440 });
    expect(fitWithinCap({ width: 1, height: 1 }, 1920)).toEqual({ width: 1, height: 1 });
  });

  it('keeps the exact ratio for common camera sizes', () => {
    expect(fitWithinCap({ width: 6000, height: 4000 }, 2560)).toEqual({ width: 2560, height: 1707 });
    expect(fitWithinCap({ width: 4000, height: 6000 }, 1920)).toEqual({ width: 1280, height: 1920 });
    expect(fitWithinCap({ width: 4032, height: 3024 }, 3000)).toEqual({ width: 3000, height: 2250 });
  });
});

describe('fitToWidth', () => {
  it('scales proportionally and never upscales', () => {
    expect(fitToWidth({ width: 2560, height: 1707 }, 800)).toEqual({ width: 800, height: 533 });
    expect(fitToWidth({ width: 600, height: 400 }, 800)).toEqual({ width: 600, height: 400 });
  });
});
