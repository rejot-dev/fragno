import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
    },
    projects: ["./vitest.node.config.ts", "./vitest.cloudflare.config.ts"],
  },
});
