import { readFileSync } from "node:fs";
import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import devtoolsJson from "vite-plugin-devtools-json";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// Warm the Cloudflare Worker entry so the Durable Object graph is transformed
// during dev-server boot instead of on the first SSR request.
const workerWarmupFiles = ["./workers/app.ts"];
const waSqliteWasmUrl = new URL(import.meta.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm"));

function emitWaSqliteWasmAssetPlugin(): Plugin {
  return {
    name: "emit-wa-sqlite-wasm-asset",
    apply: "build",
    generateBundle() {
      if (this.environment.name !== "client") {
        return;
      }

      // The packaged OPFS worker loads this exact sibling URL but does not publish the WASM asset.
      this.emitFile({
        type: "asset",
        fileName: "assets/wa-sqlite.wasm",
        source: readFileSync(waSqliteWasmUrl),
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const isDevServer = command === "serve";

  return {
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
        viteEnvironment: {
          name: "ssr",
        },
        // inspectorPort: false,
      }),
      tailwindcss(),
      reactRouter(),
      devtoolsJson(),
      emitWaSqliteWasmAssetPlugin(),
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
      allowedHosts: [".trycloudflare.com", "local-wilco.recivo.email"],
    },
    server: {
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
