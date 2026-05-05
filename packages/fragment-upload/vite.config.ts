import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: [
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: [
        "./src/index.ts",
        "./src/cli/index.ts",
        "./src/client/react.ts",
        "./src/client/svelte.ts",
        "./src/client/solid.ts",
        "./src/client/vanilla.ts",
        "./src/client/vue.ts",
      ],
      dts: true,
      platform: "node",
      outDir: "./dist/node",
      plugins: [unpluginFragno({ platform: "node" })],
      unbundle: true,
    },
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: [
        "./src/client/react.ts",
        "./src/client/svelte.ts",
        "./src/client/solid.ts",
        "./src/client/vanilla.ts",
        "./src/client/vue.ts",
      ],
      dts: true,
      platform: "browser",
      outDir: "./dist/browser/client",
      unbundle: true,
      plugins: [unpluginFragno({ platform: "browser" })],
      deps: {
        alwaysBundle: [/^@fragno-dev\/core\//],
      },
    },
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: "./src/cli/index.ts",
      dts: true,
      platform: "node",
      outDir: "./dist/cli",
      unbundle: true,
    },
  ],

  test: baseConfig.test,
});
