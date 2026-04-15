import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/mod.ts", "./src/cli.ts"],
  dts: true,
  unbundle: true,
});
