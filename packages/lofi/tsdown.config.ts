import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/mod.ts"],
  dts: true,
  unbundle: true,
});
