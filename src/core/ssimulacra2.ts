import type { RGBAImage } from './types';

/*
 * SSIMULACRA 2.1, a perceptual image-quality metric by Jon Sneyers (Cloudinary).
 * Scores range from 100 (identical) downward: about 90 means visually lossless,
 * 80 very high quality, 70 high quality, 50 medium.
 *
 * TypeScript port of the Rust reference `ssimulacra2` crate v0.5.1
 * (https://github.com/rust-av/ssimulacra2, BSD-2-Clause, (c) the rust-av
 * developers), which itself ports libjxl's tools/ssimulacra2.cc. Colour
 * conversion follows the `yuvxyb` crate v0.4.2 (BSD-2-Clause). Validated
 * against the Rust implementation: see scripts/ssimulacra2-reference/ and
 * tests/ssimulacra2.test.ts.
 *
 * Planes are stored as Float32Array, like the reference's f32. Intermediate
 * arithmetic is f64 here, so scores differ from the reference only by
 * floating-point noise (well under 0.05 points in the fixture tests).
 */

const NUM_SCALES = 6;

// ---------------------------------------------------------------- sRGB → linear (yuvxyb)

const SRGB_ALPHA = 1.0550107;
const SRGB_BETA = 0.0030412825;

/** 8-bit sRGB code value → linear light, precomputed. */
const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    t[i] = x < 12.92 * SRGB_BETA ? x / 12.92 : Math.pow((x + (SRGB_ALPHA - 1)) / SRGB_ALPHA, 2.4);
  }
  return t;
})();

// ---------------------------------------------------------------- linear RGB → XYB (yuvxyb)

const K_M02 = 0.078, K_M00 = 0.3, K_M01 = 1 - K_M02 - K_M00;
const K_M12 = 0.078, K_M10 = 0.23, K_M11 = 1 - K_M12 - K_M10;
const K_M20 = 0.24342269, K_M21 = 0.20476745, K_M22 = 1 - K_M20 - K_M21;
const K_B = 0.0037930734;
const NEG_CBRT_B = -Math.cbrt(K_B);

type Planes = [Float32Array, Float32Array, Float32Array];

/**
 * Linear RGB → XYB, then SSIMULACRA2's "make positive" remap, which puts all
 * components in roughly 0..1: X' = 14·X + 0.42, Y' = Y + 0.01, B' = B − Y + 0.55.
 */
function toPositiveXyb(lin: Planes, n: number): Planes {
  const [r, g, b] = lin;
  const X = new Float32Array(n);
  const Y = new Float32Array(n);
  const B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const ri = r[i], gi = g[i], bi = b[i];
    let m0 = K_M00 * ri + K_M01 * gi + K_M02 * bi + K_B;
    let m1 = K_M10 * ri + K_M11 * gi + K_M12 * bi + K_B;
    let m2 = K_M20 * ri + K_M21 * gi + K_M22 * bi + K_B;
    m0 = Math.cbrt(m0 < 0 ? 0 : m0) + NEG_CBRT_B;
    m1 = Math.cbrt(m1 < 0 ? 0 : m1) + NEG_CBRT_B;
    m2 = Math.cbrt(m2 < 0 ? 0 : m2) + NEG_CBRT_B;
    const x = 0.5 * (m0 - m1);
    const y = 0.5 * (m0 + m1);
    X[i] = x * 14 + 0.42;
    Y[i] = y + 0.01;
    B[i] = m2 - y + 0.55;
  }
  return [X, Y, B];
}

// ---------------------------------------------------------------- recursive Gaussian (σ = 1.5)

/**
 * Constants of Charalampidis' "Recursive Implementation of the Gaussian Filter
 * Using Truncated Cosine Functions" (2016), derived exactly as the reference
 * crate's build.rs does. Equation numbers refer to the paper.
 */
