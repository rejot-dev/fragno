import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: "./src/cli.ts",
  dts: true,
});
