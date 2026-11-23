import { jpegOrientation, minimalOrientationTiff, tiffOrientation } from './orientation';
import type { InputFormat } from './types';

/*
 * Lossless metadata stripping, used when the original bytes are kept.
 * Removed: EXIF (camera, GPS, embedded thumbnails), XMP, IPTC, comments, text chunks.
 * Kept: pixel data, ICC colour profile (dropping it would shift colours) and, if
 * not upright, a minimal EXIF holding only the Orientation tag so the image
 * still displays correctly.
 * Re-encoded outputs never carry metadata: the jsquash encoders write none.
 */

const enc = new TextEncoder();
const ascii = (b: Uint8Array, off: number, len: number) =>
  String.fromCharCode(...b.subarray(off, off + len));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- JPEG

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return concat([new Uint8Array([0xff, marker, len >> 8, len & 0xff]), payload]);
}

export function stripJpeg(b: Uint8Array): Uint8Array {
  const orientation = jpegOrientation(b);
  const parts: Uint8Array[] = [b.subarray(0, 2)]; // SOI
  let insertedOrientation = orientation === 1;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) throw new Error('Malformed JPEG');
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++;
      continue;
    }
    if (marker === 0xd9) {
      parts.push(b.subarray(o, o + 2));
      return concat(parts); // anything after EOI (e.g. MPF images, trailers) is dropped
    }
    const len = (b[o + 2] << 8) | b[o + 3];
    const seg = b.subarray(o, o + 2 + len);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    let keep = !isApp && marker !== 0xfe; // drop COM
    if (marker === 0xe0) keep = ascii(b, o + 4, 4) === 'JFIF';
    if (marker === 0xe2) keep = ascii(b, o + 4, 11) === 'ICC_PROFILE';
    if (marker === 0xee) keep = ascii(b, o + 4, 5) === 'Adobe'; // needed for colour transform
    if (!insertedOrientation && !(marker === 0xe0 && keep)) {
      const exif = concat([enc.encode('Exif\0\0'), minimalOrientationTiff(orientation)]);
      parts.push(jpegSegment(0xe1, exif));
      insertedOrientation = true;
    }
    if (keep) parts.push(seg);
    o += 2 + len;
    if (marker === 0xda) {
      // Copy entropy-coded data up to the next real marker.
      const start = o;
      while (o + 1 < b.length) {
        if (b[o] === 0xff) {
          const n = b[o + 1];
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        o++;
      }
      parts.push(b.subarray(start, o));
    }
  }
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(parts);
}

// ---------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(enc.encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Chunks that affect how pixels are decoded or displayed. Everything else goes. */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP', 'sBIT',
  'acTL', 'fcTL', 'fdAT',
]);

export function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8;
  while (o + 12 <= b.length) {
    const len = dv.getUint32(o);
    const type = ascii(b, o + 4, 4);
    const chunk = b.subarray(o, o + 12 + len);
    if (PNG_KEEP.has(type)) parts.push(chunk);
    else if (type === 'eXIf') {
      const orientation = tiffOrientation(b.subarray(o + 8, o + 8 + len));
      if (orientation !== 1) parts.push(pngChunk('eXIf', minimalOrientationTiff(orientation)));
    }
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return concat(parts);
}

