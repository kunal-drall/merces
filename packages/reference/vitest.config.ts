import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@merces/sdk": src("../sdk/src/index.ts"),
      "@merces/circuits": src("../../circuits/src/index.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
