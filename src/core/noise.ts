import type { RGBAImage } from './types';

function luma(img: RGBAImage): Float32Array {
  const { data, width, height } = img;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return out;
}

/**
 * Immerkær's fast noise-variance estimate ("Fast Noise Variance Estimation",
 * 1996), on luma:
 *
 *   sigma = sqrt(pi/2) / (6 (W-2)(H-2)) * sum |I * N|,  N = [1 -2 1; -2 4 -2; 1 -2 1]
 *
 * Plain Immerkær mistakes edges and texture for noise. So the strongest 10 %
 * of Sobel gradients are excluded, which is the edge-aware variant of
 * Tai & Yang (2008). Returns sigma on the 0–255 scale.
 */
export function estimateNoise(img: RGBAImage): number {
  const { width: w, height: h } = img;
  if (w < 8 || h < 8) return 0;
  const L = luma(img);
  const n = (w - 2) * (h - 2);
  const lap = new Float32Array(n);
  const grad = new Float32Array(n);
  const HIST = 2048;
  const hist = new Uint32Array(HIST);
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++, k++) {
      const i = y * w + x;
      const a = L[i - w - 1], b = L[i - w], c = L[i - w + 1];
      const d = L[i - 1], e = L[i], f = L[i + 1];
      const g = L[i + w - 1], hh = L[i + w], j = L[i + w + 1];
      lap[k] = Math.abs(a - 2 * b + c - 2 * d + 4 * e - 2 * f + g - 2 * hh + j);
      const gx = c + 2 * f + j - a - 2 * d - g;
      const gy = g + 2 * hh + j - a - 2 * b - c;
      const gm = Math.abs(gx) + Math.abs(gy);
      grad[k] = gm;
      hist[Math.min(HIST - 1, gm | 0)]++;
    }
  }
  // Gradient value below which 90 % of pixels fall.
  let cutoff = HIST - 1;
  for (let acc = 0, v = 0; v < HIST; v++) {
    acc += hist[v];
    if (acc >= 0.9 * n) {
      cutoff = v + 1;
      break;
    }
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (grad[i] <= cutoff) {
      sum += lap[i];
      count++;
    }
  }
  if (count === 0) return 0;
  return (Math.sqrt(Math.PI / 2) * sum) / (6 * count);
}

/**
 * Light, edge-preserving 3×3 bilateral filter. The range kernel scales with
 * the measured noise, so differences much larger than the noise (edges, fabric
 * weave, wood grain, stone) are left alone. The result is blended 80/20 with
 * the input so a little natural grain remains. Alpha is untouched.
 */
export function bilateralDenoise(img: RGBAImage, sigma: number): RGBAImage {
  const { width: w, height: h, data: src } = img;
  const sigmaR = Math.min(18, Math.max(3, 2 * sigma));
  const strength = 0.8;
  // Range weights indexed by mean squared channel difference (0..65025).
  const MAXD = 65026;
  const range = new Float32Array(MAXD);
  for (let d = 0; d < MAXD; d++) range[d] = Math.exp(-d / (2 * sigmaR * sigmaR));
  const spatial = [Math.exp(-1), Math.exp(-0.5), Math.exp(-1), Math.exp(-0.5), 1, Math.exp(-0.5), Math.exp(-1), Math.exp(-0.5), Math.exp(-1)];
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r0 = src[p], g0 = src[p + 1], b0 = src[p + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++, s++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const q = (yy * w + xx) * 4;
          const r = src[q], g = src[q + 1], b = src[q + 2];
          const d = ((r - r0) * (r - r0) + (g - g0) * (g - g0) + (b - b0) * (b - b0)) / 3;
          const wt = spatial[s] * range[d | 0];
          sr += r * wt;
          sg += g * wt;
          sb += b * wt;
          sw += wt;
        }
      }
      out[p] = r0 + strength * (sr / sw - r0);
      out[p + 1] = g0 + strength * (sg / sw - g0);
      out[p + 2] = b0 + strength * (sb / sw - b0);
      out[p + 3] = src[p + 3];
    }
  }
  return { data: out, width: w, height: h };
}
