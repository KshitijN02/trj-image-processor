import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ssimulacra2 } from '../src/core/ssimulacra2';
import { buildCases, type S2Case } from './helpers/s2-cases';
import { nodeCodecs } from './helpers/node-deps';

const FIXTURE = path.resolve(__dirname, 'fixtures/ssimulacra2-reference.json');
const WRITE_DIR = process.env.S2_WRITE_PAIRS;

let cases: S2Case[];
beforeAll(async () => {
  cases = await buildCases();
});

describe.runIf(WRITE_DIR)('write SSIMULACRA 2 reference pairs', () => {
  it('writes PNG pairs + manifest for the Rust reference tool', async () => {
    fs.mkdirSync(WRITE_DIR!, { recursive: true });
    const lines: string[] = [];
    for (const [i, c] of cases.entries()) {
      const src = path.join(WRITE_DIR!, `${i}-src.png`);
      const dst = path.join(WRITE_DIR!, `${i}-dst.png`);
      fs.writeFileSync(src, await nodeCodecs.encode({ format: 'png', image: c.source, mode: { kind: 'lossless' }, avifSpeed: 6 }));
      fs.writeFileSync(dst, await nodeCodecs.encode({ format: 'png', image: c.distorted, mode: { kind: 'lossless' }, avifSpeed: 6 }));
      lines.push(`${c.id}\t${src}\t${dst}`);
    }
    fs.writeFileSync(path.join(WRITE_DIR!, 'manifest.tsv'), lines.join('\n') + '\n');
  });
});

describe.skipIf(WRITE_DIR)('SSIMULACRA 2 port', () => {
  // The fixture is produced with the Rust reference tool (scripts/ssimulacra2-reference/).
  it.skipIf(!fs.existsSync(FIXTURE))('matches the Rust reference implementation on every test pair', () => {
    const { scores } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { scores: Record<string, number> };
    expect(Object.keys(scores).length).toBe(cases.length);
    let worst = 0;
    for (const c of cases) {
      const ours = ssimulacra2(c.source, c.distorted);
      const ref = scores[c.id];
      expect(ref, c.id).toBeTypeOf('number');
      worst = Math.max(worst, Math.abs(ours - ref));
      expect(Math.abs(ours - ref), `${c.id}: ours ${ours.toFixed(4)} vs reference ${ref.toFixed(4)}`).toBeLessThan(0.05);
    }
    console.log(`max |port − reference| = ${worst.toFixed(5)} over ${cases.length} pairs`);
  });

  it('scores identical images 100', () => {
    for (const c of cases.filter((c) => c.id.endsWith('/identical'))) expect(ssimulacra2(c.source, c.distorted)).toBe(100);
  });

  it('falls as JPEG quality drops', () => {
    for (const name of ['photo', 'noisy', 'logo']) {
      const s = (q: number) => {
        const c = cases.find((c) => c.id === `${name}/jpeg-q${q}`)!;
        return ssimulacra2(c.source, c.distorted);
      };
      expect(s(85)).toBeGreaterThan(s(50));
      expect(s(50)).toBeGreaterThan(s(20));
    }
  });

  it('rejects mismatched or tiny images', () => {
    const img = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) });
    expect(() => ssimulacra2(img(16, 16), img(16, 17))).toThrow(/size mismatch/);
    expect(() => ssimulacra2(img(7, 16), img(7, 16))).toThrow(/8×8/);
  });
});
