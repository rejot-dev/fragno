import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: "./fragno-node.ts",
    dts: true,
  },

  test: baseConfig.test,
});
