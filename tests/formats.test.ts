import { describe, expect, it } from 'vitest';
import { decideKeepOriginal } from '../src/core/decide';
import { planFormats } from '../src/core/formats';
import { DEFAULT_SETTINGS } from '../src/core/settings';
import type { Settings } from '../src/core/types';

const s = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...o });

describe('format rules', () => {
  it('JPEG / PNG / HEIC → AVIF and WebP', () => {
    for (const input of ['jpeg', 'png', 'heic'] as const) {
      const p = planFormats(input, s(), 'photo', false);
      expect(p.modern.sort()).toEqual(['avif', 'webp']);
      expect(p.fallback).toBeNull();
    }
  });

  it('WebP in → WebP out only', () => {
    expect(planFormats('webp', s(), 'photo', false)).toEqual({ modern: ['webp'], fallback: null });
    // even with the JPEG fallback toggle on
    expect(planFormats('webp', s({ fallback: true }), 'photo', false)).toEqual({ modern: ['webp'], fallback: null });
  });

  it('AVIF in → AVIF out only', () => {
    expect(planFormats('avif', s(), 'photo', false)).toEqual({ modern: ['avif'], fallback: null });
    expect(planFormats('avif', s({ fallback: true }), 'graphic', true)).toEqual({ modern: ['avif'], fallback: null });
  });

  it('"also create the other modern format" adds the other one, WebP first', () => {
    expect(planFormats('webp', s({ alsoOtherModern: true }), 'photo', false).modern).toEqual(['webp', 'avif']);
    expect(planFormats('avif', s({ alsoOtherModern: true }), 'photo', false).modern).toEqual(['webp', 'avif']);
  });

  it('fallback is JPEG for opaque photos, PNG for graphics or transparency', () => {
    expect(planFormats('jpeg', s({ fallback: true }), 'photo', false).fallback).toBe('jpeg');
    expect(planFormats('png', s({ fallback: true }), 'graphic', false).fallback).toBe('png');
    expect(planFormats('png', s({ fallback: true }), 'photo', true).fallback).toBe('png');
  });

  it('encodes WebP before AVIF so the WebP result can narrow the AVIF search', () => {
    expect(planFormats('jpeg', s(), 'photo', false).modern).toEqual(['webp', 'avif']);
  });
});

describe('never larger than input / generation-loss guard', () => {
  it('keeps the original when a same-format result is not smaller', () => {
    expect(decideKeepOriginal({ input: 'webp', output: 'webp', inputSize: 1000, candidateSize: 1000, resized: true }).keepOriginal).toBe(true);
    expect(decideKeepOriginal({ input: 'jpeg', output: 'jpeg', inputSize: 1000, candidateSize: 1200, resized: true }).keepOriginal).toBe(true);
    expect(decideKeepOriginal({ input: 'png', output: 'png', inputSize: 1000, candidateSize: 999, resized: false }).keepOriginal).toBe(false);
  });

  it('requires ≥5% gain for WebP/AVIF inputs already within the cap', () => {
    expect(decideKeepOriginal({ input: 'avif', output: 'avif', inputSize: 1000, candidateSize: 960, resized: false }).keepOriginal).toBe(true);
    expect(decideKeepOriginal({ input: 'avif', output: 'avif', inputSize: 1000, candidateSize: 950, resized: false }).keepOriginal).toBe(false);
    expect(decideKeepOriginal({ input: 'webp', output: 'webp', inputSize: 1000, candidateSize: 960, resized: true }).keepOriginal).toBe(false);
  });

  it('never keeps an original that is over the file-size limit', () => {
    expect(decideKeepOriginal({ input: 'webp', output: 'webp', inputSize: 60_000, candidateSize: 59_000, resized: false, maxBytes: 50_000 }).keepOriginal).toBe(false);
    expect(decideKeepOriginal({ input: 'webp', output: 'webp', inputSize: 40_000, candidateSize: 39_500, resized: false, maxBytes: 50_000 }).keepOriginal).toBe(true);
  });

  it('does not apply to cross-format outputs', () => {
    expect(decideKeepOriginal({ input: 'jpeg', output: 'avif', inputSize: 100, candidateSize: 5000, resized: false }).keepOriginal).toBe(false);
  });
});
