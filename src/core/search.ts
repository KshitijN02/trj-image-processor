import { QUALITY_RANGES } from './settings';

export interface Trial<T> {
  quality: number;
  pass: boolean;
  value: T;
}

export interface SearchResult<T> {
  /** Lowest passing trial, or the highest tried quality if none passed. */
  best: Trial<T>;
  met: boolean;
  evaluations: number;
}

export type Evaluate<T> = (quality: number) => Promise<Trial<T>>;

/** Memoises an evaluator so overlapping searches never re-encode a quality. */
export function memoize<T>(evaluate: Evaluate<T>): Evaluate<T> & { calls: () => number } {
  const cache = new Map<number, Promise<Trial<T>>>();
  const fn = ((q: number) => {
    let p = cache.get(q);
    if (!p) {
      p = evaluate(q);
      cache.set(q, p);
    }
    return p;
  }) as Evaluate<T> & { calls: () => number };
  fn.calls = () => cache.size;
  return fn;
}

/**
 * Binary search for the lowest integer quality in [lo, hi] that passes,
 * assuming quality and fidelity rise together. If nothing passes, the trial
 * at `hi` comes back with met=false.
 */
export async function lowestPassing<T>(lo: number, hi: number, evaluate: Evaluate<T>): Promise<SearchResult<T>> {
  let evaluations = 0;
  let best: Trial<T> | null = null;
  let a = lo;
  let b = hi;
  while (a <= b) {
    const mid = (a + b) >> 1;
    const t = await evaluate(mid);
    evaluations++;
    if (t.pass) {
      best = t;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  if (best) return { best, met: true, evaluations };
  const top = await evaluate(hi);
  return { best: top, met: top.pass, evaluations: evaluations + 1 };
}

/**
 * Searches a narrow window first, then widens toward the full range only if
 * the answer sits on the window's edge.
 */
export async function windowedSearch<T>(
  full: { lo: number; hi: number },
  window: { lo: number; hi: number },
  evaluate: Evaluate<T>,
): Promise<SearchResult<T>> {
  const wlo = Math.max(full.lo, window.lo);
  const whi = Math.min(full.hi, window.hi);
  const first = await lowestPassing(wlo, whi, evaluate);
  let evaluations = first.evaluations;
  if (first.met && first.best.quality === wlo && wlo > full.lo) {
    // The lowest passing value may be even lower.
    const below = await lowestPassing(full.lo, wlo - 1, evaluate);
    evaluations += below.evaluations;
    return below.met ? { ...below, evaluations } : { ...first, evaluations };
  }
  if (!first.met && whi < full.hi) {
    const above = await lowestPassing(whi + 1, full.hi, evaluate);
    return { ...above, evaluations: evaluations + above.evaluations };
  }
  return { ...first, evaluations };
}

/**
 * Predicts the AVIF quality from the WebP result. At equal SSIM, libavif
 * qualities sit lower than libwebp ones, and the two ranges map roughly
 * linearly. Returns a ±8 window, clamped to the AVIF range.
 */
export function avifWindowFromWebp(webpQuality: number): { lo: number; hi: number } {
  const w = QUALITY_RANGES.webp;
  const a = QUALITY_RANGES.avif;
  const t = (webpQuality - w.lo) / (w.hi - w.lo);
  const guess = Math.round(a.lo + Math.min(1, Math.max(0, t)) * (a.hi - a.lo));
  return { lo: Math.max(a.lo, guess - 8), hi: Math.min(a.hi, guess + 8) };
}

/**
 * Highest integer quality in [lo, hi] whose encoded size fits `maxBytes`,
 * assuming size grows with quality. Returns null if even `lo` is too big
 * (in which case the caller has to shrink the image instead).
 */
export async function highestFitting(
  lo: number,
  hi: number,
  maxBytes: number,
  sizeAt: (quality: number) => Promise<number>,
): Promise<number | null> {
  if ((await sizeAt(lo)) > maxBytes) return null;
  let best = lo;
  let a = lo + 1;
  let b = hi;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if ((await sizeAt(mid)) <= maxBytes) {
      best = mid;
      a = mid + 1;
    } else {
      b = mid - 1;
    }
  }
  return best;
}

/**
 * Downward refinement on the full image, after a quality `q` has passed the
 * full-size check. The proxy search tends to land 1–3 points high, so:
 * - try q−2; if it passes, keep going down 1 at a time (at most 2 more steps);
 * - if q−2 fails, try q−1.
 * If the full-size check had to step *up* to reach q, the answer is already
 * at the edge, so only q−1 is tried. Never goes below `lo`. At most 3 probes.
 */
export async function refineDown(
  q: number,
  lo: number,
  steppedUp: boolean,
  passesAt: (quality: number) => Promise<boolean>,
): Promise<number> {
  if (steppedUp) return q - 1 >= lo && (await passesAt(q - 1)) ? q - 1 : q;
  if (q - 2 >= lo && (await passesAt(q - 2))) {
    let best = q - 2;
    for (let c = q - 3; c >= lo && c >= q - 4; c--) {
      if (!(await passesAt(c))) break;
      best = c;
    }
    return best;
  }
  return q - 1 >= lo && (await passesAt(q - 1)) ? q - 1 : q;
}
