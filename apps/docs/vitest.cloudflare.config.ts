import { mergeConfig, defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { baseConfig } from "@fragno-private/vitest-config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default mergeConfig(
  baseConfig,
  defineProject({
    plugins: [
      cloudflareTest({
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    resolve: docsVitestResolveConfig,
    test: {
      name: "cloudflare",
      include: ["test/cloudflare/**/*.test.ts"],
    },
  }),
);
