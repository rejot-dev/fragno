import path from "node:path";
import { fileURLToPath } from "node:url";
import unpluginFragno from "@fragno-dev/unplugin-fragno/rspack";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('@rspack/core').Configuration[]} */
export default [
  // Browser build
  {
    name: "browser",
    mode: "production",
    entry: {
      index: "./src/index.ts",
      "client/react": "./src/client/react.ts",
      "client/svelte": "./src/client/svelte.ts",
      "client/vanilla": "./src/client/vanilla.ts",
      "client/vue": "./src/client/vue.ts",
      "client/solid": "./src/client/solid.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist/browser"),
      filename: "[name].js",
      library: {
        type: "module",
      },
    },
    experiments: {
      outputModule: true,
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "builtin:swc-loader",
          exclude: /node_modules/,
          options: {
            jsc: {
              parser: {
                syntax: "typescript",
              },
            },
          },
        },
      ],
    },
    plugins: [unpluginFragno({ platform: "browser" })],
    devtool: "source-map",
    externals: ["zod", "react", "vue", "svelte", "solid-js", /^@fragno-dev\/db/],
  },
  // Node build
  {
    name: "node",
    mode: "production",
    entry: {
      index: "./src/index.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist/node"),
      filename: "[name].js",
      library: {
        type: "module",
      },
    },
    experiments: {
      outputModule: true,
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: "builtin:swc-loader",
          exclude: /node_modules/,
          options: {
            jsc: {
              parser: {
                syntax: "typescript",
              },
            },
          },
        },
      ],
    },
    plugins: [unpluginFragno({ platform: "node" })],
    devtool: "source-map",
    externals: ["zod", /^@fragno-dev\/core/, /^@fragno-dev\/db/],
  },
];
