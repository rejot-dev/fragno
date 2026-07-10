import { defineConfig } from "tsdown";

export default defineConfig([
  {
    fixedExtension: false,
    entry: "./src/index.ts",
    dts: true,
    platform: "node",
    outDir: "./dist/",
  },
]);
