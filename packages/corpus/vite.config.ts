import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: "./src/index.ts",
    dts: true,
    outDir: "./dist",
    copy: [{ from: "src/subjects", to: "dist/subjects" }],
  },

  test: {
    ...baseConfig.test,
    globalSetup: "./src/test-setup.ts",
    coverage: {
      ...baseConfig.test.coverage,
      enabled: false,
    },
  },
});
