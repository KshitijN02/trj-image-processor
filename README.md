# Image Optimiser

A client-side React app for preparing travel-site images. It resizes, lightly cleans up, and converts each image to AVIF and WebP. For each format it uses the **lowest encoder quality whose result still passes an SSIM check** against the processed source, so images look the same at display size and files stay as small as possible. Nothing is uploaded: all work runs in Web Workers in the browser.

## Setup

```bash
npm install
npm run dev        # http://localhost:5173 (sends COOP/COEP headers, so codecs run multi-threaded)
npm test           # Vitest: unit tests + end-to-end pipeline tests with the real WASM codecs (~3 min)
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ with the same headers
npm run samples    # regenerate public/samples/
```

Requires Node 20+ (developed on Node 24).

**Sample images** for manual testing are in `public/samples/`. They are generated procedurally by `scripts/make-samples.mjs`, so there are no licensing issues:

| File | What it exercises |
|---|---|
| `photo.jpg` | 3000×2000 photo with EXIF (camera, **GPS**), XMP and a comment. Tests resize, sharpening and metadata stripping |
| `rotated-exif6.jpg` | 600×400 stored with EXIF orientation 6; must come out 400×600 |
| `noisy-lowlight.jpg` | dark, noisy photo; triggers auto-denoise |
| `logo.png` | flat-colour graphic; tests graphic classification, lossless/palette/4:4:4 candidates |
| `transparent.png` | soft-edged alpha; transparency must survive |
| `existing.webp`, `existing.avif` | already-compressed inputs; tests format preservation and the "≥ 5 % or keep original" rule |
| `animated.gif` | passes through unchanged with a warning |

## How the pipeline works

Each image runs in a worker from a pool of `min(hardwareConcurrency − 1, 4)` workers. Only one image above 24 MP runs at a time, so phones don't run out of memory; smaller images keep flowing past it. If a file fails, only that file's card shows the error.

