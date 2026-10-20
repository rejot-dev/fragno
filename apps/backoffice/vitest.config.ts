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
        // Read by `app/routes/backoffice/agents/session-detail/workspace-boundary.test.ts`.
        resolveConfig("./app/routes/backoffice/agents/session-detail/!(*.test).{ts,tsx}"),
        resolveConfig("./app/routes/backoffice/agents/organization-layout.tsx"),
        resolveConfig("./app/routes/backoffice/automations/script-view/workflow-graph.tsx"),
        resolveConfig("../../packages-private/design-system/src/components/chat-thread.tsx"),
        resolveConfig(
          "../../packages-private/design-system/src/components/chat-workspace-panel.tsx",
        ),
        // Run as a subprocess by `scripts/run-worker-release.test.ts`.
        resolveConfig("./scripts/run-worker-release.mjs"),
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
