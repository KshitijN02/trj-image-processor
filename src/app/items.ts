import type { InputFormat, ProcessReport } from '../core/types';

export type ItemStatus = 'queued' | 'processing' | 'done' | 'error' | 'rejected';

export interface Item {
  id: string;
  file: File;
  status: ItemStatus;
  stage: string;
  progress: number;
  error?: string;
  format?: InputFormat;
  width?: number;
  height?: number;
  report?: ProcessReport;
  /** Object URLs, parallel to report.outputs. */
  outputUrls: string[];
  beforeUrl?: string;
  /** Settings fingerprint the current result was produced with. */
  settingsKey?: string;
}

/** Formats every browser we target can show in an <img> (HEIC needs a preview). */
export const DISPLAYABLE: InputFormat[] = ['jpeg', 'png', 'webp', 'avif', 'gif'];

export function revokeItemUrls(item: Item) {
  for (const u of item.outputUrls) URL.revokeObjectURL(u);
  if (item.beforeUrl) URL.revokeObjectURL(item.beforeUrl);
}
