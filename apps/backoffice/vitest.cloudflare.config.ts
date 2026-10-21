import type { Plugin } from "vite";
import { defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-plugin";

import { docsVitestResolveConfig } from "./vitest.shared";

/**
 * Tells `workers/vitest-console-setup.ts` whether Vitest discards console output. The resolved
 * `silent` option includes `--silent` from the command line, which a static `test.provide` entry
 * could not see.
 */
function silentConsole(): Plugin {
  return {
    name: "backoffice:silent-console",
    configureVitest({ project, vitest }) {
      const provide = project.provide as (key: string, value: boolean) => void;
      provide("backofficeConsoleSilent", vitest.config.silent === true);
    },
  };
}

export default defineProject({
  plugins: [
    cloudflareTest({
      // A separate config directory keeps Wrangler from loading Backoffice's
      // local .dev.vars or .env files into the cacheable Workers tests.
      remoteBindings: false,
      wrangler: { configPath: "./tests/wrangler.vitest.jsonc" },
    }),
    silentConsole(),
  ],
  resolve: docsVitestResolveConfig,
  test: {
    name: "cloudflare",
    // Late Worker/DO logs can deadlock Vitest's console RPC after all tests finish.
    // Use native workerd output (without test attribution) until cloudflare/workers-sdk#15719 is fixed.
    // Native output ignores `silent`; `vitest-console-setup.ts` applies it inside workerd.
    disableConsoleIntercept: true,
    globals: true,
    setupFiles: ["./workers/vitest-console-setup.ts", "./workers/vitest-compiler-setup.ts"],
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
