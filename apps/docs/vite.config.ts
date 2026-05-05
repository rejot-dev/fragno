import { writeFileSync } from "node:fs";
import { join } from "node:path";
import path from "path";

import { reactRouter } from "@react-router/dev/vite";
import mdx from "fumadocs-mdx/vite";
import devtoolsJson from "vite-plugin-devtools-json";
import { coverageConfigDefaults, defineConfig } from "vite-plus";
import type { Plugin, UserConfig } from "vite-plus";

import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import tailwindcss from "@tailwindcss/vite";

import * as MdxConfig from "./source.config";

const fumadocsDeps = [
  "fumadocs-ui/components/callout",
  "fumadocs-ui/components/steps",
  "fumadocs-ui/components/card",
  "fumadocs-ui/components/type-table",
  "fumadocs-ui/components/codeblock",
  "fumadocs-ui/components/tabs",
  "fumadocs-ui/components/dynamic-codeblock",
  "fumadocs-ui/components/ui/popover",
  "fumadocs-ui/contexts/search",
  "fumadocs-ui/layouts/home",
  "fumadocs-ui/layouts/docs",
  "fumadocs-ui/page",
  "fumadocs-ui/provider/react-router",
  "fumadocs-ui/utils/use-copy-button",
  "fumadocs-core/highlight/client",
  "hast-util-to-jsx-runtime",
  "lucide-react",
  "@marsidev/react-turnstile",
];

// Warm the Cloudflare worker entry so the Durable Object graph is transformed
// during dev-server boot instead of on the first SSR request.
const workerWarmupFiles = ["./workers/app.ts"];

export default defineConfig(async ({ mode }) => {
  const isDev = mode === "development";
  const isVitest = process.env["VITEST"] === "true";
  const plugins: unknown[] = [await mdx(MdxConfig)];

  if (!isVitest) {
    plugins.push(cloudflare({ viteEnvironment: { name: "ssr" } }));
    plugins.push(
      cloudflareTest({
        // CI is not logged into Wrangler. Disable remote bindings so Vitest
        // doesn't try to open a remote proxy session for the dispatch
        // namespace configured with remote: true in wrangler.jsonc.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    );
  }

  plugins.push(tailwindcss(), reactRouter(), devtoolsJson());
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
    optimizeDeps: isDev
      ? {
          include: fumadocsDeps,
        }
      : undefined,
    ssr: {
      ...(isDev
        ? {
            optimizeDeps: {
              include: fumadocsDeps,
            },
          }
        : {}),
      noExternal: ["@mariozechner/pi-ai"],
    },
    environments: isDev
      ? {
          ssr: {
            dev: {
              preTransformRequests: true,
            },
          },
        }
      : undefined,
    server: {
      allowedHosts: ["local-wilco.recivo.email"],
      // Tunnel/proxy layers were caching /@fs workspace modules and preserving stale
      // Vite dep hashes across restarts, which can split React between old/new chunks.
      headers: isDev
        ? {
            "Cache-Control": "no-store",
          }
        : undefined,
      warmup: isDev
        ? {
            ssrFiles: workerWarmupFiles,
          }
        : undefined,
    },
    test: {
      globals: true,
      environment: "node",
      include: [
        "app/**/*.test.ts",
        "app/**/*.test.tsx",
        "workers/**/*.test.ts",
        "workers/**/*.test.tsx",
        "scripts/**/*.test.ts",
        "scripts/**/*.test.tsx",
      ],
      exclude: ["**/*.workers.test.ts"],
      deps: {
        optimizer: {
          ssr: {
            include: ["just-bash", "@mariozechner/pi-ai", "@cloudflare/sandbox"],
          },
        },
      },
      coverage: {
        provider: "istanbul",
        exclude: ["templates/**", ...coverageConfigDefaults.exclude],
        reporter: [["json", { file: "../coverage.json" }]],
        enabled: false,
      },
    },
  };
  return config;
});

// oxlint-disable-next-line no-unused-vars
function environmentInfoPlugin(): Plugin {
  return {
    name: "environment-info",
    configResolved(config) {
      const envInfo: Record<string, unknown> = {
        root: config.root,
        mode: config.mode,
        command: config.command,
        environments: {},
      };

      // Collect environment information
      for (const [name, env] of Object.entries(config.environments)) {
        (envInfo.environments as Record<string, unknown>)[name] = {
          resolve: {
            conditions: env.resolve.conditions,
            externalConditions: env.resolve.externalConditions,
            mainFields: env.resolve.mainFields,
          },
          build: {
            outDir: env.build.outDir,
            sourcemap: env.build.sourcemap,
            minify: env.build.minify,
            target: env.build.target,
          },
          consumer: env.consumer,
        };
      }

      const outputPath = join(config.root, "vite-environments.json");
      writeFileSync(outputPath, JSON.stringify(envInfo, null, 2), "utf-8");
      console.log("\\nEnvironment info written to: " + outputPath + "\\n");
    },
  };
}
