import { EXT, MIME } from './settings';
import type { OutputFile, OutputFormat } from './types';

/** "Hotel Lobby (1).JPG" → "hotel-lobby-1" */
export function baseName(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const slug = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'image';
}

export function outputName(fileName: string, width: number, format: OutputFormat): string {
  return `${baseName(fileName)}-${width}.${EXT[format]}`;
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * Builds a ready-to-copy <picture> element: one <source> per modern format
 * (AVIF first, since browsers take the first type they support), and an <img>
 * pointing at the most compatible file.
 */
export function pictureSnippet(outputs: OutputFile[], alt = '', sizes = '100vw'): string {
  const byFormat = new Map<OutputFormat, OutputFile[]>();
  for (const o of outputs) {
    if (o.format === 'gif') continue; // animated pass-through: no <picture> needed
    const list = byFormat.get(o.format) ?? [];
    list.push(o);
    byFormat.set(o.format, list);
  }
  if (byFormat.size === 0) return '';
  for (const list of byFormat.values()) list.sort((a, b) => a.width - b.width);
  const srcset = (list: OutputFile[]) => list.map((o) => `${o.name} ${o.width}w`).join(', ');
  const multi = [...byFormat.values()].some((l) => l.length > 1);

  const fallbackFormat = (['jpeg', 'png', 'webp', 'avif'] as const).find((f) => byFormat.has(f))!;
  const fallbackList = byFormat.get(fallbackFormat)!;
  const largest = fallbackList[fallbackList.length - 1];

  const lines = ['<picture>'];
  for (const f of ['avif', 'webp'] as const) {
    const list = byFormat.get(f);
    if (!list || f === fallbackFormat) continue;
    const sizesAttr = multi ? ` sizes="${escapeAttr(sizes)}"` : '';
    lines.push(`  <source type="${MIME[f]}" srcset="${srcset(list)}"${sizesAttr}>`);
  }
  const imgSrcset = multi ? `\n       srcset="${srcset(fallbackList)}"\n       sizes="${escapeAttr(sizes)}"` : '';
  lines.push(
    `  <img src="${largest.name}"${imgSrcset}\n       width="${largest.width}" height="${largest.height}" alt="${escapeAttr(alt)}" loading="lazy" decoding="async">`,
  );
  lines.push('</picture>');
  return lines.join('\n');
}
