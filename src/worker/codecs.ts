import type { EncodeRequest } from '../core/pipeline';
import { applyOrientation, jpegOrientation } from '../core/orientation';
import type { InputFormat, OutputFormat, RGBAImage } from '../core/types';

/*
 * Thin adapter over the jsquash codecs. A CodecProvider resolves each codec
 * function on demand. The browser provider lazy-imports the modules (so each
 * WASM file loads only when first needed); the Node test provider pre-initialises
 * them from disk.
 */

type ImageLike = { data: Uint8ClampedArray; width: number; height: number };
export interface CodecFns {
  avifEncode: (img: ImageLike, opts: Record<string, unknown>) => Promise<ArrayBuffer>;
  avifDecode: (buf: ArrayBuffer) => Promise<ImageLike | null>;
  webpEncode: (img: ImageLike, opts: Record<string, unknown>) => Promise<ArrayBuffer>;
  webpDecode: (buf: ArrayBuffer) => Promise<ImageLike>;
  jpegEncode: (img: ImageLike, opts: Record<string, unknown>) => Promise<ArrayBuffer>;
  jpegDecode: (buf: ArrayBuffer) => Promise<ImageLike>;
  pngEncode: (img: ImageLike) => Promise<ArrayBuffer>;
  pngDecode: (buf: ArrayBuffer) => Promise<ImageLike>;
  oxipng: (buf: ArrayBuffer, opts: Record<string, unknown>) => Promise<ArrayBuffer>;
}

export interface CodecProvider {
  get<K extends keyof CodecFns>(name: K): Promise<CodecFns[K]>;
}

/** jsquash reads `data.buffer` directly, so the pixel view must cover its whole buffer. */
function tight(img: RGBAImage): ImageLike {
  const d = img.data;
  if (d.byteOffset === 0 && d.byteLength === d.buffer.byteLength) return img;
  return { data: new Uint8ClampedArray(d), width: img.width, height: img.height };
}

/** An exact-length ArrayBuffer copy of the bytes (decoders take ArrayBuffers). */
function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}

function fromImageLike(img: ImageLike | null): RGBAImage {
  if (!img) throw new Error('Decoder returned no image');
  return { data: img.data, width: img.width, height: img.height };
}

/** Maps our encode modes to jsquash option objects. */
export function encoderOptions(req: EncodeRequest): Record<string, unknown> {
  const { format, mode, avifSpeed } = req;
  switch (format) {
    case 'webp':
      if (mode.kind === 'lossless') return { lossless: 1, quality: 75, method: 6, exact: 0 };
      if (mode.kind !== 'lossy') throw new Error('webp: unsupported mode');
      // WebP lossy is always 4:2:0. For graphics, sharp YUV is the closest thing to 4:4:4.
      return { quality: mode.quality, method: 6, use_sharp_yuv: mode.chroma === '444' ? 1 : 0, alpha_quality: 100 };
    case 'avif':
      if (mode.kind === 'lossless') return { lossless: true, speed: avifSpeed };
      if (mode.kind !== 'lossy') throw new Error('avif: unsupported mode');
      return {
        quality: mode.quality,
        qualityAlpha: -1,
        speed: avifSpeed,
        subsample: mode.chroma === '444' ? 3 : 1, // 3 = 4:4:4, 1 = 4:2:0
        tune: 0,
      };
    case 'jpeg':
      if (mode.kind !== 'lossy') throw new Error('jpeg: only lossy');
      return {
        quality: mode.quality,
        baseline: false,
        progressive: true,
        optimize_coding: true,
        trellis_multipass: true,
        trellis_opt_zero: true,
        trellis_opt_table: true,
        trellis_loops: 1,
        quant_table: 3,
        auto_subsample: false,
        chroma_subsample: mode.chroma === '444' ? 1 : 2, // 1 = no subsampling, 2 = 4:2:0
      };
    case 'png':
      return { level: 3, interlace: false, optimiseAlpha: true };
  }
}

export function createCodecOps(provider: CodecProvider) {
  async function encode(req: EncodeRequest): Promise<Uint8Array> {
    const img = tight(req.image);
    const opts = encoderOptions(req);
    switch (req.format) {
      case 'webp':
        return new Uint8Array(await (await provider.get('webpEncode'))(img, opts));
      case 'avif':
        return new Uint8Array(await (await provider.get('avifEncode'))(img, opts));
      case 'jpeg':
        return new Uint8Array(await (await provider.get('jpegEncode'))(img, opts));
      case 'png': {
        const raw = await (await provider.get('pngEncode'))(img);
        return new Uint8Array(await (await provider.get('oxipng'))(raw, opts));
      }
    }
  }

  async function decodeOutput(format: OutputFormat, bytes: Uint8Array): Promise<RGBAImage> {
    const buf = toArrayBuffer(bytes);
    switch (format) {
      case 'webp':
        return fromImageLike(await (await provider.get('webpDecode'))(buf));
      case 'avif':
        return fromImageLike(await (await provider.get('avifDecode'))(buf));
      case 'jpeg':
        return fromImageLike(await (await provider.get('jpegDecode'))(buf));
      case 'png':
        return fromImageLike(await (await provider.get('pngDecode'))(buf));
    }
  }

  /** Decode an input with jsquash (no colour management), applying EXIF orientation for JPEG. */
  async function decodeInput(bytes: Uint8Array, format: InputFormat): Promise<RGBAImage> {
    if (format === 'jpeg') {
      const img = await decodeOutput('jpeg', bytes);
      return applyOrientation(img, jpegOrientation(bytes));
    }
    if (format === 'png' || format === 'webp' || format === 'avif') return decodeOutput(format, bytes);
    throw new Error(`No WASM decoder for ${format.toUpperCase()}`);
  }

  return { encode, decodeOutput, decodeInput };
}
