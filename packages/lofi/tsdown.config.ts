import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/mod.ts", "./src/cli/index.ts", "./src/scenario.ts"],
  dts: true,
  unbundle: true,
});
