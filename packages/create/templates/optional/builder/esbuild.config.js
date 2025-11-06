#!/usr/bin/env node
import { build } from "esbuild";
import unpluginFragno from "@fragno-dev/unplugin-fragno/esbuild";

build({
  entryPoints: [
    "./src/index.ts",
    "./src/client/react.ts",
    "./src/client/svelte.ts",
    "./src/client/vanilla.ts",
    "./src/client/vue.ts",
    "./src/client/solid.ts",
  ],
  outdir: "./dist/browser",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  splitting: true,
  sourcemap: true,
  plugins: [unpluginFragno({ platform: "browser" })],
  external: ["react", "svelte", "vue", "solid-js", "@fragno-dev/db"],
});

build({
  entryPoints: ["./src/index.ts"],
  outdir: "./dist/node",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  plugins: [unpluginFragno({ platform: "node" })],
});
