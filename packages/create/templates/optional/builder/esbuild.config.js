#!/usr/bin/env node
import { build } from "esbuild";
import unpluginFragno from "@fragno-dev/unplugin-fragno/esbuild";

const entryPoints = [
  "./src/index.ts",
  "./src/client/react.ts",
  "./src/client/svelte.ts",
  "./src/client/vanilla.ts",
  "./src/client/vue.ts",
];

build({
  entryPoints,
  outdir: "./dist/browser",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  splitting: true,
  sourcemap: true,
  plugins: [unpluginFragno()],
});

build({
  entryPoints: ["./src/index.ts"],
  outdir: "./dist/node",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node18",
  sourcemap: true,
  plugins: [unpluginFragno()],
});
