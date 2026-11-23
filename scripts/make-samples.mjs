#!/usr/bin/env node
/**
 * Generates the procedural sample images in public/samples/ (no third-party
 * photos, so there are no licensing questions):
 *
 *   photo.jpg             3000×2000 landscape-like photo with EXIF (camera, GPS), XMP and a comment
 *   rotated-exif6.jpg     600×400 stored, EXIF orientation 6 → displays 400×600
 *   noisy-lowlight.jpg    1600×1067 dark scene with heavy sensor-like noise
 *   logo.png              1200×600 flat-colour logo/graphic with text-like bars, with tEXt chunks
 *   transparent.png       800×800 soft-edged shape on a transparent background
 *   existing.webp         1600×1067 photo, already a reasonably compressed WebP
 *   existing.avif         1600×1067 photo, already a reasonably compressed AVIF
 *   animated.gif          2-frame GIF (passes through unchanged)
 *
 * Usage: npm run samples
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const nm = path.join(root, 'node_modules');
const outDir = path.join(root, 'public', 'samples');
fs.mkdirSync(outDir, { recursive: true });

globalThis.ImageData ??= class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
const wasm = (p) => WebAssembly.compile(fs.readFileSync(path.join(nm, p)));
const jpegEnc = await import(path.join(nm, '@jsquash/jpeg/encode.js'));
await jpegEnc.init(await wasm('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
const webpEnc = await import(path.join(nm, '@jsquash/webp/encode.js'));
await webpEnc.init(await wasm('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
const avifEnc = await import(path.join(nm, '@jsquash/avif/encode.js'));
await avifEnc.init(await wasm('@jsquash/avif/codec/enc/avif_enc.wasm'));
const pngEnc = await import(path.join(nm, '@jsquash/png/encode.js'));
await pngEnc.init(await wasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));

// ------------------------------------------------------------------ noise helpers
let seed = 1234567;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
};
const PERM = new Uint8Array(512);
{
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}
const fade = (t) => t * t * (3 - 2 * t);
function valueNoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const h = (a, b) => PERM[(PERM[a & 255] + b) & 511] / 255;
  const v00 = h(xi, yi), v10 = h(xi + 1, yi), v01 = h(xi, yi + 1), v11 = h(xi + 1, yi + 1);
  const u = fade(xf), v = fade(yf);
  return (v00 * (1 - u) + v10 * u) * (1 - v) + (v01 * (1 - u) + v11 * u) * v;
}
function fbm(x, y, octaves) {
  let s = 0, a = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) {
    s += a * valueNoise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

/** A landscape-like scene: graded sky with clouds, textured mountains, grassy foreground. */
function makePhoto(w, h, { exposure = 1, noise = 2 } = {}) {
  const d = new Uint8ClampedArray(w * h * 4);
  const s = 1 / Math.min(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x * s, v = y * s;
      const ridge = 0.42 + 0.12 * fbm(u * 3, 0.5, 5) - 0.05 * Math.sin(u * 4);
      const yn = y / h;
      let r, g, b;
      if (yn < ridge) {
        const t = yn / ridge;
        const cloud = Math.max(0, fbm(u * 4 + 10, v * 8, 6) - 0.45) * 2.2;
        r = 90 + 90 * t + cloud * 140;
        g = 140 + 70 * t + cloud * 110;
        b = 215 + 25 * t + cloud * 30;
      } else if (yn < ridge + 0.22) {
        const rock = fbm(u * 24, v * 24, 6);
        const shade = 0.55 + 0.6 * rock;
        r = 115 * shade; g = 105 * shade; b = 100 * shade;
      } else {
        const grass = fbm(u * 60, v * 14, 5);
        const blade = valueNoise(u * 400, v * 60);
        const shade = 0.5 + 0.5 * grass + 0.25 * blade;
        r = 70 * shade; g = 125 * shade; b = 45 * shade;
      }
      const p = (y * w + x) * 4;
      d[p] = r * exposure + gauss() * noise;
      d[p + 1] = g * exposure + gauss() * noise;
      d[p + 2] = b * exposure + gauss() * noise;
      d[p + 3] = 255;
    }
  }
  return new ImageData(d, w, h);
}

