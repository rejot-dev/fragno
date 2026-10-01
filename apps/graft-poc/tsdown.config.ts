import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: "./src/graft-sqlite-poc.ts",
  platform: "node",
  target: "node24",
  dts: false,
});
