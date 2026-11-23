import type { RGBAImage } from './types';

/** Above this many pixels the quality search runs on a proxy mosaic, not the full image. */
export const PROXY_MIN_PIXELS = 1_500_000;
const TILE = 384;
const TILES = 8;

/**
 * Builds a small mosaic of full-resolution tiles that stands in for the image
 * during the quality search. Tiles are taken at stratified quantiles of local
 * detail (gradient energy), so smooth areas (banding, blocking) and busy areas
 * (ringing, blur) are represented in about the proportions the image has.
 * The mosaic's SSIM then tracks full-image SSIM closely. The chosen quality
 * is always re-verified on the full image afterwards.
 *
 * Returns null for images small enough to search directly.
 */
export function buildProxy(img: RGBAImage): RGBAImage | null {
  const { width: w, height: h, data } = img;
  if (w * h <= PROXY_MIN_PIXELS) return null;
  const cols = Math.floor(w / TILE);
  const rows = Math.floor(h / TILE);
  if (cols * rows < 2) return null;

  // Detail score per cell: mean |dx| + |dy| of green, sampled every 2 px.
  const cells: { x: number; y: number; detail: number }[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * TILE + Math.floor((w - cols * TILE) / 2);
      const y0 = cy * TILE + Math.floor((h - rows * TILE) / 2);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y0 + TILE - 1; y += 2) {
        for (let x = x0; x < x0 + TILE - 1; x += 2) {
          const p = (y * w + x) * 4 + 1;
          sum += Math.abs(data[p] - data[p + 4]) + Math.abs(data[p] - data[p + w * 4]);
          n++;
        }
      }
      cells.push({ x: x0, y: y0, detail: sum / n });
    }
  }
  cells.sort((a, b) => a.detail - b.detail);
  const count = Math.min(TILES, cells.length);
  const picked = Array.from({ length: count }, (_, i) => cells[Math.floor(((i + 0.5) / count) * cells.length)]);

  const mcols = Math.min(4, count);
  const mrows = Math.ceil(count / mcols);
  const MW = mcols * TILE;
  const MH = mrows * TILE;
  const out = new Uint8ClampedArray(MW * MH * 4);
  for (let t = 0; t < mcols * mrows; t++) {
    const cell = picked[Math.min(t, count - 1)];
    const ox = (t % mcols) * TILE;
    const oy = Math.floor(t / mcols) * TILE;
    for (let y = 0; y < TILE; y++) {
      const srcStart = ((cell.y + y) * w + cell.x) * 4;
      out.set(data.subarray(srcStart, srcStart + TILE * 4), ((oy + y) * MW + ox) * 4);
    }
  }
  return { data: out, width: MW, height: MH };
}
