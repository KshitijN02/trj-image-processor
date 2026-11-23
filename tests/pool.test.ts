import { describe, expect, it } from 'vitest';
import { defaultPoolSize, WorkerPool, type PoolWorker } from '../src/app/pool';

function fakeWorkers() {
  const crashers: ((e: Error) => void)[] = [];
  const create = (): PoolWorker<{ id: number }> => ({
    api: { id: crashers.length },
    onCrash: (cb) => crashers.push(cb),
    terminate: () => {},
  });
  return { create, crashers };
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('worker pool', () => {
  it('sizes to min(hardwareConcurrency - 1, 4), at least 1', () => {
    expect(defaultPoolSize(1)).toBe(1);
    expect(defaultPoolSize(2)).toBe(1);
    expect(defaultPoolSize(4)).toBe(3);
    expect(defaultPoolSize(16)).toBe(4);
  });

  it('runs at most one >24 MP image at a time, letting small ones pass', async () => {
    const { create } = fakeWorkers();
    const pool = new WorkerPool(create, 3);
    let running = 0, maxLarge = 0, runningLarge = 0;
    const gates: ReturnType<typeof deferred>[] = [];
    const order: string[] = [];
    const job = (label: string, mp: number) =>
      pool.run(mp, async () => {
        const g = deferred();
        gates.push(g);
        running++;
        if (mp > 24) maxLarge = Math.max(maxLarge, ++runningLarge);
        order.push(label);
        await g.promise;
        if (mp > 24) runningLarge--;
        running--;
      });
    const all = [job('L1', 40), job('L2', 30), job('s1', 2), job('s2', 3)];
    await tick();
    expect(order).toEqual(['L1', 's1', 's2']); // L2 waits; smalls overtake it
    while (gates.length) {
      gates.shift()!.resolve();
      await tick();
    }
    await Promise.all(all);
    expect(maxLarge).toBe(1);
    expect(order).toContain('L2');
    expect(running).toBe(0);
  });

  it('a failing job does not stop the batch', async () => {
    const { create } = fakeWorkers();
    const pool = new WorkerPool(create, 1);
    const results = await Promise.allSettled([
      pool.run(1, async () => { throw new Error('boom'); }),
      pool.run(1, async () => 'ok'),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });

  it('a crashed worker fails its job, is replaced, and the queue continues', async () => {
    const { create, crashers } = fakeWorkers();
    const pool = new WorkerPool(create, 1);
    const hang = pool.run(1, () => new Promise(() => {}));
    const next = pool.run(1, async (api) => api.id);
    await tick();
    crashers[0](new Error('out of memory'));
    await expect(hang).rejects.toThrow('out of memory');
    await expect(next).resolves.toBe(1); // ran on the replacement worker
  });
});
