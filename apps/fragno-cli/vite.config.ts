import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: "./src/cli.ts",
    dts: true,
  },

  test: {
    ...baseConfig.test,
    coverage: {
      ...baseConfig.test.coverage,
      enabled: false,
    },
  },
});
