import fs from 'node:fs';
import path from 'node:path';
import pica from 'pica';
import { createCodecOps, type CodecFns, type CodecProvider } from '../../src/worker/codecs';
import type { PipelineDeps } from '../../src/core/pipeline';
import type { RGBAImage } from '../../src/core/types';

const nm = path.resolve(__dirname, '../../node_modules');
const wasm = (p: string) => WebAssembly.compile(fs.readFileSync(path.join(nm, p)));

let fnsPromise: Promise<CodecFns> | null = null;

/** Initialises every jsquash codec from its .wasm on disk (Node can't fetch file URLs). */
function loadAll(): Promise<CodecFns> {
  return (fnsPromise ??= (async () => {
    const [avifE, avifD, webpE, webpD, jpegE, jpegD, pngE, pngD, oxi] = await Promise.all([
      import('@jsquash/avif/encode.js'),
      import('@jsquash/avif/decode.js'),
      import('@jsquash/webp/encode.js'),
      import('@jsquash/webp/decode.js'),
      import('@jsquash/jpeg/encode.js'),
      import('@jsquash/jpeg/decode.js'),
      import('@jsquash/png/encode.js'),
      import('@jsquash/png/decode.js'),
      import('@jsquash/oxipng/optimise.js'),
    ]);
    await avifE.init(await wasm('@jsquash/avif/codec/enc/avif_enc.wasm'));
    await avifD.init(await wasm('@jsquash/avif/codec/dec/avif_dec.wasm'));
    await webpE.init(await wasm('@jsquash/webp/codec/enc/webp_enc_simd.wasm'));
    await webpD.init(await wasm('@jsquash/webp/codec/dec/webp_dec.wasm'));
    await jpegE.init(await wasm('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
    await jpegD.init(await wasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));
    await pngE.init(await wasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
    await pngD.init(await wasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
    await oxi.init(await wasm('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'));
    return {
      avifEncode: avifE.default,
      avifDecode: avifD.default,
      webpEncode: webpE.default,
      webpDecode: webpD.default,
      jpegEncode: jpegE.default,
      jpegDecode: jpegD.default,
      pngEncode: pngE.default,
      pngDecode: pngD.default,
      oxipng: oxi.default,
    } as unknown as CodecFns;
  })());
}

export const nodeProvider: CodecProvider = {
  async get(name) {
    return (await loadAll())[name];
  },
};

export const nodeCodecs = createCodecOps(nodeProvider);

const resizer = pica({ features: ['js'] });

const wrap = (data: Uint8Array, width: number, height: number): RGBAImage => ({
  data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
  width,
  height,
});

export const nodeDeps: PipelineDeps = {
  decode: (bytes, format) => nodeCodecs.decodeInput(bytes, format),
  async resize(img, width, height) {
    const out = await resizer.resizeBuffer({ src: img.data, width: img.width, height: img.height, toWidth: width, toHeight: height, filter: 'lanczos3' });
    return wrap(out, width, height);
  },
  async sharpen(img, p) {
    const out = await resizer.resizeBuffer({
      src: img.data, width: img.width, height: img.height, toWidth: img.width, toHeight: img.height,
      filter: 'lanczos3', unsharpAmount: p.amount, unsharpRadius: p.radius, unsharpThreshold: p.threshold,
    });
    return wrap(out, img.width, img.height);
  },
  encode: (req) => nodeCodecs.encode(req),
  decodeOutput: (f, b) => nodeCodecs.decodeOutput(f, b),
};
