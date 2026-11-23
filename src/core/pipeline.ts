import { forceOpaque, isFullyOpaque } from './alpha';
import { classify } from './classify';
import { decideKeepOriginal } from './decide';
import { planFormats } from './formats';
import { stripMetadata, metadataKinds } from './metadata';
import { outputName } from './naming';
import { bilateralDenoise, estimateNoise } from './noise';
import { buildProxy } from './proxy';
import { quantize } from './quantize';
import { fitToWidth, fitWithinCap } from './resize';
import { passes, scoreImages, type SsimAlgo } from './score';
import { avifWindowFromWebp, highestFitting, lowestPassing, memoize, refineDown, windowedSearch, type SearchResult } from './search';
import {
  BUDGET_QUALITY_FLOORS,
  DENOISE_SIGMA_THRESHOLD,
  MIME,
  QUALITY_RANGES,
  RESPONSIVE_WIDTHS,
  SHARPEN,
  thresholdFor,
} from './settings';
import { detectFormat, isAnimated, readDimensions } from './sniff';
import type {
  ContentKind,
  EncodeMode,
  InputFormat,
  OutputFile,
  OutputFormat,
  ProcessReport,
  ProgressFn,
  RGBAImage,
  Settings,
} from './types';

export interface EncodeRequest {
  format: OutputFormat;
  image: RGBAImage;
  mode: EncodeMode;
  avifSpeed: number;
}

/** Environment-specific pieces. The browser worker and the Node tests each supply their own. */
export interface PipelineDeps {
  /** Decode to upright (EXIF orientation applied), 8-bit sRGB RGBA. */
  decode(bytes: Uint8Array, format: InputFormat): Promise<RGBAImage>;
  /** High-quality (Lanczos) resize without sharpening. */
  resize(img: RGBAImage, width: number, height: number): Promise<RGBAImage>;
  /** Unsharp mask at the same size. */
  sharpen(img: RGBAImage, params: { amount: number; radius: number; threshold: number }): Promise<RGBAImage>;
  /** Encode without any metadata. PNG output is expected to be oxipng-optimised. */
  encode(req: EncodeRequest): Promise<Uint8Array>;
  /** Decode an encoded candidate for scoring. */
  decodeOutput(format: OutputFormat, bytes: Uint8Array): Promise<RGBAImage>;
}

interface Candidate {
  bytes: Uint8Array;
  mode: EncodeMode;
  ssim: number;
  met: boolean;
}

interface EncodeContext {
  ref: RGBAImage;
  kind: ContentKind;
  hasAlpha: boolean;
  threshold: number;
  avifSpeed: number;
  deps: PipelineDeps;
  /** WebP lossy quality from this image, used to narrow the AVIF search. */
  webpHint?: number;
  /** Mosaic of representative full-resolution tiles for large images (search only). */
  proxy?: RGBAImage | null;
}

export function modeLabel(format: OutputFormat, mode: EncodeMode): string {
  if (mode.kind === 'lossless') return 'lossless';
  if (mode.kind === 'palette') return `palette ${mode.colors}`;
  if (format === 'webp') return `q${mode.quality}${mode.chroma === '444' ? ' sharp-YUV' : ''}`;
  if (format === 'png') return 'lossless';
  return `q${mode.quality} ${mode.chroma === '444' ? '4:4:4' : '4:2:0'}`;
}

async function scoreBytes(ctx: EncodeContext, format: OutputFormat, bytes: Uint8Array, algo: SsimAlgo) {
  const decoded = await ctx.deps.decodeOutput(format, bytes);
  return scoreImages(ctx.ref, decoded, { kind: ctx.kind, hasAlpha: ctx.hasAlpha, algo });
}

/**
 * Adaptive lossy encode: binary-search the lowest quality that passes (fast
 * SSIM), then confirm with full SSIM, stepping up if confirmation fails.
 */
