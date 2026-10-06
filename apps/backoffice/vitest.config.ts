import { fileURLToPath } from "node:url";

import { defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

const resolveConfig = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Turbo runs other package suites concurrently; leave CPU capacity for them.
      maxWorkers: "50%",
      coverage: {
        enabled: false,
        reportsDirectory: "./coverage",
        reporter: ["text", "html", "json"],
      },
      projects: [
        resolveConfig("./vitest.node.config.ts"),
        resolveConfig("./vitest.cloudflare.config.ts"),
      ],
    },
  }),
);
