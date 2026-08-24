import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["./src/read-typescript-file-outline.ts"],
  dts: true,
  unbundle: true,
});
