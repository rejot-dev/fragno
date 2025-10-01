import { defineConfig } from "tsdown";

// TODO: make build platform configurable
import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
    entry: [
      "./src/index.ts",
      "./src/client/react.ts",
      "./src/client/svelte.ts",
      "./src/client/vanilla.ts",
      "./src/client/vue.ts",
    ],
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
