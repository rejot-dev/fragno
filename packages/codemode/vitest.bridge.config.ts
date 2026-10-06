import { defineConfig } from "vitest/config";

import nodeConfig from "./vitest.config";

export default defineConfig({
  ...nodeConfig,
  test: {
    ...nodeConfig.test,
    include: ["src/**/*.bridge.test.ts"],
    exclude: [],
  },
});