const GAUSS = (() => {
  const SIGMA = 1.5;
  const radius = Math.round(3.2795 * SIGMA + 0.2546); // (57)
  const pi2r = Math.PI / (2 * radius);
  const omega = [pi2r, 3 * pi2r, 5 * pi2r];
  const p1 = 1 / Math.tan(0.5 * omega[0]);
  const p3 = -1 / Math.tan(0.5 * omega[1]);
  const p5 = 1 / Math.tan(0.5 * omega[2]);
  const r1 = (p1 * p1) / Math.sin(omega[0]);
  const r3 = (-p3 * p3) / Math.sin(omega[1]);
  const r5 = (p5 * p5) / Math.sin(omega[2]);
  const rho = omega.map((w) => Math.exp(-0.5 * SIGMA * SIGMA * w * w) / radius);
  const d13 = p1 * r3 - r1 * p3;
  const d35 = p3 * r5 - r3 * p5;
  const d51 = p5 * r1 - r5 * p1;
  const zeta15 = d35 / d13;
  const zeta35 = d51 / d13;
  // (56): A = inverse of [[p1 p3 p5] [r1 r3 r5] [zeta15 zeta35 1]]
  const m = [p1, p3, p5, r1, r3, r5, zeta15, zeta35, 1];
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const inv = [
    (m[4] * m[8] - m[5] * m[7]) / det, (m[2] * m[7] - m[1] * m[8]) / det, (m[1] * m[5] - m[2] * m[4]) / det,
    (m[5] * m[6] - m[3] * m[8]) / det, (m[0] * m[8] - m[2] * m[6]) / det, (m[2] * m[3] - m[0] * m[5]) / det,
    (m[3] * m[7] - m[4] * m[6]) / det, (m[1] * m[6] - m[0] * m[7]) / det, (m[0] * m[4] - m[1] * m[3]) / det,
  ];
  // (55), (53)
  const gamma = [1, radius * radius - SIGMA * SIGMA, zeta15 * rho[0] + zeta35 * rho[1] + rho[2]];
  const beta = [0, 1, 2].map((i) => inv[i * 3] * gamma[0] + inv[i * 3 + 1] * gamma[1] + inv[i * 3 + 2] * gamma[2]);
  if (Math.abs(beta[0] * p1 + beta[1] * p3 + beta[2] * p5 - 1) > 1e-12) throw new Error('ssimulacra2: bad Gaussian constants');
  // (33): out_k[n] = n2_k·(in[n−N−1] + in[n+N−1]) − d1_k·out_k[n−1] − out_k[n−2]
  const f = Math.fround;
  const n2 = [0, 1, 2].map((i) => f(-beta[i] * Math.cos(omega[i] * (radius + 1))));
  const d1 = [0, 1, 2].map((i) => f(-2 * Math.cos(omega[i])));
  return { radius, n2, d1 };
})();

/** Horizontal pass over every row, then vertical over every column (all columns advance together). */
function blurPlane(src: Float32Array, w: number, h: number, tmp: Float32Array, out: Float32Array) {
  const N = GAUSS.radius;
  const [a1, a3, a5] = GAUSS.n2;
  const [b1, b3, b5] = GAUSS.d1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let p1 = 0, p3 = 0, p5 = 0, q1 = 0, q3 = 0, q5 = 0; // prev, prev2
    for (let n = -N + 1; n < w; n++) {
      const left = n - N - 1;
      const right = n + N - 1;
      const sum = (left >= 0 ? src[row + left] : 0) + (right < w ? src[row + right] : 0);
      const o1 = sum * a1 - b1 * p1 - q1;
      const o3 = sum * a3 - b3 * p3 - q3;
      const o5 = sum * a5 - b5 * p5 - q5;
      q1 = p1; q3 = p3; q5 = p5;
      p1 = Math.fround(o1); p3 = Math.fround(o3); p5 = Math.fround(o5);
      if (n >= 0) tmp[row + n] = p1 + p3 + p5;
    }
  }

  const prev = new Float32Array(3 * w);
  const prev2 = new Float32Array(3 * w);
  for (let n = -N + 1; n < h; n++) {
    const top = n - N - 1;
    const bottom = n + N - 1;
    const topRow = top >= 0 ? top * w : -1;
    const bottomRow = bottom < h ? bottom * w : -1;
    for (let x = 0; x < w; x++) {
      const sum = (topRow >= 0 ? tmp[topRow + x] : 0) + (bottomRow >= 0 ? tmp[bottomRow + x] : 0);
      const i3 = x + w, i5 = x + 2 * w;
      const o1 = sum * a1 - (prev[x] * b1 + prev2[x]);
      const o3 = sum * a3 - (prev[i3] * b3 + prev2[i3]);
      const o5 = sum * a5 - (prev[i5] * b5 + prev2[i5]);
      prev2[x] = prev[x]; prev2[i3] = prev[i3]; prev2[i5] = prev[i5];
      prev[x] = o1; prev[i3] = o3; prev[i5] = o5;
      if (n >= 0) out[n * w + x] = prev[x] + prev[i3] + prev[i5];
    }
  }
}

