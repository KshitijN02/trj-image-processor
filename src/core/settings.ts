import type { ContentKind, OutputFormat, QualitySafety, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  cap: 2560,
  safety: 'standard',
  denoise: 'auto',
  sharpen: true,
  modernFormats: { avif: true, webp: true },
  fallback: false,
  alsoOtherModern: false,
  responsive: false,
  avifSpeed: 6,
  maxFileKB: null,
};

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MEGAPIXELS = 100;
/** Images above this are scheduled one at a time to protect memory on phones. */
export const LARGE_IMAGE_MEGAPIXELS = 24;

export const RESPONSIVE_WIDTHS = [400, 800, 1600] as const;

/** Minimum luma mssim per content kind and safety level. */
export const SSIM_THRESHOLDS: Record<QualitySafety, Record<ContentKind, number>> = {
  standard: { photo: 0.985, graphic: 0.99 },
  high: { photo: 0.99, graphic: 0.994 },
  maximum: { photo: 0.995, graphic: 0.997 },
};

export function thresholdFor(safety: QualitySafety, kind: ContentKind): number {
  return SSIM_THRESHOLDS[safety][kind];
}

/** Encoder quality search ranges (inclusive). PNG is never searched. */
export const QUALITY_RANGES: Record<Exclude<OutputFormat, 'png'>, { lo: number; hi: number }> = {
  avif: { lo: 35, hi: 80 },
  webp: { lo: 60, hi: 92 },
  jpeg: { lo: 65, hi: 92 },
};

/** A WebP/AVIF input within the cap must shrink by at least this fraction to be re-encoded. */
export const MIN_REENCODE_GAIN = 0.05;

/**
 * Size-cap mode: lowest encoder qualities we'll go to before shrinking the
 * dimensions instead (below these, artefacts look worse than a smaller image).
 */
export const BUDGET_QUALITY_FLOORS: Record<'avif' | 'webp' | 'jpeg', number> = { avif: 20, webp: 30, jpeg: 35 };
/** Default size limit offered in the UI, in KB (1 KB = 1000 bytes). */
export const DEFAULT_MAX_FILE_KB = 50;

/** Noise sigma (0–255 scale) above which "Auto" denoise kicks in. */
export const DENOISE_SIGMA_THRESHOLD = 2.8;

export const SHARPEN = { amount: 80, radius: 0.6, threshold: 2 } as const;

export const MIME: Record<OutputFormat, string> = {
  avif: 'image/avif',
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export const EXT: Record<OutputFormat, string> = {
  avif: 'avif',
  webp: 'webp',
  jpeg: 'jpg',
  png: 'png',
};
