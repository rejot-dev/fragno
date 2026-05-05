import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: [
    {
      fixedExtension: false,
      entry: "./src/mod.ts",
      dts: true,
      platform: "node",
      outDir: "./dist",
    },
  ],

  test: {
    ...baseConfig.test,
    environment: "node",
    // Cannot watch because we'd trigger tests in an infinite loop
    watch: false,
    globalSetup: ["./src/init-tests.ts"],
  },
});
