import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["./src/index.ts"],
  dts: true,
  unbundle: true,
});
