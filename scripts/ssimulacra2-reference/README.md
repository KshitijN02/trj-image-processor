# SSIMULACRA 2 reference scores

`src/core/ssimulacra2.ts` is a TypeScript port of the Rust `ssimulacra2` crate (v0.5.1).
This folder regenerates the reference scores it is tested against
(`tests/fixtures/ssimulacra2-reference.json`). You only need it if you change the port
or the test cases in `tests/helpers/s2-cases.ts`. The normal `npm test` doesn't need Rust.

```bash
# 1. write the test pairs as PNGs + a manifest
S2_WRITE_PAIRS=/tmp/s2pairs npx vitest run tests/ssimulacra2.test.ts
# 2. score them with the Rust reference (needs a Rust toolchain)
cargo run --release --manifest-path scripts/ssimulacra2-reference/Cargo.toml \
  < /tmp/s2pairs/manifest.tsv > /tmp/s2pairs/scores.tsv
# 3. store the scores as the fixture
node scripts/ssimulacra2-reference/to-fixture.mjs /tmp/s2pairs/scores.tsv
```