function makeLogo(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  const SS = 4; // supersampling for anti-aliased edges, like a real exported logo
  const inside = (x, y) => {
    const cx = w * 0.22, cy = h * 0.5, r = h * 0.32;
    if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) return (x - cx) ** 2 + (y - cy) ** 2 < (r * 0.55) ** 2 ? 2 : 1;
    // "text": rows of bars of varying width
    for (let row = 0; row < 3; row++) {
      const top = h * (0.28 + row * 0.17), bottom = top + h * (row === 0 ? 0.11 : 0.07);
      if (y >= top && y < bottom && x > w * 0.42 && x < w * (0.92 - row * 0.12)) {
        const gap = (Math.floor(x / (h * 0.06)) % 5) === 4;
        return gap ? 0 : row === 0 ? 3 : 4;
      }
    }
    return 0;
  };
  const palette = [[255, 255, 255], [0, 102, 153], [255, 170, 0], [20, 30, 45], [90, 100, 115]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = palette[inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)];
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const p = (y * w + x) * 4;
      d[p] = acc[0] / (SS * SS); d[p + 1] = acc[1] / (SS * SS); d[p + 2] = acc[2] / (SS * SS); d[p + 3] = 255;
    }
  }
  return new ImageData(d, w, h);
}

function makeTransparent(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / (w * 0.38), dy = (y - h / 2) / (h * 0.3);
      const r = Math.sqrt(dx * dx + dy * dy) + 0.08 * Math.sin(Math.atan2(dy, dx) * 5);
      const a = Math.max(0, Math.min(1, (1 - r) * 12));
      const p = (y * w + x) * 4;
      d[p] = 230 - 120 * (y / h); d[p + 1] = 80 + 100 * (x / w); d[p + 2] = 60; d[p + 3] = Math.round(a * 255);
    }
  }
  return new ImageData(d, w, h);
}

// ------------------------------------------------------------------ metadata builders
function tiff(entries, extraIfds = {}) {
  // Big-endian TIFF with IFD0 = entries; values that don't fit in 4 bytes go after the IFDs.
  const bytes = [];
  const push16 = (v) => bytes.push((v >> 8) & 255, v & 255);
  const push32 = (v) => bytes.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const layout = (list, start) => 2 + list.length * 12 + 4 + start;
  const gps = extraIfds.gps ?? [];
  const ifd0Entries = gps.length ? [...entries, { tag: 0x8825, type: 4, count: 1, value: 0 }] : entries;
  const ifd0Start = 8;
  const gpsStart = layout(ifd0Entries, ifd0Start);
  let dataStart = gps.length ? layout(gps, gpsStart) : gpsStart;
  const blobs = [];
  const writeIfd = (list) => {
    push16(list.length);
    for (const e of list) {
      push16(e.tag); push16(e.type); push32(e.count);
      if (e.tag === 0x8825) { push32(gpsStart); continue; }
      if (e.data) {
        if (e.data.length <= 4) { const pad = [...e.data, 0, 0, 0, 0].slice(0, 4); bytes.push(...pad); }
        else { push32(dataStart); blobs.push(e.data); dataStart += e.data.length; }
      } else if (e.type === 3) { push16(e.value); push16(0); }
      else push32(e.value);
    }
    push32(0);
  };
  bytes.push(0x4d, 0x4d, 0, 42); push32(ifd0Start);
  writeIfd(ifd0Entries);
  if (gps.length) writeIfd(gps);
  for (const b of blobs) bytes.push(...b);
  return new Uint8Array(bytes);
}
const asciiBytes = (s) => [...Buffer.from(s + '\0', 'latin1')];
const rational = (n, d) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, (d >>> 24) & 255, (d >>> 16) & 255, (d >>> 8) & 255, d & 255];

