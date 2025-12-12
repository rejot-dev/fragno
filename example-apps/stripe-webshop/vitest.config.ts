import { defineConfig, mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";
import tsconfigPaths from "vite-tsconfig-paths";

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [tsconfigPaths()],
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
    },
  }),
);
