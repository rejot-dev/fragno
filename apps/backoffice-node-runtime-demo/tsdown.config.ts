import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/runtime-showcase-object.ts",
    "./src/runtime-showcase-server.ts",
    "./src/runtime-showcase-storage.ts",
    "./src/runtime-showcase-walkthrough.ts",
  ],
  platform: "node",
  target: "node26",
  dts: false,
  unbundle: true,
});
