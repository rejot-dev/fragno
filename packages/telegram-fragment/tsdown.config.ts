import { defineConfig } from "tsdown";

import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
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
    failOnWarn: true,
    platform: "browser",
    outDir: "./dist/browser",
    plugins: [unpluginFragno({ platform: "browser" })],
    noExternal: [/^@fragno-dev\/core\//],
    inlineOnly: [/^@fragno-dev\/core/, /^nanostores$/, /^@nanostores\//, /^nanoevents$/],
  },
  {
    ignoreWatch: ["./dist"],
    entry: "./src/index.ts",
    dts: true,
    failOnWarn: true,
    platform: "node",
    outDir: "./dist/node",
    fixedExtension: false,
    plugins: [unpluginFragno({ platform: "node" })],
    unbundle: true,
  },
]);
