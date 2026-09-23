import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  entry: ["./src/generate-summary-candidates.ts", "./src/summary-candidates-cli.ts"],
  dts: true,
  unbundle: true,
});
