import * as Comlink from 'comlink';
import type { WorkerApi } from '../worker/image.worker';
import { WorkerPool } from './pool';

export type RemoteApi = Comlink.Remote<WorkerApi>;

let pool: WorkerPool<RemoteApi> | null = null;

/** The pool is created on first use, so an idle page spawns no workers and loads no WASM. */
export function getPool(): WorkerPool<RemoteApi> {
  if (!pool) {
    pool = new WorkerPool<RemoteApi>(() => {
      const worker = new Worker(new URL('../worker/image.worker.ts', import.meta.url), {
        type: 'module',
        name: 'image-worker',
      });
      return {
        api: Comlink.wrap<WorkerApi>(worker),
        onCrash: (cb) => {
          worker.addEventListener('error', (e) => cb(new Error(e.message || 'The image worker crashed (possibly out of memory).')));
          worker.addEventListener('messageerror', () => cb(new Error('Worker message could not be deserialised.')));
        },
        terminate: () => worker.terminate(),
      };
    });
  }
  return pool;
}