// ---------------------------------------------------------------- WebP

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const out = new Uint8Array(8 + data.length + pad);
  out.set(enc.encode(fourcc), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

export function stripWebp(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const chunks: { fourcc: string; data: Uint8Array }[] = [];
  let o = 12;
  while (o + 8 <= b.length) {
    const fourcc = ascii(b, o, 4);
    const size = dv.getUint32(o + 4, true);
    chunks.push({ fourcc, data: b.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  const exif = chunks.find((c) => c.fourcc === 'EXIF');
  const hasXmp = chunks.some((c) => c.fourcc === 'XMP ');
  if (!exif && !hasXmp) return b;
  const orientation = exif ? tiffOrientation(exif.data) : 1;
  const out: Uint8Array[] = [];
  for (const c of chunks) {
    if (c.fourcc === 'XMP ') continue;
    if (c.fourcc === 'EXIF') {
      if (orientation !== 1) out.push(riffChunk('EXIF', minimalOrientationTiff(orientation)));
      continue;
    }
    if (c.fourcc === 'VP8X') {
      const vp8x = c.data.slice();
      vp8x[0] &= ~0x04; // XMP flag
      if (orientation === 1) vp8x[0] &= ~0x08; // EXIF flag
      out.push(riffChunk('VP8X', vp8x));
      continue;
    }
    out.push(riffChunk(c.fourcc, c.data));
  }
  const body = concat(out);
  const header = new Uint8Array(12);
  header.set(enc.encode('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(enc.encode('WEBP'), 8);
  return concat([header, body]);
}

/**
 * Strips metadata losslessly where supported. AVIF/HEIC are returned
 * unchanged, because rewriting ISOBMFF item locations is not supported (yet).
 */
export function stripMetadata(b: Uint8Array, format: InputFormat): { bytes: Uint8Array; stripped: boolean } {
  try {
    if (format === 'jpeg') return { bytes: stripJpeg(b), stripped: true };
    if (format === 'png') return { bytes: stripPng(b), stripped: true };
    if (format === 'webp') return { bytes: stripWebp(b), stripped: true };
  } catch {
    // fall through and keep the original bytes untouched
  }
  return { bytes: b, stripped: false };
}

/**
 * Structural metadata inventory (used for reporting and tests). Returns e.g.
 * ['exif', 'gps', 'xmp', 'comment', 'text'] — a minimal orientation-only EXIF
 * reports as 'orientation'.
 */
export function metadataKinds(b: Uint8Array, format: InputFormat): string[] {
  const found = new Set<string>();
  const classifyTiff = (t: Uint8Array) => {
    const isMinimal = t.length <= 26 && tiffOrientation(t) !== 1;
    if (isMinimal) {
      found.add('orientation');
      return;
    }
    found.add('exif');
    const le = t[0] === 0x49;
    const u16 = (o: number) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
    const u32 = (o: number) =>
      le
        ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0
        : ((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0;
    const ifd = u32(4);
    const n = ifd + 2 <= t.length ? u16(ifd) : 0;
    for (let i = 0; i < n; i++) if (u16(ifd + 2 + i * 12) === 0x8825) found.add('gps');
  };
  if (format === 'jpeg') {
    let o = 2;
    while (o + 4 <= b.length && b[o] === 0xff) {
      const m = b[o + 1];
      if (m === 0xda || m === 0xd9) break;
      const len = (b[o + 2] << 8) | b[o + 3];
      if (m === 0xe1 && ascii(b, o + 4, 6) === 'Exif\0\0') classifyTiff(b.subarray(o + 10, o + 2 + len));
      else if (m === 0xe1) found.add('xmp');
      else if (m === 0xed) found.add('iptc');
      else if (m === 0xfe) found.add('comment');
      o += 2 + len;
    }
  } else if (format === 'png') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 8;
    while (o + 12 <= b.length) {
      const len = dv.getUint32(o);
      const type = ascii(b, o + 4, 4);
      if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') found.add('text');
      if (type === 'tIME') found.add('time');
      if (type === 'eXIf') classifyTiff(b.subarray(o + 8, o + 8 + len));
      o += 12 + len;
    }
  } else if (format === 'webp') {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let o = 12;
    while (o + 8 <= b.length) {
      const fourcc = ascii(b, o, 4);
      const size = dv.getUint32(o + 4, true);
      if (fourcc === 'EXIF') classifyTiff(b.subarray(o + 8, o + 8 + size));
      if (fourcc === 'XMP ') found.add('xmp');
      o += 8 + size + (size & 1);
    }
  } else if (format === 'avif' || format === 'heic') {
    // `infe` entries name their item type; Exif and XMP (mime) items are metadata.
    for (let o = 0; o + 4 < Math.min(b.length, 1 << 16); o++) {
      if (b[o] === 0x69 && ascii(b, o, 4) === 'infe') {
        const window = ascii(b, o + 4, 24);
        if (window.includes('Exif')) found.add('exif');
        if (window.includes('mime')) found.add('xmp');
      }
    }
  }
  return [...found];
}