// ---------------------------------------------------------------- scale loop

function downscaleBy2(p: Planes, w: number, h: number): { planes: Planes; w: number; h: number } {
  const ow = (w + 1) >> 1;
  const oh = (h + 1) >> 1;
  const out = [new Float32Array(ow * oh), new Float32Array(ow * oh), new Float32Array(ow * oh)] as Planes;
  for (let c = 0; c < 3; c++) {
    const s = p[c];
    const d = out[c];
    for (let oy = 0; oy < oh; oy++) {
      const y0 = 2 * oy * w;
      const y1 = Math.min(2 * oy + 1, h - 1) * w;
      for (let ox = 0; ox < ow; ox++) {
        const x0 = 2 * ox;
        const x1 = Math.min(2 * ox + 1, w - 1);
        d[oy * ow + ox] = (s[y0 + x0] + s[y0 + x1] + s[y1 + x0] + s[y1 + x1]) * 0.25;
      }
    }
  }
  return { planes: out, w: ow, h: oh };
}

/** Linear-light planes; images with transparency are composited over mid-grey first. */
function toLinearPlanes(img: RGBAImage): Planes {
  const n = img.width * img.height;
  const d = img.data;
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  const grey = SRGB_TO_LINEAR[128];
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = d[p + 3];
    if (a === 255) {
      r[i] = SRGB_TO_LINEAR[d[p]];
      g[i] = SRGB_TO_LINEAR[d[p + 1]];
      b[i] = SRGB_TO_LINEAR[d[p + 2]];
    } else {
      const t = a / 255;
      r[i] = SRGB_TO_LINEAR[d[p]] * t + grey * (1 - t);
      g[i] = SRGB_TO_LINEAR[d[p + 1]] * t + grey * (1 - t);
      b[i] = SRGB_TO_LINEAR[d[p + 2]] * t + grey * (1 - t);
    }
  }
  return [r, g, b];
}

/** Per-scale features: 3 channels × (SSIM 1-norm, 4-norm) and (artefact 1/4-norm, detail-lost 1/4-norm). */
interface ScaleFeatures {
  ssim: Float64Array; // [c*2 + norm]
  edge: Float64Array; // [c*4 + k]
}

function scaleFeatures(x1: Planes, x2: Planes, w: number, h: number): ScaleFeatures {
  const n = w * h;
  const tmp = new Float32Array(n);
  const prod = new Float32Array(n);
  const blur = (src: Float32Array) => {
    const out = new Float32Array(n);
    blurPlane(src, w, h, tmp, out);
    return out;
  };
  const ssim = new Float64Array(6);
  const edge = new Float64Array(12);
  const C2 = 0.0009;
  const inv = 1 / n;

  for (let c = 0; c < 3; c++) {
    const a = x1[c], b = x2[c];
    for (let i = 0; i < n; i++) prod[i] = a[i] * a[i];
    const s11 = blur(prod);
    for (let i = 0; i < n; i++) prod[i] = b[i] * b[i];
    const s22 = blur(prod);
    for (let i = 0; i < n; i++) prod[i] = a[i] * b[i];
    const s12 = blur(prod);
    const mu1 = blur(a);
    const mu2 = blur(b);

    let sum1 = 0, sum4 = 0;
    let art1 = 0, art4 = 0, det1 = 0, det4 = 0;
    for (let i = 0; i < n; i++) {
      const m1 = mu1[i], m2 = mu2[i];
      const md = m1 - m2;
      // SSIM without the luminance denominator (see the reference comments)
      const numM = 1 - md * md;
      const numS = 2 * (s12[i] - m1 * m2) + C2;
      const denS = s11[i] - m1 * m1 + (s22[i] - m2 * m2) + C2;
      let d = 1 - Math.fround((Math.fround(numM) * Math.fround(numS)) / Math.fround(denS));
      if (d < 0) d = 0;
      sum1 += d;
      const d2 = d * d;
      sum4 += d2 * d2;

      const e = (1 + Math.abs(b[i] - m2)) / (1 + Math.abs(a[i] - m1)) - 1;
      if (e > 0) {
        art1 += e;
        const e2 = e * e;
        art4 += e2 * e2;
      } else if (e < 0) {
        const l = -e;
        det1 += l;
        const l2 = l * l;
        det4 += l2 * l2;
      }
    }
    ssim[c * 2] = inv * sum1;
    ssim[c * 2 + 1] = Math.sqrt(Math.sqrt(inv * sum4));
    edge[c * 4] = inv * art1;
    edge[c * 4 + 1] = Math.sqrt(Math.sqrt(inv * art4));
    edge[c * 4 + 2] = inv * det1;
    edge[c * 4 + 3] = Math.sqrt(Math.sqrt(inv * det4));
  }
  return { ssim, edge };
}

