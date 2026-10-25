import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["./src/mod.ts", "./src/worker.ts"],
  dts: true,
  unbundle: true,
});
