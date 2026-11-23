import type { ContentKind, InputFormat, OutputFormat, Settings } from './types';

export interface FormatPlan {
  /** Modern outputs, in encoding order (WebP before AVIF so its result narrows the AVIF search). */
  modern: OutputFormat[];
  /** Compatibility fallback (JPEG for opaque photos, PNG for graphics or transparency), if any. */
  fallback: OutputFormat | null;
}

/**
 * Format rules:
 * - JPEG / PNG / HEIC (and static GIF) → AVIF + WebP, optional JPEG/PNG fallback.
 * - WebP → WebP only (plus AVIF if "also create the other modern format").
 * - AVIF → AVIF only (plus WebP if that toggle is on).
 */
export function planFormats(
  input: InputFormat,
  settings: Settings,
  kind: ContentKind,
  hasAlpha: boolean,
): FormatPlan {
  let modern: OutputFormat[];
  let fallback: OutputFormat | null = null;
  if (input === 'webp') {
    modern = settings.alsoOtherModern ? ['webp', 'avif'] : ['webp'];
  } else if (input === 'avif') {
    modern = settings.alsoOtherModern ? ['webp', 'avif'] : ['avif'];
  } else {
    modern = [];
    if (settings.modernFormats.webp) modern.push('webp');
    if (settings.modernFormats.avif) modern.push('avif');
    if (settings.fallback || modern.length === 0) {
      fallback = kind === 'graphic' || hasAlpha ? 'png' : 'jpeg';
    }
  }
  return { modern, fallback };
}

/** Same-format outputs are subject to the "never larger than the input" rule. */
export function isSameFormat(input: InputFormat, output: OutputFormat): boolean {
  return input === output;
}
