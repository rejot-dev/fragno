import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: "./index.ts",
  dts: true,
});
