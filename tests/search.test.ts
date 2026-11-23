import { describe, expect, it } from 'vitest';
import { avifWindowFromWebp, highestFitting, lowestPassing, memoize, refineDown, windowedSearch } from '../src/core/search';

/** Fake encoder: SSIM rises linearly with quality. */
const fake = (passFrom: number) => memoize(async (q: number) => ({ quality: q, pass: q >= passFrom, value: q }));

describe('lowestPassing', () => {
  it('finds the exact lowest passing quality', async () => {
    for (let t = 35; t <= 80; t++) {
      const r = await lowestPassing(35, 80, fake(t));
      expect(r.met).toBe(true);
      expect(r.best.quality).toBe(t);
      expect(r.evaluations).toBeLessThanOrEqual(7);
    }
  });

  it('returns the top of the range with met=false when nothing passes', async () => {
    const r = await lowestPassing(60, 92, fake(100));
    expect(r.met).toBe(false);
    expect(r.best.quality).toBe(92);
  });
});

describe('windowedSearch', () => {
  it('matches a full search wherever the answer is', async () => {
    const full = { lo: 35, hi: 80 };
    for (const t of [35, 40, 50, 57, 66, 80, 81]) {
      for (const center of [40, 55, 70]) {
        const r = await windowedSearch(full, { lo: center - 8, hi: center + 8 }, fake(t));
        const ref = await lowestPassing(35, 80, fake(t));
        expect(r.best.quality).toBe(ref.best.quality);
        expect(r.met).toBe(ref.met);
      }
    }
  });

  it('uses fewer encodes than a full search when the guess is close', async () => {
    const ev = fake(55);
    await windowedSearch({ lo: 35, hi: 80 }, avifWindowFromWebp(74), ev);
    expect(ev.calls()).toBeLessThanOrEqual(5);
  });
});

describe('avifWindowFromWebp', () => {
  it('maps the WebP range onto the AVIF range, clamped', () => {
    expect(avifWindowFromWebp(60)).toEqual({ lo: 35, hi: 43 });
    expect(avifWindowFromWebp(92)).toEqual({ lo: 72, hi: 80 });
    const mid = avifWindowFromWebp(76);
    expect(mid.lo).toBeGreaterThan(35);
    expect(mid.hi).toBeLessThan(80);
  });
});

describe('highestFitting (size-cap mode)', () => {
  const sizes = (q: number) => Promise.resolve(q * 1000); // size grows with quality
  it('returns the highest quality under the byte limit', async () => {
    expect(await highestFitting(20, 92, 50_000, sizes)).toBe(50);
    expect(await highestFitting(20, 92, 50_999, sizes)).toBe(50);
    expect(await highestFitting(20, 92, 1_000_000, sizes)).toBe(92);
  });
  it('returns null when even the floor is too big', async () => {
    expect(await highestFitting(20, 92, 19_999, sizes)).toBeNull();
  });
});

describe('refineDown (full-image walk-down after the search)', () => {
  /** Passes for q >= t; records which qualities were probed. */
  const probe = (t: number) => {
    const calls: number[] = [];
    const fn = async (q: number) => (calls.push(q), q >= t);
    return { fn, calls };
  };

  it('recovers an overshoot of 1, 2, 3 or 4 points', async () => {
    for (const [t, expected] of [[86, 86], [85, 85], [84, 84], [83, 83]] as const) {
      expect(await refineDown(87, 60, false, probe(t).fn)).toBe(expected);
    }
  });

  it('stays put when the search was exact, using at most 2 probes', async () => {
    const p = probe(87);
    expect(await refineDown(87, 60, false, p.fn)).toBe(87);
    expect(p.calls).toEqual([85, 86]);
  });

  it('never probes more than 3 qualities', async () => {
    const p = probe(0); // everything passes
    expect(await refineDown(87, 60, false, p.fn)).toBe(83);
    expect(p.calls.length).toBe(3);
  });

  it('respects the bottom of the range', async () => {
    expect(await refineDown(61, 60, false, probe(0).fn)).toBe(60);
    expect(await refineDown(60, 60, false, probe(0).fn)).toBe(60);
  });

  it('only tries q−1 after the verification had to step up', async () => {
    const p = probe(0);
    expect(await refineDown(80, 35, true, p.fn)).toBe(79);
    expect(p.calls).toEqual([79]);
  });
});
