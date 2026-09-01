import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import devtoolsJson from "vite-plugin-devtools-json";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

// Warm the public Worker entry during dev-server boot instead of on the first SSR request.
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

const webWorkerLocalDevVarNames = [
  "BACKOFFICE_INTERNAL_REQUEST_SECRET",
  "AUTH_EMAIL_VERIFICATION_ENABLED",
  "DOCS_PUBLIC_BASE_URL",
] as const;

function selectLocalDevVars(source: string, names: readonly string[]): string {
  const assignments = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const name = line.slice(0, separatorIndex).trim();
    if (names.includes(name)) {
      assignments.set(name, line);
    }
  }

  const selectedAssignments: string[] = [];
  const missingNames: string[] = [];
  for (const name of names) {
    const assignment = assignments.get(name);
    if (assignment === undefined) {
      missingNames.push(name);
    } else {
      selectedAssignments.push(assignment);
    }
  }
  if (missingNames.length > 0) {
    throw new Error(
      `Backoffice local dev vars missing required web Worker values: ${missingNames.join(", ")}`,
    );
  }

  return `${selectedAssignments.join("\n")}\n`;
}

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

      const localDevVars = readFileSync(localDevVarsPath, "utf8");
      // Preview resolves .dev.vars beside each generated Wrangler config, not from the source root.
      const emittedDevVars =
        environmentName === "ssr"
          ? selectLocalDevVars(localDevVars, webWorkerLocalDevVarNames)
          : localDevVars;
      const devVarsAsset = bundle[".dev.vars"];
      if (devVarsAsset?.type === "asset") {
        devVarsAsset.source = emittedDevVars;
      } else {
        this.emitFile({ type: "asset", fileName: ".dev.vars", source: emittedDevVars });
      }
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
        configPath: "./wrangler.web.jsonc",
        auxiliaryWorkers: [{ configPath: "./wrangler.jsonc" }],
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
      port: 5173,
      strictPort: true,
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
