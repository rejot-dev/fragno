import { defineConfig, type Plugin } from "vite";

import { createOutboxFixtureHandler } from "./outbox-fixture-server.ts";

export default defineConfig({
  plugins: [outboxFixture()],
  server: { port: 5544 },
  optimizeDeps: {
    // Pre-bundling moves wa-sqlite away from the URL it loads its wasm from.
    exclude: ["@journeyapps/wa-sqlite"],
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