0. **Admission** (main thread, header bytes only): files over 50 MB or 100 MP, and unknown formats, are rejected with a message. Animated GIF/APNG/WebP/AVIF are detected and passed through unchanged with a warning.
1. **Decode** with `createImageBitmap` + `OffscreenCanvas`. The browser applies EXIF orientation and colour-manages ICC profiles into sRGB. If that fails, the jsquash WASM decoders are used and EXIF orientation is applied in code. HEIC/HEIF is decoded by **libheif-js**, lazy-loaded only for HEIC files. (heic2any needs `document`, so it can't run in a worker.)
2. **Resize** with pica (Lanczos3) so the longest edge is at most the cap. Never upscales; the aspect ratio is kept.
3. **Auto denoise**, at output size. Noise is estimated with Immerkær's fast method, with the strongest 10 % of Sobel gradients excluded so edges and texture aren't counted as noise. Only above σ ≈ 2.8 (0–255 scale), a 3×3 bilateral filter is applied. Its range kernel scales with the measured noise and the result is blended 80/20 with the input, so fabric, wood and stone texture survives.
4. **Sharpen**, only if the image was resized: pica's unsharp mask (amount 80, radius 0.6, threshold 2).
5. **Strip data**: re-encoded files carry **no metadata** (EXIF, GPS, thumbnails, XMP and comments are all removed) and are written as sRGB. A fully opaque alpha channel is dropped; the encoders store no alpha plane.
6. **Classify** as photo or graphic, from the number of distinct colours, how much of the image the 32 most common colours cover, and flat-area ratio.
   - Photos: lossy 4:2:0.
   - Graphics: lossless WebP, lossy WebP with sharp-YUV, AVIF 4:4:4, and for the fallback a PNG (oxipng, plus median-cut ≤ 256-colour palette). The **smallest that passes** wins.

### Format rules

| Input | Output |
|---|---|
| JPEG / PNG / HEIC | AVIF + WebP (each can be switched off), plus optional fallback |
| WebP | WebP only (optionally also AVIF) |
| AVIF | AVIF only (optionally also WebP) |

The **fallback** toggle adds a progressive, trellis-quantised mozjpeg JPEG for emails, PDFs and social previews. Graphics and transparent images get an optimised PNG instead, because JPEG can't hold transparency and blurs logos.

### Adaptive quality

For every output format the encoder quality is binary-searched for the **lowest** value that passes:

| Format | Range | Encoder effort |
|---|---|---|
| AVIF | 35–80 | speed 4–6 (setting) |
| WebP | 60–92 | method 6 |
| JPEG | 65–92 | mozjpeg, progressive, trellis |

The check is ssim.js **mssim** on luma, against the processed source (after resize, denoise and sharpen, before encoding), **at the final output size** (ssim.js downsampling off). Graphics must also pass on the Cb/Cr planes. Transparent images are compared after compositing on grey, and must also pass on the alpha plane.

Speed-ups that keep the final check exact:
- WebP is searched first, and its result narrows the AVIF search to a ±8 window, which widens automatically if the answer is on the window's edge.
- For images over 1.5 MP the search runs on a **proxy mosaic**: eight 384 px tiles at full output resolution, picked at stratified levels of detail. The chosen quality is then encoded on the full image and **re-verified with full-size SSIM**; if it fails, quality steps up until it passes. Without this, one AVIF search on a 2560 px photo took over 5 minutes single-threaded; with it, about 20 s. The proxy tends to land 1–3 quality points high, so after the full-size check passes, the quality is **walked down on the full image**: q−2, then 1 at a time (at most 3 extra encodes), using the fast SSIM that comes with each encode. The final pick is re-checked with the reference SSIM. On the samples this recovered the true minimum: e.g. WebP 114.9 → 97.5 KB on the photo, and 8–10 % on the existing WebP/AVIF. It costs a few extra seconds per format.
- The search uses ssim.js's fast `bezkrovny` variant. Every chosen quality is confirmed with the default `weber` variant, and that is the SSIM shown in the UI.

If even the top of the range fails (e.g. very heavy sensor noise, which no lossy codec reproduces), the top quality is used and the card shows a warning.

### Safety rules

- A same-format output is **never larger than the input**. If re-encoding doesn't help, the original bytes are kept, labelled **"Already optimal"**, and losslessly stripped of metadata:
  - JPEG: EXIF/XMP/IPTC/comments and anything after EOI are dropped.
  - PNG: text and time chunks are dropped.
  - WebP: EXIF/XMP chunks are dropped.
  - In all three the ICC profile is kept, because removing it would shift colours. A rotated image keeps a 26-byte orientation-only EXIF so it still displays upright.
  - AVIF originals are kept as they are, because rewriting ISOBMFF item offsets is not implemented. The card warns if such a file still contains metadata.
- A WebP/AVIF input that is already within the cap must shrink by at least **5 %**, or the original is kept, to avoid generation loss.
- Never upscales, never changes the aspect ratio.

### File size limit (optional, off by default)

Turn on **"Allow a quality compromise to stay under a size limit"** (default 50 KB, adjustable 5–5000 KB; 1 KB = 1000 bytes, so 50 KB is also under 50 KiB). Every output file, responsive variants included, is then guaranteed to fit:

1. The normal SSIM-safe encode runs first. If it already fits, it is used unchanged.
2. Otherwise the dimensions stay the same and the **highest** quality that fits is chosen, even below the SSIM threshold. The floors are AVIF 20, WebP 30, JPEG 35; for PNG the palette drops to 128 → 64 → … → 8 colours.
3. If even the floor is too big, the image is **downscaled** (aspect ratio kept, re-sharpened) by an estimated ratio and step 2 repeats until it fits. Below those floors, a smaller image looks better than heavy compression artefacts.

Capped files get a **size-capped** badge, and a warning lists the quality and size used and the resulting SSIM. Animated pass-through files can't be reduced; they get a warning if they're over the limit. A same-format original larger than the limit is never kept as "Already optimal".

### Responsive sizes (optional)

Exports 400/800/1600 px widths (only those smaller than the processed image) in the same formats with the same adaptive quality, e.g. `hotel-800.avif`. Each card shows a copyable `<picture>` snippet, and the ZIP includes `picture-snippets.html`.

## Settings and defaults

| Setting | Default | Options |
|---|---|---|
| Longest edge cap | 2560 px | 1920 / 2560 / 3000 |
| Quality safety (min SSIM photo / graphic) | Standard (0.985 / 0.99) | High (0.99 / 0.994), Maximum (0.995 / 0.997) |
| Denoise | Auto | Auto / Off |
| Sharpen after resize | On | On / Off |
| Output formats (JPEG/PNG/HEIC inputs) | AVIF + WebP | either or both |
| JPEG fallback | Off | |
| Also create the other modern format (WebP/AVIF inputs) | Off | |
| Responsive sizes | Off | |
| AVIF speed | 6 | 4 / 5 / 6 |
| File size limit | Off | on: 50 KB default, 5–5000 KB |

Settings are remembered in `localStorage`. Changing them shows a "Re-process with new settings" prompt. Output files are named `originalname-<width>.<ext>`.

## Browser support

- **Processing** needs module workers, WebAssembly and `OffscreenCanvas`: current Chrome/Edge, Firefox and Safari 16.4+.
- **Multi-threaded AVIF/oxipng** need `SharedArrayBuffer`, which needs cross-origin isolation (the COOP/COEP headers below). Without them the app automatically falls back to single-threaded codecs (slower, same output); the header badge shows which mode is active.
- **Displaying AVIF**: not supported on **iOS/iPadOS 15 and earlier** or very old browsers. Serve with `<picture>` (AVIF → WebP → img fallback), as in the generated snippet.
- **Emails, PDFs, social share previews** (Open Graph) often don't accept AVIF or even WebP: keep the JPEG fallback for those.
- HEIC decoding uses libheif-js (LGPL-3.0), loaded only when a HEIC file is added.

## Deployment

It's a static site: `npm run build` and serve `dist/`. For multi-threading, the host must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

- **Vercel**: `vercel.json` sets the headers and build settings. Import the repo, or run `npx vercel`.
- **Netlify**: `netlify.toml` sets the build; `public/_headers` (copied into `dist/`) sets the headers. The same `_headers` file works on Cloudflare Pages.
- Other hosts: add the two headers to every response. Note `require-corp` blocks cross-origin resources without CORP/CORS headers; the app itself loads none.

## Project layout

```
src/core/        pure pipeline logic, no DOM (unit-tested in Node)
  pipeline.ts    orchestration of steps 1–6, adaptive encoding, safety rules
  sniff.ts       format/dimension/animation detection from bytes
  limits.ts      size / megapixel admission
  resize.ts      cap maths (no upscaling, aspect ratio)
  orientation.ts EXIF orientation parse + pixel transform
  metadata.ts    lossless JPEG/PNG/WebP stripping, metadata inventory
  noise.ts       Immerkær estimate + bilateral denoise
  classify.ts    photo vs graphic
  quantize.ts    median-cut palette
  score.ts       SSIM (luma, chroma, alpha)
  search.ts      binary / windowed quality search
  proxy.ts       search proxy mosaic
  formats.ts     format rules;  decide.ts  keep-original rules;  naming.ts  file names + <picture>
                 (size-limit fitting lives in pipeline.ts: fitToBudget)
src/worker/      codec adapter (jsquash), browser decode/resize, Comlink worker
src/app/         worker pool with large-image guard, item state
src/components/  Dropzone, SettingsPanel, FileCard, CompareSlider, Summary
tests/           Vitest; pipeline tests run the real jsquash WASM codecs in Node
```

## Known limitations (v1)

- Animated images pass through untouched.
- AVIF originals kept as "Already optimal" retain any embedded metadata (flagged on the card).
- WebP lossy is always 4:2:0. For graphics, sharp-YUV and lossless WebP are tried instead.
- Very noisy photos may not reach the SSIM threshold at any allowed quality. They are output at the top of the range with a warning.
- Wide-gamut (P3) sources are converted to sRGB, as intended for the web.
