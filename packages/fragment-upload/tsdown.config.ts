import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "tsdown";

export default defineConfig([
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
      "./src/storage/db.ts",
      "./src/schema.ts",
    ],
    dts: true,
    platform: "node",
    outDir: "./dist/node",
    plugins: [unpluginFragno({ platform: "node" })],
    deps: { neverBundle: [/^@fragno-dev\/core/, /^@fragno-dev\/db/] },
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
    deps: { alwaysBundle: [/^@fragno-dev\/core\//] },
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
]);
