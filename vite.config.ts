/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Cross-origin isolation lets SharedArrayBuffer work, which multi-threaded
// AVIF/oxipng need. The same headers are in vercel.json and public/_headers
// for production.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // GitHub Pages serves project sites from /<repo-name>/; the deploy workflow sets
  // BASE_PATH. Everywhere else (dev, Netlify, Vercel) the app lives at the root.
  base: process.env.BASE_PATH || '/',
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    // jsquash packages load their .wasm files via `new URL(..., import.meta.url)`.
    // Pre-bundling breaks those relative URLs, so they must be excluded.
    exclude: [
      '@jsquash/avif',
      '@jsquash/webp',
      '@jsquash/jpeg',
      '@jsquash/png',
      '@jsquash/oxipng',
      'libheif-js',
    ],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // The pipeline tests run real WASM encoders on multi-megapixel images. Running
    // several of those files in parallel thrashes memory on 8 GB machines and is
    // far slower than running them one after another.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
