import { LARGE_IMAGE_MEGAPIXELS } from '../core/settings';

/*
 * Worker pool with a memory guard: at most one "large" (> 24 MP) image runs at
 * a time. Small images keep flowing past a waiting large one. A worker that
 * dies (e.g. out of memory) fails only its own job and is replaced.
 */

export interface PoolWorker<Api> {
  api: Api;
  /** Registers a callback for fatal worker errors. */
  onCrash(cb: (err: Error) => void): void;
  terminate(): void;
}

interface Job<Api, T> {
  megapixels: number;
  task: (api: Api) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

interface Slot<Api> {
  worker: PoolWorker<Api>;
  job: Job<Api, unknown> | null;
}

export function defaultPoolSize(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 2): number {
  return Math.max(1, Math.min(hardwareConcurrency - 1, 4));
}

export class WorkerPool<Api> {
  private slots: Slot<Api>[] = [];
  private queue: Job<Api, unknown>[] = [];
  private largeRunning = 0;

  constructor(
    private readonly createWorker: () => PoolWorker<Api>,
    size = defaultPoolSize(),
    private readonly largeThreshold = LARGE_IMAGE_MEGAPIXELS,
  ) {
    for (let i = 0; i < size; i++) this.slots.push(this.makeSlot());
  }

  get size() {
    return this.slots.length;
  }

  run<T>(megapixels: number, task: (api: Api) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ megapixels, task, resolve, reject } as Job<Api, unknown>);
      this.pump();
    });
  }

  /** Drops queued (not yet running) jobs. */
  clearQueue(reason = 'Cancelled') {
    const q = this.queue;
    this.queue = [];
    for (const j of q) j.reject(new Error(reason));
  }

  terminate() {
    this.clearQueue('Pool terminated');
    for (const s of this.slots) s.worker.terminate();
    this.slots = [];
  }

  private makeSlot(): Slot<Api> {
    const slot: Slot<Api> = { worker: this.createWorker(), job: null };
    slot.worker.onCrash((err) => {
      const job = slot.job;
      if (job) this.finish(slot, job);
      slot.worker.terminate();
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots[i] = this.makeSlot();
      job?.reject(err);
      this.pump();
    });
    return slot;
  }

  private isLarge(job: Job<Api, unknown>) {
    return job.megapixels > this.largeThreshold;
  }

  private finish(slot: Slot<Api>, job: Job<Api, unknown>) {
    if (slot.job !== job) return false;
    slot.job = null;
    if (this.isLarge(job)) this.largeRunning--;
    return true;
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.job) continue;
      const idx = this.queue.findIndex((j) => !this.isLarge(j) || this.largeRunning === 0);
      if (idx < 0) return;
      const [job] = this.queue.splice(idx, 1);
      slot.job = job;
      if (this.isLarge(job)) this.largeRunning++;
      job
        .task(slot.worker.api)
        .then(
          (v) => this.finish(slot, job) && job.resolve(v),
          (e) => this.finish(slot, job) && job.reject(e),
        )
        .finally(() => this.pump());
    }
  }
}
