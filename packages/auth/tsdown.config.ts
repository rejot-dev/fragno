import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    fixedExtension: false,
    ignoreWatch: ["./dist/browser/**", "./turbo/**"],
    entry: [
      "./src/index.ts",
      "./src/client/react.ts",
      "./src/client/svelte.ts",
      "./src/client/solid.ts",
      "./src/client/vanilla.ts",
      "./src/client/vue.ts",
    ],
    dts: {
      sourcemap: true,
    },
    platform: "browser",
    outDir: "./dist/browser",
    plugins: [unpluginFragno({ platform: "browser" })],
    deps: { neverBundle: [/^@fragno-dev\/db\//] },
    // noExternal: [/^@fragno-dev\/core\//],
  },
  {
    fixedExtension: false,
    ignoreWatch: ["./dist/node/**", "./turbo/**"],
    entry: "./src/index.ts",
    dts: {
      sourcemap: true,
    },
    platform: "node",
    outDir: "./dist/node",
    plugins: [unpluginFragno({ platform: "node" })],
    deps: { neverBundle: [/^@fragno-dev\/db\//] },
  },
]);
