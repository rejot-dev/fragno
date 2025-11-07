import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "./src/index.ts",
  dts: true,
  outDir: "./dist",
  copy: [{ from: "src/subjects", to: "dist/subjects" }],
});
