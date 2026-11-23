/** Formats we can recognise from magic bytes. */
export type InputFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'heic' | 'gif';

/** Formats we can write. */
export type OutputFormat = 'avif' | 'webp' | 'jpeg' | 'png';

/** Plain RGBA pixel buffer (structurally compatible with ImageData). */
export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type LongEdgeCap = 1920 | 2560 | 3000;
export type QualitySafety = 'standard' | 'high' | 'maximum';
export type AvifSpeed = 4 | 5 | 6;

export interface Settings {
  cap: LongEdgeCap;
  safety: QualitySafety;
  denoise: 'auto' | 'off';
  sharpen: boolean;
  /** Modern formats produced for JPEG / PNG / HEIC inputs. */
  modernFormats: { avif: boolean; webp: boolean };
  /** Also write an optimised JPEG (or PNG for graphics / transparency) fallback. */
  fallback: boolean;
  /** For WebP/AVIF inputs: also create the other modern format. */
  alsoOtherModern: boolean;
  /** Export extra widths (400 / 800 / 1600) for srcset. */
  responsive: boolean;
  avifSpeed: AvifSpeed;
  /**
   * Hard size limit per output file in KB (1 KB = 1000 bytes), or null for none.
   * When set, quality may drop below the SSIM threshold and, if needed, the
   * image is downscaled until every output fits.
   */
  maxFileKB: number | null;
}

export type ContentKind = 'photo' | 'graphic';

/** How a candidate was encoded. */
export type EncodeMode =
  | { kind: 'lossy'; quality: number; chroma: '420' | '444' }
  | { kind: 'lossless' }
  | { kind: 'palette'; colors: number };

export interface OutputFile {
  name: string;
  /** 'gif' only for pass-through animated GIFs. */
  format: OutputFormat | 'gif';
  mime: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  /** Human label for the encoding, e.g. "q62 4:2:0", "lossless", "palette 64". */
  modeLabel: string;
  /** Encoder quality when lossy, otherwise null. */
  quality: number | null;
  /** Luma mssim against the processed source; null when the original bytes were kept. */
  ssim: number | null;
  thresholdMet: boolean;
  /** True when the original bytes were kept ("Already optimal"). */
  keptOriginal: boolean;
  /** Responsive variant (not the main output). */
  variant: boolean;
  /** Quality and/or dimensions were reduced to meet the file-size limit. */
  sizeCapped?: boolean;
  note?: string;
}

export interface ProcessReport {
  status: 'done' | 'passthrough';
  warnings: string[];
  input: { name: string; format: InputFormat; size: number; width: number; height: number };
  processed: {
    width: number;
    height: number;
    resized: boolean;
    denoised: boolean;
    noiseSigma: number;
    sharpened: boolean;
    kind: ContentKind;
    hasAlpha: boolean;
    alphaDropped: boolean;
    threshold: number;
  } | null;
  outputs: OutputFile[];
  /** Browser-displayable preview of the original, only for inputs browsers can't show (HEIC). */
  beforePreview?: Uint8Array;
  timings: Record<string, number>;
}

export type ProgressFn = (stage: string, fraction: number) => void;
