import typescript from "@rollup/plugin-typescript";
import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import resolve from "@rollup/plugin-node-resolve";

export default [
  // Browser build
  {
    input: {
      index: "./src/index.ts",
      "client/react": "./src/client/react.ts",
      "client/svelte": "./src/client/svelte.ts",
      "client/vanilla": "./src/client/vanilla.ts",
      "client/vue": "./src/client/vue.ts",
      "client/solid": "./src/client/solid.ts",
    },
    output: {
      dir: "./dist/browser",
      format: "es",
      sourcemap: true,
    },
    // https://rollupjs.org/tools/#peer-dependencies
    external: ["zod", "react", "svelte", "vue", "solid-js", /^@fragno-dev\/db/],
    plugins: [
      resolve({
        moduleDirectories: ["node_modules"],
        browser: true,
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        outDir: "./dist/browser",
        declarationDir: "./dist/browser",
      }),
      unpluginFragno({ platform: "browser" }),
    ],
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
      resolve({
        moduleDirectories: ["node_modules"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        outDir: "./dist/node",
        declarationDir: "./dist/node",
      }),
      unpluginFragno({ platform: "node" }),
    ],
  },
];
