import { defineProject } from "vitest/config";

import nodeProject from "./vitest.node.config";

export default defineProject({
  ...nodeProject,
  test: {
    ...nodeProject.test,
    name: "node-isolated",
    isolate: true,
    include: ["*.isolated.test.ts", "{app,workers,scripts}/**/*.isolated.test.{ts,tsx}"],
    exclude: [],
  },
});