function cameraExif(orientation) {
  return tiff(
    [
      { tag: 0x010f, type: 2, count: 8, data: asciiBytes('TestCam') },
      { tag: 0x0110, type: 2, count: 8, data: asciiBytes('Model 1') },
      { tag: 0x0112, type: 3, count: 1, value: orientation },
    ],
    {
      gps: [
        { tag: 0x0001, type: 2, count: 2, data: asciiBytes('N') },
        { tag: 0x0002, type: 5, count: 3, data: [...rational(48, 1), ...rational(51, 1), ...rational(2964, 100)] },
        { tag: 0x0003, type: 2, count: 2, data: asciiBytes('E') },
        { tag: 0x0004, type: 5, count: 3, data: [...rational(2, 1), ...rational(17, 1), ...rational(4020, 100)] },
      ],
    },
  );
}
const segment = (marker, payload) => {
  const len = payload.length + 2;
  return Buffer.concat([Buffer.from([0xff, marker, len >> 8, len & 255]), Buffer.from(payload)]);
};
function withJpegMetadata(jpeg, orientation) {
  const b = Buffer.from(jpeg);
  // mozjpeg writes SOI + APP0 (JFIF); insert our segments after APP0.
  const app0Len = (b[4] << 8) | b[5];
  const at = 4 + app0Len;
  const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(cameraExif(orientation))]));
  const xmp = segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>', 'latin1'));
  const com = segment(0xfe, Buffer.from('Sample comment: should be stripped', 'latin1'));
  return Buffer.concat([b.subarray(0, at), exif, xmp, com, b.subarray(at)]);
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function withPngText(png) {
  const b = Buffer.from(png);
  const ihdrEnd = 8 + 12 + b.readUInt32BE(8);
  const text = Buffer.concat([
    pngChunk('tEXt', Buffer.from('Software\0Sample generator', 'latin1')),
    pngChunk('tEXt', Buffer.from('Comment\0Should be stripped', 'latin1')),
  ]);
  return Buffer.concat([b.subarray(0, ihdrEnd), text, b.subarray(ihdrEnd)]);
}

function animatedGif() {
  // 2×2, 2-colour global palette, two frames with different pixels, looping.
  const bytes = [
    ...Buffer.from('GIF89a', 'latin1'), 2, 0, 2, 0, 0x80, 0, 0,
    255, 0, 0, 0, 0, 255, // palette: red, blue
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0,
  ];
  const frame = (code) => [
    0x21, 0xf9, 4, 0, 50, 0, 0, 0, // GCE, 0.5 s
    0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, // image descriptor
    2, ...code, 0,
  ];
  // LZW, min code size 2: CLEAR, 4 literal codes, EOI (code width grows 3→4 bits after entry 7).
  // All-index-0: 0x04 0x00 0x05, all-index-1: 0x4c 0x12 0x05.
  bytes.push(...frame([3, 0x04, 0x00, 0x05]), ...frame([3, 0x4c, 0x12, 0x05]));
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

// ------------------------------------------------------------------ write
const write = (name, data) => {
  fs.writeFileSync(path.join(outDir, name), data);
  console.log(`${name.padEnd(22)} ${(data.length / 1024).toFixed(1).padStart(8)} KB`);
};

const photo = makePhoto(3000, 2000);
write('photo.jpg', withJpegMetadata(new Uint8Array(await jpegEnc.default(photo, { quality: 90 })), 1));

const small = makePhoto(600, 400);
write('rotated-exif6.jpg', withJpegMetadata(new Uint8Array(await jpegEnc.default(small, { quality: 88 })), 6));

const noisy = makePhoto(1600, 1067, { exposure: 0.4, noise: 14 });
write('noisy-lowlight.jpg', new Uint8Array(await jpegEnc.default(noisy, { quality: 92 })));

write('logo.png', withPngText(new Uint8Array(await pngEnc.default(makeLogo(1200, 600)))));
write('transparent.png', new Uint8Array(await pngEnc.default(makeTransparent(800, 800))));

const mid = makePhoto(1600, 1067);
write('existing.webp', new Uint8Array(await webpEnc.default(mid, { quality: 82, method: 4 })));
write('existing.avif', new Uint8Array(await avifEnc.default(mid, { quality: 60, speed: 6 })));
write('animated.gif', animatedGif());
