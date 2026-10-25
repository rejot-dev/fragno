import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: [
    "./src/mod.ts",
    "./src/cli/index.ts",
    "./src/scenario.ts",
    "./src/sqlite.ts",
    "./src/sqlite/testing.ts",
    "./src/sqlite-worker.ts",
    "./src/sqlite-browser.ts",
  ],
  dts: true,
  unbundle: true,
});
