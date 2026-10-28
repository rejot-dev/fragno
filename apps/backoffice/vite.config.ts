import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { reactRouter } from "@react-router/dev/vite";
import { backofficeDevServerPort } from "@rejot-dev/backoffice-local/dev-server-port";
import { defineConfig } from "vite";
import type { EnvironmentOptions, Plugin } from "vite";
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

// `react-dom/server.edge` also loads the legacy renderer behind `renderToString`, about 200 KB the
// Workers never call but would evaluate at startup. Their production builds take the streaming
// renderer alone, so `renderToString` and `renderToStaticMarkup` are missing there.
function reactDomStreamingRendererOnlyPlugin(): Plugin {
  const reactDomDirectory = path.dirname(
    createRequire(path.join(__dirname, "package.json")).resolve("react-dom/package.json"),
  );
  const streamingRenderer = path.join(reactDomDirectory, "cjs/react-dom-server.edge.production.js");

  return {
    name: "react-dom-streaming-renderer-only",
    apply: "build",
    enforce: "pre",
    resolveId(source) {
      if (this.environment.config.consumer !== "server") {
        return null;
      }
      return source === "react-dom/server" || source === "react-dom/server.edge"
        ? streamingRenderer
        : null;
    },
  };
}

// Vite emits every Web Worker the client build bundled into each environment built after it, so the
// server Workers also received the browser's replica workers and the wa-sqlite.wasm they load.
// Wrangler uploads every JavaScript and WebAssembly file of a Worker's output as a module, so these
// counted against the Worker's size although nothing on the server loads them.
function dropUnloadedServerModulesPlugin(): Plugin {
  return {
    name: "drop-unloaded-server-modules",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      if (this.environment.config.consumer !== "server") {
        return;
      }
      const chunks = Object.values(bundle).flatMap((output) =>
        output.type === "chunk" ? [output.code] : [],
      );
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "asset" || !/\.(?:m?js|wasm)$/.test(fileName)) {
          continue;
        }
        const name = path.posix.basename(fileName);
        if (!chunks.some((code) => code.includes(name))) {
          delete bundle[fileName];
        }
      }
    },
  };
}

// The server build React Router generates imports every route module, so a cold Worker compiled
// all of them, about 47 ms per MB, whichever route it served. Production builds import each
// route module but root's on first use instead; `workers/lazy-request-handler.ts` loads those a
// request matches.
function lazyServerRouteModulesPlugin(): Plugin {
  return {
    name: "lazy-server-route-modules",
    apply: "build",
    transform(code, id) {
      if (
        this.environment.config.consumer !== "server" ||
        !id.includes("virtual:react-router/server-build")
      ) {
        return null;
      }
      const rootModule = /"root": \{[^}]*module: (route\d+)/.exec(code)?.[1];
      if (!rootModule) {
        throw new Error("The React Router server build has no root route.");
      }
      return code.replace(
        /import \* as (route\d+) from ("[^"]+");/g,
        (statement, name: string, source: string) =>
          name === rootModule
            ? statement
            : `const ${name} = { __backofficeLoadRouteModule: () => import(${source}) };`,
      );
    },
  };
}

// Vite's dev server has a `u` shortcut, but its preview server does not. Shortcuts bound here merge
// with the ones Vite's CLI binds after startup.
function previewServerUrlShortcutPlugin(): Plugin {
  return {
    name: "preview-server-url-shortcut",
    configurePreviewServer(server) {
      server.bindCLIShortcuts({
        customShortcuts: [
          {
            key: "u",
            description: "show server url",
            action(previewServer) {
              previewServer.config.logger.info("");
              previewServer.printUrls();
            },
          },
        ],
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const isDevServer = command === "serve";
  // The dev server never runs containers. Builds are deployed, so they keep the configured value.
  const disableSandboxContainersOnDevServer = (workerConfig: { vars: Record<string, unknown> }) => {
    if (isDevServer) {
      workerConfig.vars.SANDBOX_CONTAINERS = "false";
    }
  };
  // Only serving needs a port; builds must not depend on running inside a git checkout.
  const port = isDevServer ? backofficeDevServerPort(__dirname) : undefined;
  const environments: Record<string, EnvironmentOptions> = isDevServer
    ? { ssr: { dev: { preTransformRequests: true } } }
    : {
        // Worker builds emit source maps, which the Cloudflare plugin uploads with each Worker so
        // its logs and exceptions show source stacks. The client build keeps none: its maps would
        // be served as public assets.
        ssr: { build: { sourcemap: true } },
        rejot_backoffice: { build: { sourcemap: true } },
      };

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
        config: disableSandboxContainersOnDevServer,
        auxiliaryWorkers: [
          { configPath: "./wrangler.jsonc", config: disableSandboxContainersOnDevServer },
          {
            configPath: "../cf-sandbox-bridge/wrangler.jsonc",
            // The bridge hosts Sandbox containers; `preview:containers` turns them on, and
            // scripts/run-vite-preview.mjs tells Backoffice when they are off.
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
      reactDomStreamingRendererOnlyPlugin(),
      lazyServerRouteModulesPlugin(),
      dropUnloadedServerModulesPlugin(),
      emitWorkerLocalDevVarsPlugin(),
      previewServerUrlShortcutPlugin(),
    ],
    ssr: {
      noExternal: ["@earendil-works/pi-ai"],
    },
    environments,
    preview: {
      host: localViteHost,
      port,
      strictPort: true,
      allowedHosts: [".trycloudflare.com", "local-wilco.recivo.email"],
    },
    server: {
      host: localViteHost,
      port,
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
