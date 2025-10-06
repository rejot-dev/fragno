import { defineConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: "node",
  },
});
