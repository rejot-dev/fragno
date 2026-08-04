import { defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
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
    globals: true,
    include: ["app/**/*.cloudflare.test.ts", "workers/**/*.cloudflare.test.ts"],
    deps: {
      optimizer: {
        ssr: {
          include: ["just-bash", "@earendil-works/pi-ai", "@cloudflare/sandbox"],
        },
      },
    },
  },
});
