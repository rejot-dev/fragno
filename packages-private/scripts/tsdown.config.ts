import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/roll-line.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  shims: true,
  target: "node18",
});
