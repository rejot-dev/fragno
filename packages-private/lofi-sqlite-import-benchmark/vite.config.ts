import { readFileSync } from "node:fs";

import { defineConfig, type Plugin } from "vite";

import { createOutboxFixtureHandler } from "./outbox-fixture-server.ts";

export default defineConfig({
  plugins: [outboxFixture(), waSqliteWasm()],
  server: { port: 5544 },
  optimizeDeps: {
    // Pre-bundling moves the OPFS worker away from the URL its loader resolves.
    exclude: ["@tanstack/browser-db-sqlite-persistence", "@journeyapps/wa-sqlite"],
  },
});

/** Serves the recorded outbox from `OUTBOX_JSONL` on the dev server; `serve.ts` does so for builds. */
function outboxFixture(): Plugin {
  return {
    name: "outbox-fixture",
    configureServer(server) {
      const fixturePath = process.env["OUTBOX_JSONL"];
      if (!fixturePath) {
        throw new Error("Set OUTBOX_JSONL to the recorded outbox stream (.jsonl) to replay.");
      }
      server.middlewares.use(
        createOutboxFixtureHandler(fixturePath, (message) => {
          server.config.logger.info(message);
        }),
      );
    },
  };
}

/**
 * TanStack's OPFS worker loads `wa-sqlite.wasm` from its own directory, which neither the dev
 * server nor the build provides, so serve and emit it next to the worker.
 */
function waSqliteWasm(): Plugin {
  const wasm = () =>
    readFileSync(new URL(import.meta.resolve("@journeyapps/wa-sqlite/dist/wa-sqlite.wasm")));
  return {
    name: "wa-sqlite-wasm",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.split("?")[0]?.endsWith("/wa-sqlite.wasm")) {
          next();
          return;
        }
        response.setHeader("Content-Type", "application/wasm");
        response.end(wasm());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "assets/wa-sqlite.wasm", source: wasm() });
    },
  };
}
