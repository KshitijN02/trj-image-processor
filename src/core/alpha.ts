import type { RGBAImage } from './types';

export function isFullyOpaque(img: RGBAImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return false;
  return true;
}

/** Forces alpha to 255, e.g. after a resampler left 254s on an opaque image. */
export function forceOpaque(img: RGBAImage): RGBAImage {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return img;
}
