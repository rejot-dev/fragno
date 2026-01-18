import { defineConfig } from "tsdown";

import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
    ignoreWatch: ["./dist"],
    entry: ["./src/index.ts", "./src/test.ts"],
    dts: true,
    platform: "node",
    outDir: "./dist/node",
    plugins: [unpluginFragno({ platform: "node" })],
    unbundle: true,
  },
]);