async function adaptiveLossy(
  ctx: EncodeContext,
  format: Exclude<OutputFormat, 'png'>,
  chroma: '420' | '444',
): Promise<Candidate & { quality: number }> {
  const range = QUALITY_RANGES[format];
  const encodeFull = memoize(async (quality: number) => {
    const bytes = await ctx.deps.encode({
      format,
      image: ctx.ref,
      mode: { kind: 'lossy', quality, chroma },
      avifSpeed: ctx.avifSpeed,
    });
    const score = await scoreBytes(ctx, format, bytes, 'bezkrovny');
    return { quality, pass: passes(score, ctx.threshold), value: bytes };
  });

  // Search on the proxy mosaic when there is one (large images), else on the full image.
  const proxy = ctx.proxy;
  const searchAt = proxy
    ? memoize(async (quality: number) => {
        const bytes = await ctx.deps.encode({
          format,
          image: proxy,
          mode: { kind: 'lossy', quality, chroma },
          avifSpeed: ctx.avifSpeed,
        });
        const decoded = await ctx.deps.decodeOutput(format, bytes);
        const score = scoreImages(proxy, decoded, { kind: ctx.kind, hasAlpha: ctx.hasAlpha, algo: 'bezkrovny' });
        return { quality, pass: passes(score, ctx.threshold), value: bytes };
      })
    : encodeFull;

  let result: SearchResult<Uint8Array>;
  if (format === 'avif' && ctx.webpHint !== undefined) {
    result = await windowedSearch(range, avifWindowFromWebp(ctx.webpHint), searchAt);
  } else {
    result = await lowestPassing(range.lo, range.hi, searchAt);
  }

  // Confirm on the full image at output size with the reference SSIM implementation.
  const verified = new Map<number, Promise<{ bytes: Uint8Array; ssim: number; ok: boolean }>>();
  const verifyAt = (quality: number) => {
    let p = verified.get(quality);
    if (!p) {
      p = (async () => {
        const bytes = (await encodeFull(quality)).value;
        const score = await scoreBytes(ctx, format, bytes, 'weber');
        return { bytes, ssim: score.luma, ok: passes(score, ctx.threshold) };
      })();
      verified.set(quality, p);
    }
    return p;
  };

  let q = result.best.quality;
  let steppedUp = false;
  for (;;) {
    const v = await verifyAt(q);
    if (!v.ok && q >= range.hi) {
      return { bytes: v.bytes, mode: { kind: 'lossy', quality: q, chroma }, ssim: v.ssim, met: false, quality: q };
    }
    if (v.ok) break;
    q = Math.min(range.hi, q + 2);
    steppedUp = true;
  }

  // The search result may sit a little high (proxy tiles, fast-SSIM variant): walk down
  // on the full image while it still passes. The walk uses the fast SSIM that comes with
  // every full-size encode; only the final pick is re-checked with the reference SSIM,
  // stepping back up toward `q` (known to pass) if that check disagrees.
  const known = q;
  q = await refineDown(q, range.lo, steppedUp, async (c) => (await encodeFull(c)).pass);
  let v = await verifyAt(q);
  while (!v.ok && q < known) v = await verifyAt(++q);
  return { bytes: v.bytes, mode: { kind: 'lossy', quality: q, chroma }, ssim: v.ssim, met: true, quality: q };
}

async function exact(ctx: EncodeContext, format: OutputFormat, image: RGBAImage, mode: EncodeMode): Promise<Candidate> {
  const bytes = await ctx.deps.encode({ format, image, mode, avifSpeed: ctx.avifSpeed });
  const score = await scoreBytes(ctx, format, bytes, 'weber');
  return { bytes, mode, ssim: score.luma, met: passes(score, ctx.threshold) };
}

function smallestPassing(cands: Candidate[]): Candidate {
  const ok = cands.filter((c) => c.met);
  const pool = ok.length ? ok : cands;
  return pool.reduce((a, b) => (b.bytes.length < a.bytes.length ? b : a));
}

