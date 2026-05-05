import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: ["src/index.ts", "src/macros.ts", "src/types.ts", "src/integrations/*.ts"],
  },

  test: baseConfig.test,
});
