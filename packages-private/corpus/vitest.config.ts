import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig(
  mergeConfig(baseConfig, {
    test: {
      globalSetup: "./src/test-setup.ts",
      coverage: {
        enabled: false,
      },
    },
  }),
);