/** Best encoding of `ctx.ref` in `format` under the quality rules for its content kind. */
async function encodeBest(ctx: EncodeContext, format: OutputFormat): Promise<Candidate & { webpQuality?: number }> {
  const photo = ctx.kind === 'photo';
  switch (format) {
    case 'webp': {
      const lossy = await adaptiveLossy(ctx, 'webp', photo ? '420' : '444');
      if (photo) return { ...lossy, webpQuality: lossy.quality };
      const lossless = await exact(ctx, 'webp', ctx.ref, { kind: 'lossless' });
      return { ...smallestPassing([lossy, lossless]), webpQuality: lossy.quality };
    }
    case 'avif': {
      const lossy = await adaptiveLossy(ctx, 'avif', photo ? '420' : '444');
      if (lossy.met || photo) return lossy;
      // A graphic that fails even at top lossy quality: lossless AVIF is the safe choice.
      return smallestPassing([lossy, await exact(ctx, 'avif', ctx.ref, { kind: 'lossless' })]);
    }
    case 'jpeg':
      return adaptiveLossy(ctx, 'jpeg', photo ? '420' : '444');
    case 'png': {
      const cands = [await exact(ctx, 'png', ctx.ref, { kind: 'lossless' })];
      const q = quantize(ctx.ref, 256);
      if (q) cands.push(await exact(ctx, 'png', q.image, { kind: 'palette', colors: q.colors }));
      return smallestPassing(cands);
    }
  }
}

interface BudgetResult {
  cand: Candidate;
  size: { width: number; height: number };
  scaled: boolean;
}

/**
 * Size-cap mode. Called only when the quality-safe result is over `maxBytes`.
 *
 * Each format has an ordered list of "levels" from cheapest to best: lossy
 * qualities from the budget floor up to the range top, or for PNG palettes of
 * 8 → 256 colours and then lossless. At a given size:
 *  - encode the cheapest level once; if it fits, binary-search the best level
 *    that still fits (quality may end up below the SSIM threshold);
 *  - if even the cheapest level is too big, downscale and try again.
 * The downscale ratio comes from a learned size ∝ scale^k model. k starts at
 * 2 (bytes ∝ area) and is re-fitted from the last two passes, because files
 * dominated by edges or alpha outlines scale closer to k ≈ 1. Downscales always
 * start from the full processed image, so resamples never stack.
 */
