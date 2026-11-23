import type { ContentKind, RGBAImage } from './types';

export interface ClassifyStats {
  uniqueColors: number;
  /** Share of sampled pixels covered by the 32 most common exact colours. */
  topCoverage: number;
  /** Share of sampled pixels identical to their right-hand neighbour. */
  flatRatio: number;
  sampled: number;
}

/**
 * Samples at most about 512×512 pixels on a regular grid and gathers colour
 * statistics. Photos have thousands of distinct colours spread evenly.
 * Graphics (logos, maps, screenshots, text) are dominated by a few exact
 * colours over large flat areas.
 */
export function colorStats(img: RGBAImage): ClassifyStats {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 512));
  const counts = new Map<number, number>();
  let sampled = 0;
  let flat = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const p = (y * w + x) * 4;
      // Ignore colour under fully transparent pixels.
      const key = data[p + 3] === 0 ? -1 : (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      sampled++;
      if (x + 1 < w) {
        const q = p + 4;
        if (data[p] === data[q] && data[p + 1] === data[q + 1] && data[p + 2] === data[q + 2] && data[p + 3] === data[q + 3]) flat++;
      }
    }
  }
  const top = [...counts.values()].sort((a, b) => b - a).slice(0, 32);
  const topCoverage = top.reduce((a, b) => a + b, 0) / sampled;
  return { uniqueColors: counts.size, topCoverage, flatRatio: flat / sampled, sampled };
}

export function classify(img: RGBAImage): { kind: ContentKind; stats: ClassifyStats } {
  const stats = colorStats(img);
  const graphic =
    stats.uniqueColors <= 512 ||
    stats.topCoverage >= 0.6 ||
    (stats.topCoverage >= 0.35 && stats.flatRatio >= 0.5);
  return { kind: graphic ? 'graphic' : 'photo', stats };
}
