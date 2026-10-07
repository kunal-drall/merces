import { defineConfig } from 'vitest/config';

// Three projects:
//  - unit: everything except the conformance and canary suites (fast, no DB unless MERCES_TEST_DB=1)
//  - conformance: the ChainPort behavioural suite (H2); selects the chain via CONFORMANCE_CHAIN
//  - canary: the privacy canary (H3); needs Postgres
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['packages/conformance/**', 'packages/privacy-tests/**'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'conformance',
          include: ['packages/conformance/test/**/*.test.ts'],
          testTimeout: 600_000,
          hookTimeout: 600_000,
        },
      },
      {
        test: {
          name: 'canary',
          include: ['packages/privacy-tests/test/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