async function fitToBudget(
  ctx: EncodeContext,
  format: OutputFormat,
  maxBytes: number,
  sharpen: boolean,
): Promise<BudgetResult> {
  const { deps } = ctx;
  const chroma = ctx.kind === 'photo' ? '420' : '444';
  const PALETTES = [8, 16, 32, 64, 128, 256];
  const levelCount =
    format === 'png' ? PALETTES.length + 1 : QUALITY_RANGES[format].hi - BUDGET_QUALITY_FLOORS[format] + 1;

  const encodeLevel = async (ref: RGBAImage, i: number): Promise<{ bytes: Uint8Array; mode: EncodeMode }> => {
    if (format === 'png') {
      const q = i < PALETTES.length ? quantize(ref, PALETTES[i]) : null;
      const mode: EncodeMode = q ? { kind: 'palette', colors: q.colors } : { kind: 'lossless' };
      return { bytes: await deps.encode({ format, image: q ? q.image : ref, mode, avifSpeed: ctx.avifSpeed }), mode };
    }
    const mode: EncodeMode = { kind: 'lossy', quality: BUDGET_QUALITY_FLOORS[format] + i, chroma };
    return { bytes: await deps.encode({ format, image: ref, mode, avifSpeed: ctx.avifSpeed }), mode };
  };

  let ref = ctx.ref;
  let scale = 1;
  const history: { scale: number; size: number }[] = [];
  for (;;) {
    const cache = new Map<number, Promise<{ bytes: Uint8Array; mode: EncodeMode }>>();
    const at = (i: number) => {
      let p = cache.get(i);
      if (!p) cache.set(i, (p = encodeLevel(ref, i)));
      return p;
    };
    const floor = await at(0);
    if (floor.bytes.length <= maxBytes) {
      const i = (await highestFitting(0, levelCount - 1, maxBytes, async (l) => (await at(l)).bytes.length))!;
      const { bytes, mode } = await at(i);
      const decoded = await deps.decodeOutput(format, bytes);
      const score = scoreImages(ref, decoded, { kind: ctx.kind, hasAlpha: ctx.hasAlpha, algo: 'weber' });
      return {
        cand: { bytes, mode, ssim: score.luma, met: passes(score, ctx.threshold) },
        size: { width: ref.width, height: ref.height },
        scaled: ref !== ctx.ref,
      };
    }

    history.push({ scale, size: floor.bytes.length });
    let k = 2;
    if (history.length >= 2) {
      const [a, b] = history.slice(-2);
      const fitted = Math.log(b.size / a.size) / Math.log(b.scale / a.scale);
      if (Number.isFinite(fitted)) k = Math.min(2.5, Math.max(0.7, fitted));
    }
    // Aim 5 % under the limit; always shrink at least 8 % and at most 70 % per pass.
    const target = scale * Math.pow((maxBytes * 0.95) / floor.bytes.length, 1 / k);
    scale = Math.min(scale * 0.92, Math.max(scale * 0.3, target));
    const width = Math.max(1, Math.round(ctx.ref.width * scale));
    const height = Math.max(1, Math.round(ctx.ref.height * scale));
    if (width <= 8 && height <= 8) throw new Error(`Cannot fit ${format.toUpperCase()} within ${maxBytes} bytes`);
    let next = await deps.resize(ctx.ref, width, height);
    if (sharpen) next = await deps.sharpen(next, SHARPEN);
    if (!ctx.hasAlpha) forceOpaque(next);
    ref = next;
  }
}

function toOutput(
  name: string,
  format: OutputFormat,
  image: { width: number; height: number },
  c: Candidate,
  variant: boolean,
): OutputFile {
  return {
    name,
    format,
    mime: MIME[format],
    bytes: c.bytes,
    width: image.width,
    height: image.height,
    modeLabel: modeLabel(format, c.mode),
    quality: c.mode.kind === 'lossy' ? c.mode.quality : null,
    ssim: c.ssim,
    thresholdMet: c.met,
    keptOriginal: false,
    variant,
  };
}

