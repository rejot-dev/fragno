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
      include: ["app/**/*.test.ts", "workers/**/*.test.ts"],
      coverage: { enabled: false },
    },
  }),
);
