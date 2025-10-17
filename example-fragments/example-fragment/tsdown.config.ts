import { defineConfig } from "tsdown";
import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
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
    external: ["react", "svelte", "vue"],
  },
  {
    entry: "./src/index.ts",
    dts: true,
    platform: "node",
    outDir: "./dist/node",
  },
]);
