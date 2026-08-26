import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import devtoolsJson from "vite-plugin-devtools-json";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

import { BACKOFFICE_WORKER_TOPOLOGY } from "./backoffice-worker-topology";
import { reactRouterServerBundleVitePlugin } from "./scripts/react-router-server-bundle-vite-plugin";
import { getReactRouterWorkerEntries } from "./workers/react-router-worker-routing";

// Warm the Cloudflare worker entry so the Durable Object graph is transformed
// during dev-server boot instead of on the first SSR request.
const workerWarmupFiles = ["./workers/backoffice-development-worker.ts"];
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
  if (!isDevServer) {
    rmSync(path.resolve(__dirname, "./dist"), { recursive: true, force: true });
  }

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
        config: function configureBackofficeEntryWorker() {
          if (isDevServer) {
            return {
              main: "./workers/backoffice-development-worker.ts",
            };
          }

          return {
            services: getReactRouterWorkerEntries().map(([, worker]) => ({
              binding: worker.serviceBinding,
              service: worker.name,
            })),
            secrets: {
              required: [...BACKOFFICE_WORKER_TOPOLOGY.entryWorker.environment.secrets.required],
            },
          };
        },
        auxiliaryWorkers: isDevServer
          ? []
          : getReactRouterWorkerEntries().map(([bundleId, worker]) => ({
              viteEnvironment: {
                name: `routes_${bundleId}`,
                childEnvironments: [`ssrBundle_${bundleId}`],
              },
              config: function configureReactRouterRoutesWorker(_, { entryWorkerConfig }) {
                const vars = Object.fromEntries(
                  worker.environment.variables.flatMap((variableName) =>
                    variableName in entryWorkerConfig.vars
                      ? [[variableName, entryWorkerConfig.vars[variableName]]]
                      : [],
                  ),
                );

                return {
                  name: worker.name,
                  main: "./workers/react-router-route-worker.ts",
                  compatibility_date: entryWorkerConfig.compatibility_date,
                  compatibility_flags: entryWorkerConfig.compatibility_flags,
                  observability: entryWorkerConfig.observability,
                  preview_urls: false,
                  workers_dev: false,
                  vars,
                  ...(worker.environment.secrets.required.length > 0
                    ? {
                        secrets: {
                          required: [...worker.environment.secrets.required],
                        },
                      }
                    : {}),
                  durable_objects: {
                    bindings: entryWorkerConfig.durable_objects.bindings.map((binding) => ({
                      ...binding,
                      script_name: BACKOFFICE_WORKER_TOPOLOGY.entryWorker.name,
                    })),
                  },
                  r2_buckets: entryWorkerConfig.r2_buckets,
                  worker_loaders: entryWorkerConfig.worker_loaders,
                  services: [
                    {
                      binding: "OUTBOUND",
                      service: BACKOFFICE_WORKER_TOPOLOGY.entryWorker.name,
                      entrypoint: "OutboundProxy",
                    },
                  ],
                };
              },
            })),
        inspectorPort: false,
      }),
      tailwindcss(),
      reactRouter(),
      reactRouterServerBundleVitePlugin(),
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
      console.log(`\nEnvironment info written to: ${outputPath}\n`);
    },
  };
}
