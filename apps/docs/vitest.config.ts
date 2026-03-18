import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeConfig } from "vitest/config";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { baseConfig } from "@fragno-private/vitest-config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default mergeConfig(baseConfig, {
  plugins: [
    cloudflareTest({
      // CI is not logged into Wrangler. Disable remote bindings so Vitest
      // doesn't try to open a remote proxy session for the dispatch
      // namespace configured with `remote: true` in wrangler.docs.jsonc.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.docs.jsonc" },
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${path.resolve(rootDir, "app")}/`,
      },
      {
        find: "ajv",
        replacement: path.resolve(rootDir, "shims/ajv.ts"),
      },
      {
        find: "ajv-formats",
        replacement: path.resolve(rootDir, "shims/ajv-formats.ts"),
      },
      {
        find: "svix",
        replacement: path.resolve(rootDir, "shims/svix.ts"),
      },
      {
        find: "undici",
        replacement: path.resolve(rootDir, "shims/undici.ts"),
      },
    ],
  },
  test: {
    deps: {
      optimizer: {
        ssr: {
          include: ["just-bash", "@mariozechner/pi-ai", "@cloudflare/sandbox"],
        },
      },
    },
    coverage: {
      enabled: false,
    },
  },
});
