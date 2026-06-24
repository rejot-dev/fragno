import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const resolveConfig = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    projects: [
      resolveConfig("./vitest.node.config.ts"),
      resolveConfig("./vitest.cloudflare.config.ts"),
    ],
  },
});
