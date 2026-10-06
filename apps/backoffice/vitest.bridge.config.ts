import { defineConfig } from "vitest/config";

import nodeProject from "./vitest.node.config";

export default defineConfig({
  ...nodeProject,
  test: {
    ...nodeProject.test,
    name: "node-bridge",
    maxWorkers: "50%",
    include: ["app/**/*.bridge.scenario.test.ts"],
    exclude: [],
    coverage: { enabled: false },
  },
});
