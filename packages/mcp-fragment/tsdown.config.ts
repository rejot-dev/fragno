import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "tsdown";

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
    deps: {
      alwaysBundle: [/^@fragno-dev\/core\//],
      onlyBundle: [
        /^@fragno-dev\/core/,
        /^nanostores$/,
        /^@nanostores\//,
        /^nanoevents$/,
        /^@standard-schema\/spec$/,
      ],
    },
  },
  {
    ignoreWatch: ["./dist"],
    entry: [
      "./src/index.ts",
      "./src/definition.ts",
      "./src/routes.ts",
      "./src/schema.ts",
      "./src/mcp-types.ts",
    ],
    dts: true,
    failOnWarn: true,
    platform: "node",
    outDir: "./dist/node",
    fixedExtension: false,
    plugins: [unpluginFragno({ platform: "node" })],
    unbundle: true,
    deps: { onlyBundle: false },
  },
  {
    ignoreWatch: ["./dist"],
    entry: "./src/cli/cli.ts",
    dts: true,
    failOnWarn: true,
    platform: "node",
    outDir: "./dist/cli",
    fixedExtension: false,
    unbundle: true,
  },
]);
