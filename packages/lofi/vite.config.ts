import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: ["./src/mod.ts", "./src/cli/index.ts", "./src/scenario.ts"],
    dts: true,
    unbundle: true,
  },

  test: {
    ...baseConfig.test,
    environment: "node",
  },
});
