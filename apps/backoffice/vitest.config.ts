import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import { baseConfig } from "@fragno-private/vitest-config";

const resolveConfig = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Turbo runs other package suites concurrently; leave CPU capacity for them.
      maxWorkers: "50%",
      // `test:changed` and watch mode select tests through imports. Tests reach these files through
      // `?raw`, `import.meta.glob`, or `fs` instead, so a change to them runs every test.
      forceRerunTriggers: [
        ...configDefaults.forceRerunTriggers,
        resolveConfig("./vitest.*.ts"),
        resolveConfig("./tests/wrangler.vitest.jsonc"),
        resolveConfig("./content/**"),
        // Read by `app/fragno/runtime-tools/async-execute.test.ts`.
        resolveConfig("./app/fragno/runtime-tools/families/!(*.test|*-runtime).ts"),
        // Run as a subprocess by `scripts/run-worker-release.test.ts`.
        resolveConfig("./scripts/run-worker-release.mjs"),
        // Read by `dev-vars.test.ts`.
        resolveConfig("./.dev.vars.example"),
        resolveConfig("./optional-secrets.d.ts"),
        resolveConfig("./wrangler.jsonc"),
        resolveConfig("./wrangler.web.jsonc"),
      ],
      coverage: {
        enabled: false,
        reportsDirectory: "./coverage",
        reporter: ["text", "html", "json"],
      },
      projects: [
        resolveConfig("./vitest.node.config.ts"),
        resolveConfig("./vitest.cloudflare.config.ts"),
      ],
    },
  }),
);
