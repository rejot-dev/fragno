import { defineConfig } from "tsdown";

export default defineConfig([
  {
    ignoreWatch: ["./dist"],
    entry: "./src/index.ts",
    dts: true,
    platform: "node",
    outDir: "./dist/node",
    unbundle: true,
  },
]);
