import { existsSync, readFileSync } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";

import { reactRouter } from "@react-router/dev/vite";
import {
  backofficeDevServerPort,
  backofficeInspectorPort,
} from "@rejot-dev/backoffice-local/dev-server-port";
import { defineConfig } from "vite";
import type { EnvironmentOptions, Plugin, PreviewServer, ViteDevServer } from "vite";
import devtoolsJson from "vite-plugin-devtools-json";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

import { emitWaSqliteWasmAssetPlugin } from "./scripts/node-server/vite-wa-sqlite-wasm-asset";

// Warm the public Worker entry during dev-server boot instead of on the first SSR request.
const workerWarmupFiles = ["./workers/app.ts"];
// A boxd VM serves its dev servers through HTTPS proxies (`<name>.<vm>.boxd.sh` -> port), which
// connect over the VM's network interface rather than loopback. Elsewhere, stay on loopback.
const boxdVmHost = process.env.BOXD_VM_HOST;
const viteHost = boxdVmHost ? "0.0.0.0" : "127.0.0.1";
const boxdAllowedHosts = boxdVmHost ? [`.${boxdVmHost}`] : [];
const localDevVarsPath = path.resolve(__dirname, ".dev.vars");
const buildCompleteMarkerPath = path.resolve(__dirname, "build/.build-complete");
// What `vite preview` serves: each Worker's output and the deploy config pointing at them.
const previewOutputPaths = [
  "build",
  "dist/rejot_backoffice",
  "dist/cf_sandbox_bridge",
  ".wrangler/deploy/config.json",
];

/** DOCS_PUBLIC_BASE_URL from .dev.vars: the boxd proxy or tunnel serving the local server. */
function localPublicBaseUrl(): string | null {
  if (!existsSync(localDevVarsPath)) {
    return null;
  }
  return parseEnv(readFileSync(localDevVarsPath, "utf8")).DOCS_PUBLIC_BASE_URL || null;
}

