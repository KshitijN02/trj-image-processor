import pica from 'pica';
import type { PipelineDeps } from '../core/pipeline';
import type { InputFormat, RGBAImage } from '../core/types';
import { createCodecOps, type CodecFns, type CodecProvider } from './codecs';

/*
 * Browser implementations of the pipeline dependencies. Each codec module is
 * dynamically imported the first time it's needed, so the initial page load
 * contains no WASM at all.
 */

const loaders: { [K in keyof CodecFns]: () => Promise<CodecFns[K]> } = {
  avifEncode: () => import('@jsquash/avif/encode.js').then((m) => m.default as unknown as CodecFns['avifEncode']),
  avifDecode: () => import('@jsquash/avif/decode.js').then((m) => m.default as unknown as CodecFns['avifDecode']),
  webpEncode: () => import('@jsquash/webp/encode.js').then((m) => m.default as unknown as CodecFns['webpEncode']),
  webpDecode: () => import('@jsquash/webp/decode.js').then((m) => m.default as unknown as CodecFns['webpDecode']),
  jpegEncode: () => import('@jsquash/jpeg/encode.js').then((m) => m.default as unknown as CodecFns['jpegEncode']),
  jpegDecode: () => import('@jsquash/jpeg/decode.js').then((m) => m.default as unknown as CodecFns['jpegDecode']),
  pngEncode: () => import('@jsquash/png/encode.js').then((m) => m.default as unknown as CodecFns['pngEncode']),
  pngDecode: () => import('@jsquash/png/decode.js').then((m) => m.default as unknown as CodecFns['pngDecode']),
  oxipng: () => import('@jsquash/oxipng/optimise.js').then((m) => m.default as unknown as CodecFns['oxipng']),
};

const cache = new Map<keyof CodecFns, Promise<unknown>>();
const provider: CodecProvider = {
  get(name) {
    let p = cache.get(name);
    if (!p) {
      p = loaders[name]();
      cache.set(name, p);
      p.catch(() => cache.delete(name));
    }
    return p as Promise<CodecFns[typeof name]>;
  },
};

export const codecs = createCodecOps(provider);

const MIME_IN: Record<InputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  gif: 'image/gif',
};

/**
 * Native decode: the browser applies EXIF orientation and colour-manages
 * ICC-tagged images, and the sRGB canvas gives back sRGB pixels.
 */
async function decodeNative(bytes: Uint8Array, format: InputFormat): Promise<RGBAImage> {
  const blob = new Blob([bytes as BlobPart], { type: MIME_IN[format] });
  const bmp = await createImageBitmap(blob, {
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'default',
  });
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    if (!ctx) throw new Error('No 2D context');
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height, { colorSpace: 'srgb' });
    return { data: id.data, width: id.width, height: id.height };
  } finally {
    bmp.close();
  }
}

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: unknown) => void): void;
  free?(): void;
}

/** HEIC/HEIF via libheif (lazy-loaded, WASM inlined); libheif applies irot/imir itself. */
async function decodeHeic(bytes: Uint8Array): Promise<RGBAImage> {
  const mod = (await import('libheif-js/libheif-wasm/libheif-bundle.mjs')) as {
    default: () => { HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] } };
  };
  const libheif = mod.default();
  const images = new libheif.HeifDecoder().decode(bytes);
  if (!images.length) throw new Error('HEIC file contains no images');
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
  await new Promise<void>((resolve, reject) =>
    image.display(target, (r) => (r ? resolve() : reject(new Error('HEIC decode failed')))),
  );
  for (const im of images) im.free?.();
  return target;
}

const resizer = pica({ features: ['js', 'wasm'] });
const wrap = (d: Uint8Array, width: number, height: number): RGBAImage => ({
  data: new Uint8ClampedArray(d.buffer, d.byteOffset, d.byteLength),
  width,
  height,
});

export const browserDeps: PipelineDeps = {
  async decode(bytes, format) {
    if (format === 'heic') {
      try {
        return await decodeHeic(bytes);
      } catch (e) {
        // Safari can decode HEIC natively.
        try {
          return await decodeNative(bytes, format);
        } catch {
          throw e;
        }
      }
    }
    try {
      return await decodeNative(bytes, format);
    } catch {
      return codecs.decodeInput(bytes, format);
    }
  },
  async resize(img, width, height) {
    const out = await resizer.resizeBuffer({
      src: img.data,
      width: img.width,
      height: img.height,
      toWidth: width,
      toHeight: height,
      filter: 'lanczos3',
    });
    return wrap(out, width, height);
  },
  async sharpen(img, p) {
    // A same-size Lanczos pass is an exact identity; pica then applies its unsharp mask.
    const out = await resizer.resizeBuffer({
      src: img.data,
      width: img.width,
      height: img.height,
      toWidth: img.width,
      toHeight: img.height,
      filter: 'lanczos3',
      unsharpAmount: p.amount,
      unsharpRadius: p.radius,
      unsharpThreshold: p.threshold,
    });
    return wrap(out, img.width, img.height);
  },
  encode: (req) => codecs.encode(req),
  decodeOutput: (f, b) => codecs.decodeOutput(f, b),
};
