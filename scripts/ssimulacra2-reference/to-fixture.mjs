// Converts the Rust tool's "<id>\t<score>" output into tests/fixtures/ssimulacra2-reference.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , scoresPath] = process.argv;
const scores = Object.fromEntries(
  fs.readFileSync(scoresPath, 'utf8').trim().split('\n').map((l) => {
    const [id, s] = l.split('\t');
    return [id, Number(s)];
  }),
);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ssimulacra2-reference.json');
fs.writeFileSync(out, JSON.stringify({ reference: 'rust ssimulacra2 0.5.1', scores }, null, 2) + '\n');
console.log(`wrote ${Object.keys(scores).length} scores to ${out}`);
