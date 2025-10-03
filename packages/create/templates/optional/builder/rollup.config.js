import typescript from "@rollup/plugin-typescript";
import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

const entryPoints = [
  "./src/index.ts",
  "./src/client/react.ts",
  "./src/client/svelte.ts",
  "./src/client/vanilla.ts",
  "./src/client/vue.ts",
];

const fragnoPlugin = unpluginFragno();

export default [
  // Browser build
  {
    input: entryPoints,
    output: {
      dir: "./dist/browser",
      format: "es",
      sourcemap: true,
    },
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        outDir: "./dist/browser",
        declarationDir: "./dist/browser",
      }),
      fragnoPlugin,
    ],
    external: ["@fragno-dev/core", "nanostores"],
  },
  // Node build
  {
    input: "./src/index.ts",
    output: {
      dir: "./dist/node",
      format: "es",
      sourcemap: true,
    },
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        outDir: "./dist/node",
        declarationDir: "./dist/node",
      }),
      fragnoPlugin,
    ],
    external: ["@fragno-dev/core", "nanostores"],
  },
];
