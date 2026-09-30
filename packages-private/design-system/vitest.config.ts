import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: "node",
      // Node 26's built-in web storage shadows happy-dom's isolated storage in client test files.
      execArgv: ["--no-experimental-webstorage"],
    },
  }),
);
