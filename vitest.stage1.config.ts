import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** TypeScript Stage 1 regression gate, using the backend's locked test runner and linked Stage 1 dependencies. */
export default defineConfig({
  root: fileURLToPath(new URL('./stage1/', import.meta.url)),
  test: {
    include: ['packages/reference/test/**/*.test.ts', 'packages/sdk/test/**/*.test.ts', 'circuits/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/._*'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 4,
  },
});
