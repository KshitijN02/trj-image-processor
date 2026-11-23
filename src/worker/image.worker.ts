/// <reference lib="webworker" />
import * as Comlink from 'comlink';
import { processImage } from '../core/pipeline';
import type { ProcessReport, ProgressFn, Settings } from '../core/types';
import { browserDeps } from './browser-deps';

const api = {
  async process(name: string, buffer: ArrayBuffer, settings: Settings, onProgress?: ProgressFn): Promise<ProcessReport> {
    const report = await processImage(
      { name, bytes: new Uint8Array(buffer) },
      settings,
      browserDeps,
      onProgress ? (stage, f) => void onProgress(stage, f) : undefined,
    );
    // Transfer output buffers back instead of copying them. Duplicated buffers
    // (e.g. a pass-through file sharing the input buffer) are transferred once.
    const buffers = new Set<ArrayBuffer>();
    for (const o of report.outputs) {
      if (o.bytes.byteOffset !== 0 || o.bytes.byteLength !== o.bytes.buffer.byteLength) o.bytes = o.bytes.slice();
      buffers.add(o.bytes.buffer as ArrayBuffer);
    }
    if (report.beforePreview) buffers.add(report.beforePreview.buffer as ArrayBuffer);
    return Comlink.transfer(report, [...buffers]);
  },

  environment() {
    return {
      crossOriginIsolated: self.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    };
  },
};

export type WorkerApi = typeof api;
Comlink.expose(api);
