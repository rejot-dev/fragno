import { defineProject } from "vitest/config";

import { docsVitestResolveConfig } from "./vitest.shared";

export default defineProject({
  resolve: docsVitestResolveConfig,
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
