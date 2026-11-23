import { MAX_FILE_BYTES, MAX_MEGAPIXELS } from './settings';
import { detectFormat, isAnimated, readDimensions } from './sniff';
import type { InputFormat } from './types';

export type Admission =
  | { ok: true; format: InputFormat; width: number; height: number; animated: boolean }
  | { ok: false; reason: string };

const fmtMB = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Pre-flight check run on the main thread before a file is queued. */
export function admit(bytes: Uint8Array): Admission {
  if (bytes.length > MAX_FILE_BYTES) {
    return { ok: false, reason: `File is ${fmtMB(bytes.length)}; the limit is ${fmtMB(MAX_FILE_BYTES)}.` };
  }
  const format = detectFormat(bytes);
  if (!format) {
    return { ok: false, reason: 'Unsupported file type. Use JPEG, PNG, WebP, AVIF or HEIC/HEIF.' };
  }
  const dims = readDimensions(bytes, format);
  if (!dims || dims.width <= 0 || dims.height <= 0) {
    return { ok: false, reason: 'Could not read the image dimensions; the file may be corrupt.' };
  }
  const mp = (dims.width * dims.height) / 1e6;
  if (mp > MAX_MEGAPIXELS) {
    return {
      ok: false,
      reason: `Image is ${dims.width}×${dims.height} (${mp.toFixed(1)} MP); the limit is ${MAX_MEGAPIXELS} MP.`,
    };
  }
  return { ok: true, format, ...dims, animated: isAnimated(bytes, format) };
}
