import path from "node:path";

import { defineProject } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-plugin";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
  plugins: [
    {
      name: "worker-bundler-wasm",
      enforce: "pre",
      resolveId(source, importer) {
        if (source === "./esbuild.wasm" && importer?.includes("@cloudflare/worker-bundler/dist/")) {
          // Resolve beside the compiler's dependency, not a duplicate Backoffice dependency.
          return path.join(path.dirname(importer), "esbuild.wasm");
        }
        return undefined;
      },
    },
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