// prettier-ignore
const WEIGHT = [
  0.0, 0.0007376606707406586, 0.0, 0.0, 0.0007793481682867309, 0.0, 0.0, 0.0004371155730107379, 0.0,
  1.1041726426657346, 0.00066284834129271, 0.00015231632783718752, 0.0, 0.0016406437456599754, 0.0,
  1.8422455520539298, 11.441172603757666, 0.0, 0.0007989109436015163, 0.000176816438078653, 0.0,
  1.8787594979546387, 10.94906990605142, 0.0, 0.0007289346991508072, 0.9677937080626833, 0.0,
  0.00014003424285435884, 0.9981766977854967, 0.00031949755934435053, 0.0004550992113792063, 0.0, 0.0,
  0.0013648766163243398, 0.0, 0.0, 0.0, 0.0, 0.0, 7.466890328078848, 0.0, 17.445833984131262,
  0.0006235601634041466, 0.0, 0.0, 6.683678146179332, 0.00037724407979611296, 1.027889937768264,
  225.20515300849274, 0.0, 0.0, 19.213238186143016, 0.0011401524586618361, 0.001237755635509985,
  176.39317598450694, 0.0, 0.0, 24.43300999870476, 0.28520802612117757, 0.0004485436923833408, 0.0,
  0.0, 0.0, 34.77906344483772, 44.835625328877896, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
  0.0008680556573291698, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0005313191874358747, 0.0, 0.00016533814161379112,
  0.0, 0.0, 0.0, 0.0, 0.0, 0.0004179171803251336, 0.0017290828234722833, 0.0, 0.0020827005846636437,
  0.0, 0.0, 8.826982764996862, 23.19243343998926, 0.0, 95.1080498811086, 0.9863978034400682,
  0.9834382792465353, 0.0012286405048278493, 171.2667255897307, 0.9807858872435379, 0.0, 0.0, 0.0,
  0.0005130064588990679, 0.0, 0.00010854057858411537,
];

function combine(scales: ScaleFeatures[]): number {
  let s = 0;
  let i = 0;
  for (let c = 0; c < 3; c++) {
    for (const sc of scales) {
      for (let n = 0; n < 2; n++) {
        s += WEIGHT[i++] * Math.abs(sc.ssim[c * 2 + n]);
        s += WEIGHT[i++] * Math.abs(sc.edge[c * 4 + n]);
        s += WEIGHT[i++] * Math.abs(sc.edge[c * 4 + n + 2]);
      }
    }
  }
  s *= 0.9562382616834844;
  s = 6.248496625763138e-5 * s * s * s + 2.326765642916932 * s - 0.020884521182843837 * s * s;
  return s > 0 ? 100 - 10 * Math.pow(s, 0.6276336467831387) : 100;
}

/**
 * SSIMULACRA 2.1 score of `distorted` against `source` (same size, at least
 * 8×8). 100 = identical; higher is better. Transparent pixels are composited
 * over mid-grey; score alpha separately if it matters.
 */
export function ssimulacra2(source: RGBAImage, distorted: RGBAImage): number {
  if (source.width !== distorted.width || source.height !== distorted.height) {
    throw new Error(`ssimulacra2: size mismatch ${source.width}×${source.height} vs ${distorted.width}×${distorted.height}`);
  }
  let w = source.width;
  let h = source.height;
  if (w < 8 || h < 8) throw new Error('ssimulacra2: images must be at least 8×8');

  let lin1 = toLinearPlanes(source);
  let lin2 = toLinearPlanes(distorted);
  const scales: ScaleFeatures[] = [];
  for (let scale = 0; scale < NUM_SCALES; scale++) {
    if (w < 8 || h < 8) break;
    if (scale > 0) {
      const d1 = downscaleBy2(lin1, w, h);
      const d2 = downscaleBy2(lin2, w, h);
      lin1 = d1.planes;
      lin2 = d2.planes;
      w = d1.w;
      h = d1.h;
    }
    scales.push(scaleFeatures(toPositiveXyb(lin1, w * h), toPositiveXyb(lin2, w * h), w, h));
  }
  return combine(scales);
}
