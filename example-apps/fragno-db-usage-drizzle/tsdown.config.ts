import { defineConfig } from "tsdown";

export default defineConfig([
  {
    fixedExtension: false,
    entry: "./src/mod.ts",
    dts: true,
    platform: "node",
    outDir: "./dist",
  },
]);