// The Cloudflare plugin copies local secrets from .dev.vars beside each Worker's output config for
// `vite preview`. Turbo caches the build output and shares it between machines, so the output must
// carry no secrets; scripts/run-vite-preview.mjs puts them in place while a preview runs.
function dropLocalDevVarsPlugin(): Plugin {
  return {
    name: "drop-local-dev-vars",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      delete bundle[".dev.vars"];
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

/**
 * Lists DOCS_PUBLIC_BASE_URL (the boxd proxy or tunnel) as the server's Network URL. Vite would list
 * the machine's interface addresses, which the proxy or tunnel in front of it makes irrelevant.
 */
function printPublicBaseUrlPlugin(): Plugin {
  function listPublicBaseUrl(server: ViteDevServer | PreviewServer) {
    const publicBaseUrl = localPublicBaseUrl();
    if (!publicBaseUrl || /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(publicBaseUrl)) {
      return;
    }

    const printUrls = server.printUrls;
    server.printUrls = () => {
      if (server.resolvedUrls) {
        server.resolvedUrls.network = [publicBaseUrl];
      }
      printUrls();
    };
  }

  return {
    name: "print-public-base-url",
    configureServer: listPublicBaseUrl,
    configurePreviewServer: listPublicBaseUrl,
  };
}

/**
 * Lets pages served at DOCS_PUBLIC_BASE_URL move blobs through the local R2 bucket, which Miniflare
 * serves under /cdn-cgi/local/r2/. Miniflare refuses /cdn-cgi/ requests whose Origin is neither
 * localhost nor one of the Worker's routes, and the Cloudflare plugin passes it no routes, so
 * browsers behind the boxd proxy or a tunnel could not upload large files. The public origin is
 * dropped from those requests before Miniflare sees them; other origins are still refused.
 */
function localR2PublicOriginPlugin(): Plugin {
  function acceptPublicOrigin(server: ViteDevServer | PreviewServer) {
    const publicBaseUrl = localPublicBaseUrl();
    if (!publicBaseUrl) {
      return;
    }
    const publicOrigin = new URL(publicBaseUrl).origin;
    server.middlewares.use("/cdn-cgi/local/r2/", (req, _res, next) => {
      if (req.headers.origin === publicOrigin) {
        delete req.headers.origin;
        // The Cloudflare plugin builds Miniflare's request from the raw name/value pairs.
        const at = req.rawHeaders.findIndex(
          (name, index) => index % 2 === 0 && name.toLowerCase() === "origin",
        );
        req.rawHeaders.splice(at, 2);
      }
      next();
    });
  }

  return {
    name: "local-r2-public-origin",
    // Runs before the Cloudflare plugin's middleware hands the request to Miniflare.
    enforce: "pre",
    configureServer: acceptPublicOrigin,
    configurePreviewServer: acceptPublicOrigin,
  };
}

/** Size of every file `vite preview` serves, by path relative to the app. */
async function previewOutputFiles(): Promise<Record<string, number>> {
  const files: Record<string, number> = {};
  for (const outputPath of previewOutputPaths) {
    const absolutePath = path.resolve(__dirname, outputPath);
    const entries = (await stat(absolutePath)).isDirectory()
      ? (await readdir(absolutePath, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => path.join(entry.parentPath, entry.name))
      : [absolutePath];
    for (const file of entries) {
      // Turbo never caches local secrets, so a restored build lacks any left in the output.
      if (file !== buildCompleteMarkerPath && path.basename(file) !== ".dev.vars") {
        files[path.relative(__dirname, file)] = (await stat(file)).size;
      }
    }
  }
  return files;
}

// scripts/run-vite-preview.mjs starts a preview of each build once this marker changes. Turbo
// restores cached builds file by file in no set order, so the marker lists every file the preview
// needs, and the preview waits until the output holds all of them.
function writeBuildCompleteMarkerPlugin(): Plugin {
  return {
    name: "write-build-complete-marker",
    // Runs after React Router and the Cloudflare plugin have built every environment and written
    // the Worker configs, as long as it stays after the Cloudflare plugin in the plugin list.
    buildApp: {
      order: "post",
      async handler() {
        await writeFile(buildCompleteMarkerPath, JSON.stringify(await previewOutputFiles()));
      },
    },
  };
}

// scripts/run-vite-preview.mjs proxies the worktree's ports to the preview serving the latest build,
// so each preview it starts takes inspector and server ports of its own.
function previewInspectorPort(): number {
  const port = process.env.BACKOFFICE_PREVIEW_INSPECTOR_PORT;
  if (!port) {
    throw new Error("Preview Backoffice through scripts/run-vite-preview.mjs (`pnpm preview`).");
  }
  return Number(port);
}

export default defineConfig(({ command, isPreview }) => {
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
    // Turbo shares builds between machines and hashes VITE_* settings from the process environment
    // (turbo.json `env`), so builds must not read them from a machine's .env file.
    // A preview's root is a snapshot of the build (see scripts/run-vite-preview.mjs), so the .env
    // file is looked up here rather than in the root.
    envDir: isDevServer ? __dirname : false,
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
      localR2PublicOriginPlugin(),
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
        // Left unset, the plugin takes 9229, the Node debuggers' port, whenever it is free.
        inspectorPort: isPreview
          ? previewInspectorPort()
          : isDevServer
            ? backofficeInspectorPort(__dirname)
            : false,
        // Local state defaults to the root's .wrangler/state, and a preview's root is a snapshot.
        persistState: { path: path.resolve(__dirname, ".wrangler/state") },
      }),
      tailwindcss(),
      // React Router finds the app's routes under the root, which a preview's snapshot lacks. The
      // preview serves every request through the Cloudflare plugin's Workers.
      ...(isPreview ? [] : [reactRouter()]),
      devtoolsJson(),
      emitWaSqliteWasmAssetPlugin(),
      reactDomStreamingRendererOnlyPlugin(),
      lazyServerRouteModulesPlugin(),
      dropUnloadedServerModulesPlugin(),
      dropLocalDevVarsPlugin(),
      printPublicBaseUrlPlugin(),
      writeBuildCompleteMarkerPlugin(),
    ],
    ssr: {
      noExternal: ["@earendil-works/pi-ai"],
    },
    environments,
    preview: {
      host: viteHost,
      port,
      strictPort: true,
      allowedHosts: [".trycloudflare.com", "local-wilco.recivo.email", ...boxdAllowedHosts],
    },
    server: {
      host: viteHost,
      port,
      strictPort: true,
      hmr: false,
      allowedHosts: ["local-wilco.recivo.email", ...boxdAllowedHosts],
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
