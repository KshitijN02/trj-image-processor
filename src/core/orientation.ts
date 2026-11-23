import type { RGBAImage } from './types';

/** Reads the Orientation tag (0x0112) from a TIFF/EXIF payload (starting at "II"/"MM"). */
export function tiffOrientation(t: Uint8Array): number {
  if (t.length < 8) return 1;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return 1;
  const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
  const u32 = (o: number) =>
    le
      ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0
      : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** Finds the EXIF APP1 TIFF payload of a JPEG, if any. */
export function jpegExifPayload(b: Uint8Array): Uint8Array | null {
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff) {
    const marker = b[o + 1];
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[o + 2] << 8) | b[o + 3];
    if (
      marker === 0xe1 &&
      len >= 8 &&
      b[o + 4] === 0x45 && // E
      b[o + 5] === 0x78 && // x
      b[o + 6] === 0x69 && // i
      b[o + 7] === 0x66 && // f
      b[o + 8] === 0 &&
      b[o + 9] === 0
    ) {
      return b.subarray(o + 10, o + 2 + len);
    }
    o += 2 + len;
  }
  return null;
}

export function jpegOrientation(b: Uint8Array): number {
  const exif = jpegExifPayload(b);
  return exif ? tiffOrientation(exif) : 1;
}

/** Minimal big-endian TIFF block containing only the Orientation tag (26 bytes). */
export function minimalOrientationTiff(orientation: number): Uint8Array {
  return new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
    0x00, orientation & 0xff, 0x00, 0x00, // value
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
}

/**
 * Applies an EXIF orientation to raw pixels so the result is upright.
 * Orientations 5–8 swap width and height.
 */
export function applyOrientation(img: RGBAImage, orientation: number): RGBAImage {
  if (orientation <= 1 || orientation > 8) return img;
  const { width: w, height: h, data: src } = img;
  const swap = orientation >= 5;
  const W = swap ? h : w;
  const H = swap ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h);
  const d32 = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        default: sx = w - 1 - y; sy = x; break; // 8
      }
      d32[y * W + x] = s32[sy * w + sx];
    }
  }
  return { data: out, width: W, height: H };
}
