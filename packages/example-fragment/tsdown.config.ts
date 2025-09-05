import { defineConfig } from "tsdown";
import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
    entry: "./src/index.ts",
    dts: true,
    platform: "browser",
    outDir: "./dist/browser",
    plugins: [unpluginFragno({ platform: "browser" })],
  },
  {
    entry: "./src/index.ts",
    dts: true,
    platform: "node",
    outDir: "./dist/node",
  },
]);
