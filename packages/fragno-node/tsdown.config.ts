import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: "./fragno-node.ts",
  dts: true,
});
