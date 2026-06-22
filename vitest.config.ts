import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // We import .js paths everywhere (ESM-style), tsx/vitest handle the resolution.
    globals: false,
    testTimeout: 10_000,
  },
});
