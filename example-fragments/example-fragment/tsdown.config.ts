import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    fixedExtension: false,
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
    deps: {
      alwaysBundle: [/^@fragno-dev\/core\//],
      neverBundle: ["react", "svelte", "vue"],
    },
  },
  {
    fixedExtension: false,
    entry: "./src/index.ts",
    dts: true,
    platform: "node",
    outDir: "./dist/node",
  },
]);
