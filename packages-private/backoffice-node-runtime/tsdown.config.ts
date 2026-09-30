import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/local-durable-objects.ts",
    "./src/node-alarm-scheduler.ts",
    "./src/node-durable-hooks.ts",
    "./src/sqlite-connection-config.ts",
    "./src/sqlite-durable-object-state.ts",
    "./src/sqlite-object-coordination.ts",
    "./src/sqlite-object-storage.ts",
  ],
  dts: true,
  unbundle: true,
});
