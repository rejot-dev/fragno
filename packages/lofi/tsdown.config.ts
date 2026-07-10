import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["./src/mod.ts", "./src/cli/index.ts", "./src/scenario.ts"],
  dts: true,
  unbundle: true,
});
