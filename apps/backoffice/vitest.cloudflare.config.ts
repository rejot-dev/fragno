import { mergeConfig, defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { baseConfig } from "@fragno-private/vitest-config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default mergeConfig(
  baseConfig,
  defineProject({
    plugins: [
      cloudflareTest({
        // Keep the Workers pool on a minimal test-only Wrangler config so it
        // does not import the full app worker and every production binding for
        // each Cloudflare test file.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.vitest.jsonc" },
      }),
    ],
    resolve: docsVitestResolveConfig,
    test: {
      name: "cloudflare",
      coverage: {
        enabled: false,
      },
      include: ["app/**/*.cloudflare.test.ts", "workers/**/*.cloudflare.test.ts"],
      deps: {
        optimizer: {
          ssr: {
            include: ["just-bash", "@earendil-works/pi-ai", "@cloudflare/sandbox"],
          },
        },
      },
    },
  }),
);
