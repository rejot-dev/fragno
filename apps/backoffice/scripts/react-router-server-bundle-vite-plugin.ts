import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

import {
  REACT_ROUTER_SERVER_BUNDLE_ENVIRONMENTS,
  type ReactRouterServerBundleId,
} from "../workers/react-router-worker-routing";

const REACT_ROUTER_SERVER_BUILD_MODULE_ID = "virtual:react-router/server-build";
const BACKOFFICE_CURRENT_SERVER_BUILD_MODULE_ID =
  "virtual:backoffice/react-router-current-server-build";
const BACKOFFICE_SERVER_BUNDLE_MODULE_PREFIX = "virtual:backoffice/react-router-server-build/";
const BACKOFFICE_SERVER_BUILD_DIRECTORY = fileURLToPath(
  new URL("../build/server/", import.meta.url),
);
const reactRouterServerBundleEnvironmentSet = new Set(REACT_ROUTER_SERVER_BUNDLE_ENVIRONMENTS);

/** Builds route-filtered React Router children and generates their generic Worker entry modules. */
export function reactRouterServerBundleVitePlugin(): Plugin {
  let viteCommand: "build" | "serve";

  return {
    name: "backoffice-react-router-server-bundle-environments",
    config(_config, environment) {
      viteCommand = environment.command;
    },
    configEnvironment: {
      order: "post",
      handler(environmentName) {
        if (!reactRouterServerBundleEnvironmentSet.has(environmentName)) {
          return undefined;
        }

        const bundleId = reactRouterServerBundleIdFromEnvironmentName(environmentName);
        // React Router copies the parent `ssr` environment onto every server bundle. The
        // Cloudflare parent points at its Worker wrapper, but child environments must retain
        // React Router's route-filtered virtual server entry and output directory instead.
        return {
          build: {
            outDir: `${BACKOFFICE_SERVER_BUILD_DIRECTORY}${bundleId}`,
            rolldownOptions: {
              input: REACT_ROUTER_SERVER_BUILD_MODULE_ID,
              output: {
                entryFileNames: "index.js",
                format: "es",
              },
            },
            rollupOptions: {
              input: REACT_ROUTER_SERVER_BUILD_MODULE_ID,
              output: {
                entryFileNames: "index.js",
                format: "es",
              },
            },
          },
        };
      },
    },
    resolveId(source) {
      if (source === BACKOFFICE_CURRENT_SERVER_BUILD_MODULE_ID) {
        const environmentName = this.environment.name;
        if (!environmentName.startsWith("routes_")) {
          throw new Error(
            `Backoffice route Worker server build was imported by unexpected Vite environment '${environmentName}'`,
          );
        }
        const bundleId = environmentName.slice("routes_".length);
        assertReactRouterServerBundleId(bundleId);
        return `\0${BACKOFFICE_SERVER_BUNDLE_MODULE_PREFIX}${bundleId}`;
      }
      if (source.startsWith(BACKOFFICE_SERVER_BUNDLE_MODULE_PREFIX)) {
        return `\0${source}`;
      }
      return undefined;
    },
    load(id) {
      if (!id.startsWith(`\0${BACKOFFICE_SERVER_BUNDLE_MODULE_PREFIX}`)) {
        return undefined;
      }

      const bundleId = id.slice(`\0${BACKOFFICE_SERVER_BUNDLE_MODULE_PREFIX}`.length);
      assertReactRouterServerBundleId(bundleId);
      if (viteCommand !== "build") {
        return `export * from ${JSON.stringify(REACT_ROUTER_SERVER_BUILD_MODULE_ID)};`;
      }

      const serverBuildPath = `${BACKOFFICE_SERVER_BUILD_DIRECTORY}${bundleId}/index.js`;
      if (!existsSync(serverBuildPath)) {
        throw new Error(
          `Backoffice React Router server bundle was not built before the Cloudflare Worker: ${serverBuildPath}`,
        );
      }
      return `export * from ${JSON.stringify(serverBuildPath)};`;
    },
  };
}

function reactRouterServerBundleIdFromEnvironmentName(
  environmentName: string,
): ReactRouterServerBundleId {
  const bundleId = environmentName.replace(/^ssrBundle_/, "");
  assertReactRouterServerBundleId(bundleId);
  return bundleId;
}

function assertReactRouterServerBundleId(
  bundleId: string,
): asserts bundleId is ReactRouterServerBundleId {
  if (!REACT_ROUTER_SERVER_BUNDLE_ENVIRONMENTS.includes(`ssrBundle_${bundleId}`)) {
    throw new Error(`Unknown Backoffice React Router server bundle: ${bundleId}`);
  }
}
