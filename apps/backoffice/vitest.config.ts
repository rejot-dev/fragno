import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

const resolveConfig = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        enabled: false,
      },
      projects: [
        resolveConfig("./vitest.node.config.ts"),
        resolveConfig("./vitest.cloudflare.config.ts"),
      ],
    },
  }),
);
