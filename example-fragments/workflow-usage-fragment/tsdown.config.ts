import { defineConfig } from "tsdown";

import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
    ignoreWatch: ["./dist"],
    entry: [
      "./src/fragment/index.ts",
      "./src/fragment/client/react.ts",
      "./src/fragment/client/svelte.ts",
      "./src/fragment/client/solid.ts",
      "./src/fragment/client/vanilla.ts",
      "./src/fragment/client/vue.ts",
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
    entry: ["./src/fragment/index.ts", "./src/server/cli.ts", "./src/server/test-server.ts"],
    dts: true,
    failOnWarn: true,
    platform: "node",
    outDir: "./dist/node",
    plugins: [unpluginFragno({ platform: "node" })],
    unbundle: true,
    outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
  },
]);
