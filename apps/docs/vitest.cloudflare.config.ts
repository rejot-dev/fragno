import { mergeConfig, defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { baseConfig } from "@fragno-private/vitest-config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default mergeConfig(
  baseConfig,
  defineProject({
    plugins: [
      cloudflareTest({
        // CI is not logged into Wrangler. Disable remote bindings so Vitest
        // doesn't try to open a remote proxy session for the dispatch
        // namespace configured with `remote: true` in wrangler.jsonc.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    resolve: docsVitestResolveConfig,
    test: {
      name: "cloudflare",
      include: ["test/cloudflare/**/*.test.ts"],
      deps: {
        optimizer: {
          ssr: {
            include: ["just-bash", "@mariozechner/pi-ai", "@cloudflare/sandbox"],
          },
        },
      },
    },
  }),
);
