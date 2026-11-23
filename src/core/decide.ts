import { MIN_REENCODE_GAIN } from './settings';
import type { InputFormat, OutputFormat } from './types';

export type KeepDecision = { keepOriginal: false } | { keepOriginal: true; reason: string };

/**
 * Safety rules for an output in the same format as the input:
 * - It must never be larger than the input. If it is, keep the original.
 * - A WebP/AVIF input that was already within the cap must shrink by at least
 *   5 %, otherwise re-encoding only adds generation loss.
 * Cross-format outputs (e.g. JPEG → AVIF) are always produced.
 */
export function decideKeepOriginal(args: {
  input: InputFormat;
  output: OutputFormat;
  inputSize: number;
  candidateSize: number;
  resized: boolean;
  /** File-size limit in bytes: an original above it can never be kept. */
  maxBytes?: number | null;
}): KeepDecision {
  const { input, output, inputSize, candidateSize, resized, maxBytes } = args;
  if (input !== output) return { keepOriginal: false };
  if (maxBytes && inputSize > maxBytes) return { keepOriginal: false };
  if (candidateSize >= inputSize) {
    return { keepOriginal: true, reason: 'Already optimal: re-encoding was not smaller than the original.' };
  }
  if (!resized && (input === 'webp' || input === 'avif') && candidateSize > inputSize * (1 - MIN_REENCODE_GAIN)) {
    return {
      keepOriginal: true,
      reason: `Already optimal: re-encoding saved under ${MIN_REENCODE_GAIN * 100}% (kept original to avoid generation loss).`,
    };
  }
  return { keepOriginal: false };
}
