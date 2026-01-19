import { defineConfig } from "tsdown";

import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
    ignoreWatch: ["./dist"],
    entry: [
      "./src/index.ts",
      "./src/test.ts",
      "./src/client/react.ts",
      "./src/client/svelte.ts",
      "./src/client/solid.ts",
      "./src/client/vanilla.ts",
      "./src/client/vue.ts",
    ],
    dts: true,
    platform: "node",
    outDir: "./dist/node",
    unbundle: true,
    plugins: [unpluginFragno({ platform: "node" })],
  },
  {
    ignoreWatch: ["./dist"],
    entry: [
      "./src/index.ts",
      "./src/client/react.ts",
      "./src/client/svelte.ts",
      "./src/client/solid.ts",
      "./src/client/vanilla.ts",
      "./src/client/vue.ts",
    ],
    dts: true,
    platform: "browser",
    outDir: "./dist/browser",
    plugins: [unpluginFragno({ platform: "browser" })],
    noExternal: [/^@fragno-dev\/core\//],
  },
]);
