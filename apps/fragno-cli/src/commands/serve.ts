import { createServer, type Server } from "node:http";
import { resolve, relative } from "node:path";
import { define } from "gunshi";
import { toNodeHandler } from "@fragno-dev/node";
import type { FragnoInstantiatedFragment } from "@fragno-dev/core";
import { loadConfig } from "../utils/load-config";
import { findFragnoFragments } from "../utils/find-fragno-databases";

export const serveCommand = define({
  name: "serve",
  description: "Start a local HTTP server to serve one or more Fragno fragments",
  args: {
    port: {
      type: "number",
      short: "p",
      description: "Port to listen on",
      default: 8080,
    },
    host: {
      type: "string",
      short: "H",
      description: "Host to bind to",
      default: "localhost",
    },
  },
  run: async (ctx) => {
    const targets = ctx.positionals;
    const port = ctx.values.port ?? 8080;
    const host = ctx.values.host ?? "localhost";
    const cwd = process.cwd();

    if (targets.length === 0) {
      throw new Error(
        "No fragment files specified.\n\n" +
          "Usage: fragno-cli serve <fragment-file> [fragment-file...]\n\n" +
          "Example: fragno-cli serve ./src/my-fragment.ts",
      );
    }

    const targetPaths = targets.map((target) => resolve(cwd, target));

    // Import all fragment files and find instantiated fragments
    const allFragments: FragnoInstantiatedFragment<
      [],
      unknown,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      unknown,
      Record<string, unknown>
    >[] = [];

    for (const targetPath of targetPaths) {
      const relativePath = relative(cwd, targetPath);
      const config = await loadConfig(targetPath);
      const fragments = findFragnoFragments(config);

      if (fragments.length === 0) {
        console.warn(
          `Warning: No instantiated fragments found in ${relativePath}.\n` +
            `Make sure you export an instantiated fragment (e.g., the return value of createMyFragment()).\n`,
        );
        continue;
      }

      allFragments.push(...fragments);
      console.log(
        `  Found ${fragments.length} fragment(s) in ${relativePath}: ${fragments.map((f) => f.name).join(", ")}`,
      );
    }

    if (allFragments.length === 0) {
      throw new Error(
        "No instantiated fragments found in any of the specified files.\n" +
          "Make sure your files export instantiated fragments.",
      );
    }

    // Build handlers mapped by mountRoute
    const handlers = allFragments.map((fragment) => ({
      mountRoute: fragment.mountRoute,
      handler: toNodeHandler(fragment.handler.bind(fragment)),
      fragment,
    }));

    const server = createServer((req, res) => {
      const url = req.url ?? "";

      for (const { mountRoute, handler } of handlers) {
        if (url.startsWith(mountRoute)) {
          return handler(req, res);
        }
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Not Found",
          availableRoutes: handlers.map((h) => h.mountRoute),
        }),
      );
    });

    server.listen(port, host, () => {
      const hostStr = addressToString(server);
      console.log(`\nFragno server is running on: ${hostStr}\n`);

      for (const { fragment } of handlers) {
        console.log(`Fragment: ${fragment.name}`);
        console.log(`  Mount: ${hostStr}${fragment.mountRoute}`);

        const routes = fragment.routes as unknown as { method: string; path: string }[];
        if (routes.length > 0) {
          console.log("  Routes:");
          for (const route of routes) {
            console.log(`    ${route.method} ${fragment.mountRoute}${route.path}`);
          }
        }

        console.log("");
      }
    });
  },
});

function addressToString(server: Server, protocol: "http" | "https" = "http"): string {
  const addr = server.address();
  if (!addr) {
    throw new Error("Address invalid");
  }

  if (typeof addr === "string") {
    return addr;
  }

  let host = addr.address;

  if (host === "::" || host === "0.0.0.0") {
    host = "localhost";
  }

  if (addr.family === "IPv6" && host !== "localhost") {
    host = `[${host}]`;
  }

  return `${protocol}://${host}:${addr.port}`;
}
