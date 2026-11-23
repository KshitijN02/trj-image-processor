import fs from 'node:fs';
import path from 'node:path';

export const SAMPLES = path.resolve(__dirname, '../../public/samples');
export const sample = (name: string) => new Uint8Array(fs.readFileSync(path.join(SAMPLES, name)));
