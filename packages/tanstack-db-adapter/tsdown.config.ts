import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/checkpoint.ts",
    "./src/collection-options.ts",
    "./src/coordinator.ts",
    "./src/persistence.ts",
    "./src/protocol.ts",
    "./src/transport.ts",
    "./src/streaming-transport.ts",
    "./src/scenario.ts",
  ],
  dts: true,
  unbundle: true,
});
