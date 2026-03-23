import { mergeConfig, defineProject } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default mergeConfig(
  baseConfig,
  defineProject({
    resolve: docsVitestResolveConfig,
    test: {
      name: "node",
      environment: "node",
      include: ["app/**/*.test.ts", "workers/**/*.test.ts", "scripts/**/*.test.ts"],
    },
  }),
);
