import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import devtoolsJson from "vite-plugin-devtools-json";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

import { emitWaSqliteWasmAssetPlugin } from "./scripts/node-server/vite-wa-sqlite-wasm-asset";

// Warm the public Worker entry during dev-server boot instead of on the first SSR request.
const workerWarmupFiles = ["./workers/app.ts"];
const localViteHost = "127.0.0.1";

function emitWorkerLocalDevVarsPlugin(): Plugin {
  const localDevVarsPath = path.resolve(__dirname, ".dev.vars");

  return {
    name: "emit-worker-local-dev-vars",
    apply: "build",
    generateBundle(_, bundle) {
      if (!existsSync(localDevVarsPath)) {
        return;
      }

      const environmentName = this.environment.name;
      if (environmentName !== "ssr" && environmentName !== "rejot_backoffice") {
        return;
      }

      // Preview resolves .dev.vars beside each generated Wrangler config, not from the source root.
      // Every Worker gets the whole file so local overrides apply uniformly; the copies stay in
      // gitignored build output and are never uploaded on deploy.
      const localDevVars = readFileSync(localDevVarsPath, "utf8");
      const devVarsAsset = bundle[".dev.vars"];
      if (devVarsAsset?.type === "asset") {
        devVarsAsset.source = localDevVars;
      } else {
        this.emitFile({ type: "asset", fileName: ".dev.vars", source: localDevVars });
      }
    },
  };
}

export default defineConfig(({ command }) => {
  const isDevServer = command === "serve";

  return {
    define: {
      "import.meta.env.BACKOFFICE_TARGET": JSON.stringify("cloudflare"),
    },
    resolve: {
      tsconfigPaths: true,
      dedupe: ["react", "react-dom", "react-router"],
      alias: {
        "@/components": path.resolve(__dirname, "./app/components"),
        "@/lib": path.resolve(__dirname, "./app/lib"),
        ajv: path.resolve(__dirname, "./shims/ajv.ts"),
        "ajv-formats": path.resolve(__dirname, "./shims/ajv-formats.ts"),
        undici: path.resolve(__dirname, "./shims/undici.ts"),
      },
    },
    plugins: [
      cloudflare({
        configPath: "./wrangler.web.jsonc",
        auxiliaryWorkers: [
          { configPath: "./wrangler.jsonc" },
          {
            configPath: "../cf-sandbox-bridge/wrangler.jsonc",
            // Compilation does not need the bridge's Sandbox containers.
            config(workerConfig) {
              workerConfig.dev.enable_containers = false;
            },
          },
        ],
        viteEnvironment: {
          name: "ssr",
        },
        // inspectorPort: false,
      }),
      tailwindcss(),
      reactRouter(),
      devtoolsJson(),
      emitWaSqliteWasmAssetPlugin(),
      emitWorkerLocalDevVarsPlugin(),
    ],
    ssr: {
      noExternal: ["@earendil-works/pi-ai"],
    },
    environments: isDevServer
      ? {
          ssr: {
            dev: {
              preTransformRequests: true,
            },
          },
        }
      : undefined,
    preview: {
      host: localViteHost,
      port: 5173,
      strictPort: true,
      allowedHosts: [".trycloudflare.com", "local-wilco.recivo.email"],
    },
    server: {
      host: localViteHost,
      port: 5173,
      strictPort: true,
      hmr: false,
      allowedHosts: ["local-wilco.recivo.email"],
      // Tunnel/proxy layers were caching /@fs workspace modules and preserving stale
      // Vite dep hashes across restarts, which can split React between old/new chunks.
      headers: isDevServer
        ? {
            "Cache-Control": "no-store",
          }
        : undefined,
      warmup: isDevServer
        ? {
            ssrFiles: workerWarmupFiles,
          }
        : undefined,
    },
  };
});
