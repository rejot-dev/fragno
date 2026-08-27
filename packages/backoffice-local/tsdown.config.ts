import { defineConfig } from "tsdown";
export default defineConfig({
  fixedExtension: false,
  entry: "./src/backoffice-local.ts",
  dts: true,
});
