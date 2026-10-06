import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Real bridge lifecycle coverage runs explicitly, not as setup for ordinary package tests.
    exclude: ["src/**/*.bridge.test.ts"],
    testTimeout: 30_000,
  },
});
