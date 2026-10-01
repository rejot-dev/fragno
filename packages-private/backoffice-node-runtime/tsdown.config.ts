import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/graft/graft-database-operations.ts",
    "./src/graft/graft-object-directory.ts",
    "./src/graft/graft-sqlite.ts",
    "./src/runtime/local-durable-objects.ts",
    "./src/runtime/node-object-runtime.ts",
    "./src/runtime/node-object-worker.ts",
    "./src/runtime/node-durable-object-state.ts",
    "./src/runtime/node-durable-object-storage.ts",
    "./src/runtime/node-runtime-object.ts",
    "./src/runtime/node-runtime-clock.ts",
    "./src/scheduling/node-alarm-scheduler.ts",
    "./src/scheduling/node-durable-hooks.ts",
    "./src/sqlite/sqlite-connection-config.ts",
    "./src/sqlite/sqlite-durable-object-state.ts",
    "./src/sqlite/sqlite-object-coordination.ts",
    "./src/sqlite/sqlite-object-storage.ts",
    "./src/testing/node-runtime-scenario.ts",
  ],
  dts: true,
  unbundle: true,
});
