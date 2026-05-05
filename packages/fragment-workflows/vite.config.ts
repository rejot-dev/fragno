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
        "./src/scenario.ts",
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
      external: [/^@fragno-dev\/test/, /^@fragno-dev\/db/],
      plugins: [unpluginFragno({ platform: "node" })],
    },
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: [
        "./src/client/clients.ts",
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
  ],

  test: baseConfig.test,
});
