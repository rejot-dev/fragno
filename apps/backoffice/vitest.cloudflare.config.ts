import { defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-plugin";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
  plugins: [
    cloudflareTest({
      // A separate config directory keeps Wrangler from loading Backoffice's
      // local .dev.vars or .env files into the cacheable Workers tests.
      remoteBindings: false,
      wrangler: { configPath: "./tests/wrangler.vitest.jsonc" },
    }),
  ],
  resolve: docsVitestResolveConfig,
  test: {
    name: "cloudflare",
    // Late Worker/DO logs can deadlock Vitest's console RPC after all tests finish.
    // Use native workerd output (without test attribution) until cloudflare/workers-sdk#15719 is fixed.
    disableConsoleIntercept: true,
    globals: true,
    setupFiles: ["./workers/vitest-compiler-setup.ts"],
    testTimeout: 15_000,
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
