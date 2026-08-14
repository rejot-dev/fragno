import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["./src/coordinator.ts"],
  dts: true,
  unbundle: true,
});
