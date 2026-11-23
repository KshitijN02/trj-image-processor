import type { InputFormat } from './types';

/*
 * Byte-level sniffing: format detection, dimensions and animation detection.
 * These run on the main thread before a job is scheduled, so they never
 * decode pixels.
 */

const ascii = (b: Uint8Array, off: number, len: number) =>
  String.fromCharCode(...b.subarray(off, off + len));

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32be = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** Returns the ftyp major + compatible brands of an ISOBMFF file, or null. */
export function ftypBrands(b: Uint8Array): string[] | null {
  if (b.length < 16 || ascii(b, 4, 4) !== 'ftyp') return null;
  const size = Math.min(u32be(b, 0), b.length);
  const brands = [ascii(b, 8, 4)];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(ascii(b, o, 4));
  return brands;
}

export function detectFormat(b: Uint8Array): InputFormat | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  const brands = ftypBrands(b);
  if (brands) {
    const [major, ...compat] = brands;
    if (AVIF_BRANDS.has(major)) return 'avif';
    if (HEIC_BRANDS.has(major)) return 'heic';
    // Generic major brands such as mif1/msf1: decide by compatible brands.
    if (compat.some((x) => AVIF_BRANDS.has(x))) return 'avif';
    if (compat.some((x) => HEIC_BRANDS.has(x)) || major === 'mif1' || major === 'msf1') return 'heic';
  }
  return null;
}

/** Walks ISOBMFF boxes and returns the largest `ispe` (image spatial extents) found. */
function isobmffDimensions(b: Uint8Array): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  const containers = new Set(['meta', 'iprp', 'ipco']);
  const walk = (start: number, end: number) => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32be(b, o);
      const type = ascii(b, o + 4, 4);
      let header = 8;
      if (size === 1 && o + 16 <= end) {
        size = Number((BigInt(u32be(b, o + 8)) << 32n) | BigInt(u32be(b, o + 12)));
        header = 16;
      } else if (size === 0) {
        size = end - o;
      }
      if (size < header || o + size > end) break;
      if (type === 'ispe' && size >= 20) {
        const width = u32be(b, o + 12);
        const height = u32be(b, o + 16);
        if (!best || width * height > best.width * best.height) best = { width, height };
      } else if (containers.has(type)) {
        // `meta` is a FullBox: 4 bytes of version/flags before its children.
        walk(o + header + (type === 'meta' ? 4 : 0), o + size);
      }
      o += size;
    }
  };
  walk(0, b.length);
  return best;
}

function jpegDimensions(b: Uint8Array): { width: number; height: number } | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    const len = u16be(b, o + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
    if (marker === 0xda) return null;
    o += 2 + len;
  }
  return null;
}

function webpDimensions(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  if (chunk === 'VP8L') {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  return null;
}

export function readDimensions(
  b: Uint8Array,
  format: InputFormat,
): { width: number; height: number } | null {
  switch (format) {
    case 'jpeg':
      return jpegDimensions(b);
    case 'png':
      return b.length >= 24 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
    case 'gif':
      return { width: u16le(b, 6), height: u16le(b, 8) };
    case 'webp':
      return webpDimensions(b);
    case 'avif':
    case 'heic':
      return isobmffDimensions(b);
  }
}

function gifFrameCount(b: Uint8Array, stopAfter = 2): number {
  let o = 13;
  if (b[10] & 0x80) o += 3 * (1 << ((b[10] & 0x07) + 1));
  let frames = 0;
  const skipSubBlocks = () => {
    while (o < b.length && b[o] !== 0) o += b[o] + 1;
    o++;
  };
  while (o < b.length) {
    const block = b[o];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      o += 2; // introducer + label
      skipSubBlocks();
    } else if (block === 0x2c) {
      frames++;
      if (frames >= stopAfter) return frames;
      const packed = b[o + 9];
      o += 10;
      if (packed & 0x80) o += 3 * (1 << ((packed & 0x07) + 1));
      o++; // LZW minimum code size
      skipSubBlocks();
    } else {
      break; // malformed
    }
  }
  return frames;
}

function pngIsAnimated(b: Uint8Array): boolean {
  let o = 8;
  while (o + 8 <= b.length) {
    const len = u32be(b, o);
    const type = ascii(b, o + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    o += 12 + len;
  }
  return false;
}

/** True for animated GIF, APNG, animated WebP and AVIF image sequences. */
export function isAnimated(b: Uint8Array, format: InputFormat): boolean {
  switch (format) {
    case 'gif':
      return gifFrameCount(b) > 1;
    case 'png':
      return pngIsAnimated(b);
    case 'webp':
      return ascii(b, 12, 4) === 'VP8X' && (b[20] & 0x02) !== 0;
    case 'avif':
      return ftypBrands(b)?.[0] === 'avis';
    default:
      return false;
  }
}
