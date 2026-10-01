import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/runtime/local-durable-objects.ts",
    "./src/scheduling/node-alarm-scheduler.ts",
    "./src/scheduling/node-durable-hooks.ts",
    "./src/testing/node-runtime-scenario.ts",
    "./src/sqlite/sqlite-connection-config.ts",
    "./src/sqlite/sqlite-durable-object-state.ts",
    "./src/sqlite/sqlite-object-coordination.ts",
    "./src/sqlite/sqlite-object-storage.ts",
  ],
  dts: true,
  unbundle: true,
});
