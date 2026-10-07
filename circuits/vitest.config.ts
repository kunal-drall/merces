import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // ffjavascript's multi-threaded curve is cached per process; one file at a time keeps it simple.
    fileParallelism: false,
  },
});
