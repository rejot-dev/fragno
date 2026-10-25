import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
  resolve: {
    alias: [
      // Node compiles wa-sqlite's WebAssembly itself, where the Worker's bundler imports it.
      {
        find: "@/artifacts/pages/wa-sqlite-wasm.server",
        replacement: fileURLToPath(new URL("./shims/node-wa-sqlite-wasm.ts", import.meta.url)),
      },
      ...docsVitestResolveConfig.alias,
    ],
  },
  test: {
    name: "node",
    environment: "node",
    globals: true,
    // Node 26's built-in web storage shadows happy-dom's isolated storage in client test files.
    execArgv: ["--no-experimental-webstorage"],
    include: [
      "*.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "workers/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // Bridge transport coverage is opt-in; ordinary scenarios do not start a workerd bridge server.
    exclude: [
      "app/**/*.cloudflare.test.ts",
      "workers/**/*.cloudflare.test.ts",
      "**/*.bridge.scenario.test.ts",
    ],
  },
});
