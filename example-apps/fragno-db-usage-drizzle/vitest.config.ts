import { defineConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: "node",
    // Cannot watch because we'd trigger tests in an infinite loop
    watch: false,
    globalSetup: ["./src/init-tests.ts"],
  },
});
