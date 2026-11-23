import type { RGBAImage } from './types';

/**
 * Median-cut palette reduction (RGBA, no dithering). Used only for graphics,
 * and the result must pass the same SSIM check as any lossy candidate.
 * Returns null if the image already has `maxColors` or fewer colours, because
 * oxipng then builds a lossless palette by itself.
 */
export function quantize(img: RGBAImage, maxColors = 256): { image: RGBAImage; colors: number } | null {
  const src = new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
  const hist = new Map<number, number>();
  for (let i = 0; i < src.length; i++) hist.set(src[i], (hist.get(src[i]) ?? 0) + 1);
  if (hist.size <= maxColors) return null;

  const colors = new Uint32Array(hist.size);
  const weights = new Float64Array(hist.size);
  let n = 0;
  for (const [c, w] of hist) {
    colors[n] = c;
    weights[n++] = w;
  }
  // Byte order in memory is R,G,B,A, so read channels from the uint32 view.
  const ch = (c: number, k: number) => (c >>> (k * 8)) & 0xff;

  interface Box { start: number; end: number; weight: number; spread: number; channel: number }
  const order = new Uint32Array(n).map((_, i) => i);
  const measure = (start: number, end: number): Box => {
    const lo = [255, 255, 255, 255];
    const hi = [0, 0, 0, 0];
    let weight = 0;
    for (let i = start; i < end; i++) {
      const c = colors[order[i]];
      weight += weights[order[i]];
      for (let k = 0; k < 4; k++) {
        const v = ch(c, k);
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    let channel = 0;
    let spread = -1;
    for (let k = 0; k < 4; k++) {
      if (hi[k] - lo[k] > spread) {
        spread = hi[k] - lo[k];
        channel = k;
      }
    }
    return { start, end, weight, spread, channel };
  };

  const boxes: Box[] = [measure(0, n)];
  while (boxes.length < maxColors) {
    // Split the box with the largest weighted spread.
    let bi = -1;
    let best = 0;
    boxes.forEach((b, i) => {
      const score = b.spread * Math.sqrt(b.weight);
      if (b.end - b.start > 1 && score > best) {
        best = score;
        bi = i;
      }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    const slice = Array.from(order.subarray(b.start, b.end)).sort(
      (x, y) => ch(colors[x], b.channel) - ch(colors[y], b.channel),
    );
    order.set(slice, b.start);
    let acc = 0;
    let mid = b.start + 1;
    for (let i = b.start; i < b.end - 1; i++) {
      acc += weights[order[i]];
      if (acc >= b.weight / 2) {
        mid = i + 1;
        break;
      }
    }
    boxes.splice(bi, 1, measure(b.start, mid), measure(mid, b.end));
  }

  const map = new Map<number, number>();
  for (const b of boxes) {
    const sum = [0, 0, 0, 0];
    for (let i = b.start; i < b.end; i++) {
      const c = colors[order[i]];
      const w = weights[order[i]];
      for (let k = 0; k < 4; k++) sum[k] += ch(c, k) * w;
    }
    const avg = sum.map((s) => Math.round(s / b.weight));
    const packed = ((avg[3] << 24) | (avg[2] << 16) | (avg[1] << 8) | avg[0]) >>> 0;
    for (let i = b.start; i < b.end; i++) map.set(colors[order[i]], packed);
  }

  const out = new Uint8ClampedArray(img.data.length);
  const out32 = new Uint32Array(out.buffer);
  for (let i = 0; i < src.length; i++) out32[i] = map.get(src[i])!;
  return { image: { data: out, width: img.width, height: img.height }, colors: boxes.length };
}
