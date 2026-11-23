import { ssim } from 'ssim.js';
import type { ContentKind, RGBAImage } from './types';

/**
 * 'bezkrovny' is about 5× faster, so the quality search uses it. The quality
 * that is finally chosen is always re-checked with 'weber', ssim.js's default
 * and closest to Wang et al.
 */
export type SsimAlgo = 'bezkrovny' | 'weber';

export interface Score {
  /** Luma mssim: the number reported to the user. */
  luma: number;
  /** min(Cb, Cr) mssim; graphics only, where colour fringes are visible. */
  chroma?: number;
  /** Alpha-plane mssim, when the image has transparency. */
  alpha?: number;
}

/** Composites over mid-grey so RGB hidden under transparent pixels doesn't count. */
function composite(img: RGBAImage): RGBAImage {
  const d = img.data;
  const out = new Uint8ClampedArray(d.length);
  for (let p = 0; p < d.length; p += 4) {
    const a = d[p + 3] / 255;
    const bg = 128 * (1 - a);
    out[p] = d[p] * a + bg;
    out[p + 1] = d[p + 1] * a + bg;
    out[p + 2] = d[p + 2] * a + bg;
    out[p + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

/** Grey RGBA image of one derived plane (R=G=B=value), so ssim.js's rgb2gray returns it exactly. */
function plane(img: RGBAImage, which: 'cb' | 'cr' | 'alpha'): RGBAImage {
  const d = img.data;
  const out = new Uint8ClampedArray(d.length);
  for (let p = 0; p < d.length; p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    let v: number;
    if (which === 'alpha') v = d[p + 3];
    else if (which === 'cb') v = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    else v = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    out[p] = out[p + 1] = out[p + 2] = v;
    out[p + 3] = 255;
  }
  return { data: out, width: img.width, height: img.height };
}

/** Full-resolution mssim (downsampling off: we compare at the final output size). */
export function mssim(a: RGBAImage, b: RGBAImage, algo: SsimAlgo): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`SSIM size mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  // Tiny images: the 11×11 window needs at least that many pixels.
  if (a.width < 11 || a.height < 11) {
    let same = true;
    for (let i = 0; i < a.data.length && same; i++) same = Math.abs(a.data[i] - b.data[i]) <= 2;
    return same ? 1 : 0;
  }
  return ssim(a, b, { downsample: false, ssim: algo }).mssim;
}

export function scoreImages(
  ref: RGBAImage,
  test: RGBAImage,
  opts: { kind: ContentKind; hasAlpha: boolean; algo: SsimAlgo },
): Score {
  const r = opts.hasAlpha ? composite(ref) : ref;
  const t = opts.hasAlpha ? composite(test) : test;
  const score: Score = { luma: mssim(r, t, opts.algo) };
  if (opts.kind === 'graphic') {
    score.chroma = Math.min(
      mssim(plane(r, 'cb'), plane(t, 'cb'), opts.algo),
      mssim(plane(r, 'cr'), plane(t, 'cr'), opts.algo),
    );
  }
  if (opts.hasAlpha) score.alpha = mssim(plane(ref, 'alpha'), plane(test, 'alpha'), opts.algo);
  return score;
}

export function passes(score: Score, threshold: number): boolean {
  return (
    score.luma >= threshold &&
    (score.chroma === undefined || score.chroma >= threshold) &&
    (score.alpha === undefined || score.alpha >= threshold)
  );
}
