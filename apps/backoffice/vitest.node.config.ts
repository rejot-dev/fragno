import { fileURLToPath } from "node:url";

import { defineProject } from "vitest/config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
  resolve: {
    alias: [
      ...docsVitestResolveConfig.alias,
      {
        find: /^cloudflare:workers$/,
        replacement: fileURLToPath(
          new URL("./shims/cloudflare-workers.test-support.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: "node",
    environment: "node",
    globals: true,
    // Files in a worker share loaded modules: importing Backoffice takes longer than most files' tests.
    // Files that replace modules with `vi.mock` would leak the replacements, so they are named
    // `*.isolated.test.*` and run in `vitest.node-isolated.config.ts`.
    isolate: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    // Node 26's built-in web storage shadows happy-dom's isolated storage in client test files.
    execArgv: ["--no-experimental-webstorage"],
    // The heaviest scenarios take about 2s locally but several times that on CI runners shared with
    // other packages' suites, where Vitest's 5s default fails a different one each run.
    testTimeout: 15_000,
    include: [
      "*.test.ts",
      "app/**/*.test.ts",
      "app/**/*.test.tsx",
      "workers/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // Bridge transport coverage is opt-in; ordinary scenarios do not start a workerd bridge server.
    exclude: [
      "**/*.isolated.test.{ts,tsx}",
      "app/**/*.cloudflare.test.ts",
      "workers/**/*.cloudflare.test.ts",
      "**/*.bridge.scenario.test.ts",
    ],
  },
});
