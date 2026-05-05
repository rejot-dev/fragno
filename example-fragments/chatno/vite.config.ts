import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: [
        "./src/index.ts",
        "./src/client/react.ts",
        "./src/client/svelte.ts",
        "./src/client/vanilla.ts",
        "./src/client/vue.ts",
        "./src/client/solid.ts",
      ],
      dts: {
        sourcemap: true,
      },
      platform: "browser",
      outDir: "./dist/browser",
      plugins: [unpluginFragno({ platform: "browser" })],
      deps: {
        alwaysBundle: [/^@fragno-dev\/core\//],
      },
    },
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: "./src/index.ts",
      dts: {
        sourcemap: true,
      },
      outDir: "./dist/node",
      // This plugin can be omitted, because it doesn't do anything for platform "node".
      plugins: [unpluginFragno({ platform: "node" })],
      unbundle: true,
    },
  ],
});
