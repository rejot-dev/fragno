import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: ["./src/index.ts"],
    dts: true,
    unbundle: true,
  },

  test: baseConfig.test,
});