export async function processImage(
  input: { name: string; bytes: Uint8Array },
  settings: Settings,
  deps: PipelineDeps,
  onProgress: ProgressFn = () => {},
): Promise<ProcessReport> {
  const timings: Record<string, number> = {};
  let clock = performance.now();
  const lap = (label: string) => {
    const now = performance.now();
    timings[label] = Math.round(now - clock);
    clock = now;
  };
  const warnings: string[] = [];
  const { bytes, name } = input;

  const format = detectFormat(bytes);
  if (!format) throw new Error('Unsupported or unrecognised image format.');
  const dims = readDimensions(bytes, format) ?? { width: 0, height: 0 };
  const inputInfo = { name, format, size: bytes.length, ...dims };

  // Animated images are out of scope for v1 and pass through unchanged.
  if (isAnimated(bytes, format)) {
    warnings.push('Animated image detected: passed through unchanged (animation is not processed in v1).');
    if (settings.maxFileKB && bytes.length > settings.maxFileKB * 1000) {
      warnings.push(`Animated file is over the ${settings.maxFileKB} KB size limit and cannot be reduced in v1.`);
    }
    return {
      status: 'passthrough',
      warnings,
      input: inputInfo,
      processed: null,
      outputs: [
        {
          name,
          format: format === 'gif' ? 'gif' : (format as OutputFormat),
          mime: format === 'gif' ? 'image/gif' : MIME[format as OutputFormat],
          bytes,
          width: dims.width,
          height: dims.height,
          modeLabel: 'original (animated)',
          quality: null,
          ssim: null,
          thresholdMet: true,
          keptOriginal: true,
          variant: false,
        },
      ],
      timings,
    };
  }

  // 1. Decode (upright, sRGB)
  onProgress('Decoding', 0.02);
  let decoded: RGBAImage;
  try {
    decoded = await deps.decode(bytes, format);
  } catch (e) {
    const detail = e instanceof Error && e.message ? ` (${e.message})` : '';
    throw new Error(`Could not decode this ${format.toUpperCase()} file; it may be corrupt or truncated${detail}.`);
  }
  inputInfo.width = decoded.width;
  inputInfo.height = decoded.height;
  const hasAlpha = !isFullyOpaque(decoded);
  lap('decode');

  // 2. Resize (never upscale)
  const target = fitWithinCap(decoded, settings.cap);
  const resized = target.width !== decoded.width || target.height !== decoded.height;
  onProgress(resized ? 'Resizing' : 'Analysing', 0.1);
  let work = resized ? await deps.resize(decoded, target.width, target.height) : decoded;
  if (!hasAlpha) forceOpaque(work);
  const beforePreviewSource = format === 'heic' ? work : null;
  lap('resize');

  // 3. Denoise at output size, only when measurably noisy
  onProgress('Measuring noise', 0.16);
  const noiseSigma = estimateNoise(work);
  const denoised = settings.denoise === 'auto' && noiseSigma > DENOISE_SIGMA_THRESHOLD;
  if (denoised) {
    onProgress('Denoising', 0.18);
    work = bilateralDenoise(work, noiseSigma);
  }
  lap('denoise');
  const preSharpen = work;

  // 4. Sharpen, only after a downscale
  const sharpened = settings.sharpen && resized;
  if (sharpened) {
    onProgress('Sharpening', 0.22);
    work = await deps.sharpen(work, SHARPEN);
    if (!hasAlpha) forceOpaque(work);
  }
  lap('sharpen');

  // 6. Content detection
  const { kind } = classify(work);
  const threshold = thresholdFor(settings.safety, kind);
  const plan = planFormats(format, settings, kind, hasAlpha);
  const formats: OutputFormat[] = [...plan.modern, ...(plan.fallback ? [plan.fallback] : [])];
  lap('classify');

  // Adaptive encoding of the main outputs
  const outputs: OutputFile[] = [];
  const variantWidths = settings.responsive ? RESPONSIVE_WIDTHS.filter((w) => w < work.width) : [];
  const totalSteps = formats.length * (1 + variantWidths.length);
  let step = 0;
  const encodeProgress = (label: string) => onProgress(label, 0.25 + (0.73 * step) / totalSteps);

  const ctx: EncodeContext = {
    ref: work,
    proxy: buildProxy(work),
    kind,
    hasAlpha,
    threshold,
    avifSpeed: settings.avifSpeed,
    deps,
  };
  const maxBytes = settings.maxFileKB ? Math.round(settings.maxFileKB * 1000) : null;
  const capLabel = settings.maxFileKB ? `${settings.maxFileKB} KB` : '';

  /** Quality-safe encode, then (size-cap mode only) squeeze it under the limit. */
  const encodeWithCap = async (c: EncodeContext, f: OutputFormat, variant: boolean): Promise<OutputFile> => {
    const best = await encodeBest(c, f);
    if (best.webpQuality !== undefined) c.webpHint = best.webpQuality;
    if (!maxBytes || best.bytes.length <= maxBytes) {
      return toOutput(outputName(name, c.ref.width, f), f, c.ref, best, variant);
    }
    encodeProgress(`Fitting ${f.toUpperCase()} under ${capLabel}`);
    const fit = await fitToBudget(c, f, maxBytes, settings.sharpen);
    const out = toOutput(outputName(name, fit.size.width, f), f, fit.size, fit.cand, variant);
    out.sizeCapped = true;
    const changes = [
      fit.cand.mode.kind === 'lossy' ? `quality lowered to ${fit.cand.mode.quality}` : `reduced to ${modeLabel(f, fit.cand.mode)}`,
      fit.scaled ? `resized to ${fit.size.width}×${fit.size.height}` : '',
    ].filter(Boolean);
    out.note = `Size limit ${capLabel}: ${changes.join(', ')} (was ${(best.bytes.length / 1000).toFixed(1)} KB).`;
    return out;
  };

  for (const f of formats) {
    encodeProgress(`Encoding ${f.toUpperCase()}`);
    const out = await encodeWithCap(ctx, f, false);
    step++;

    const decision = decideKeepOriginal({
      input: format,
      output: f,
      inputSize: bytes.length,
      candidateSize: out.bytes.length,
      resized: resized || out.width !== work.width,
      maxBytes,
    });
    if (decision.keepOriginal) {
      const stripped = stripMetadata(bytes, format);
      const left = metadataKinds(stripped.bytes, format).filter((k) => k !== 'orientation');
      if (left.length) warnings.push(`Kept original ${f.toUpperCase()}; metadata (${left.join(', ')}) could not be removed losslessly.`);
      outputs.push({
        name: outputName(name, decoded.width, f),
        format: f,
        mime: MIME[f],
        bytes: stripped.bytes,
        width: decoded.width,
        height: decoded.height,
        modeLabel: 'original',
        quality: null,
        ssim: null,
        thresholdMet: true,
        keptOriginal: true,
        variant: false,
        note: decision.reason,
      });
    } else {
      outputs.push(out);
      if (out.sizeCapped) {
        warnings.push(
          `${f.toUpperCase()}: ${out.note}${out.thresholdMet ? '' : ` SSIM ${out.ssim!.toFixed(4)} is below the ${threshold} quality threshold.`}`,
        );
      } else if (!out.thresholdMet) {
        warnings.push(
          `${f.toUpperCase()}: SSIM threshold ${threshold} not reached even at the highest allowed quality (got ${out.ssim!.toFixed(4)}).`,
        );
      }
    }
    lap(`encode:${f}`);
  }

  // Optional responsive widths, built from the un-sharpened image and sharpened once
  for (const w of variantWidths) {
    const size = fitToWidth(preSharpen, w);
    let v = await deps.resize(preSharpen, size.width, size.height);
    if (settings.sharpen) v = await deps.sharpen(v, SHARPEN);
    if (!hasAlpha) forceOpaque(v);
    const vctx: EncodeContext = { ...ctx, ref: v, proxy: buildProxy(v), webpHint: undefined };
    for (const f of formats) {
      step++;
      // The size limit may have shrunk the main file; a "smaller" variant must stay smaller.
      const main = outputs.find((o) => !o.variant && o.format === f);
      if (main && v.width >= main.width) continue;
      encodeProgress(`Encoding ${w}w ${f.toUpperCase()}`);
      outputs.push(await encodeWithCap(vctx, f, true));
    }
    lap(`variant:${w}`);
  }

  let beforePreview: Uint8Array | undefined;
  if (beforePreviewSource) {
    beforePreview = await deps.encode({
      format: 'jpeg',
      image: beforePreviewSource,
      mode: { kind: 'lossy', quality: 92, chroma: '444' },
      avifSpeed: settings.avifSpeed,
    });
  }

  onProgress('Done', 1);
  return {
    status: 'done',
    warnings,
    input: inputInfo,
    processed: {
      width: work.width,
      height: work.height,
      resized,
      denoised,
      noiseSigma: Math.round(noiseSigma * 100) / 100,
      sharpened,
      kind,
      hasAlpha,
      alphaDropped: !hasAlpha && (format === 'png' || format === 'webp' || format === 'avif' || format === 'heic'),
      threshold,
    },
    outputs,
    beforePreview,
    timings,
  };
}
