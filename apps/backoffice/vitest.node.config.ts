import { defineProject } from "vitest/config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
  resolve: docsVitestResolveConfig,
  test: {
    name: "node",
    environment: "node",
    globals: true,
    include: [
      "*.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "workers/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["app/**/*.cloudflare.test.ts", "workers/**/*.cloudflare.test.ts"],
  },
});
