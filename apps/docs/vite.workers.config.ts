import path from "path";

import { defineConfig } from "vite-plus";
import type { UserConfig } from "vite-plus";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig(() => {
  const plugins: unknown[] = [
    cloudflareTest({
      // CI is not logged into Wrangler. Disable remote bindings so Vitest
      // doesn't try to open a remote proxy session for the dispatch
      // namespace configured with remote: true in wrangler.jsonc.
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ];

  const config: UserConfig = {
    resolve: {
      tsconfigPaths: true,
      alias: {
        "@": path.resolve(__dirname, "./app"),
        "@/components": path.resolve(__dirname, "./app/components"),
        "@/lib": path.resolve(__dirname, "./app/lib"),
        ajv: path.resolve(__dirname, "./shims/ajv.ts"),
        "ajv-formats": path.resolve(__dirname, "./shims/ajv-formats.ts"),
        svix: path.resolve(__dirname, "./shims/svix.ts"),
        undici: path.resolve(__dirname, "./shims/undici.ts"),
      },
    },
    plugins: plugins as NonNullable<UserConfig["plugins"]>,
    test: {
      globals: true,
      include: [
        "app/**/*.workers.test.ts",
        "workers/**/*.workers.test.ts",
        "scripts/**/*.workers.test.ts",
      ],
      deps: {
        optimizer: {
          ssr: {
            include: ["just-bash", "@mariozechner/pi-ai", "@cloudflare/sandbox"],
          },
        },
      },
    },
  };

  return config;
});
