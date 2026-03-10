import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import { baseConfig } from "@fragno-private/vitest-config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineWorkersConfig(
  mergeConfig(baseConfig, {
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
          find: "undici",
          replacement: path.resolve(rootDir, "shims/undici.ts"),
        },
      ],
    },
    test: {
      deps: {
        optimizer: {
          ssr: {
            include: [
              "just-bash",
              "turndown",
              "@mariozechner/pi-ai",
              "@cloudflare/sandbox",
              "@cloudflare/containers",
            ],
          },
        },
      },
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
        },
      },
      coverage: {
        enabled: false,
      },
    },
  }),
);
