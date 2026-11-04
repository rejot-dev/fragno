import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: {
      // Bookkeeping's Durable Objects run on in-memory SQLite outside workerd; see `scenario/`.
      alias: {
        "cloudflare:workers": fileURLToPath(
          new URL("./scenario/cloudflare-workers.ts", import.meta.url),
        ),
      },
    },
    test: {
      include: ["app/**/*.test.ts", "app/**/*.test.tsx", "workers/**/*.test.ts"],
      // Node 26's built-in web storage shadows happy-dom's isolated storage in client test files.
      execArgv: ["--no-experimental-webstorage"],
      coverage: { enabled: false },
    },
  }),
);
