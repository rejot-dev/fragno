import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: [
    {
      fixedExtension: false,
      entry: "./src/index.ts",
      dts: true,
      platform: "node",
      outDir: "./dist/",
    },
  ],

  test: baseConfig.test,
});
