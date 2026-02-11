import { defineConfig } from "tsdown";
import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";

export default defineConfig([
  {
    ignoreWatch: ["./dist"],
    entry: ["./src/mod.ts", "./src/upvote.ts", "./src/schema/mod.ts"],
    dts: true,
    platform: "node",
    outDir: "./dist",
    plugins: [unpluginFragno({ platform: "node" })],
  },
  {
    ignoreWatch: ["./dist"],
    entry: ["./src/mod.ts", "./src/upvote.ts"],
    platform: "browser",
    outDir: "./dist/browser",
    plugins: [unpluginFragno({ platform: "browser" })],
    noExternal: [/^@fragno-dev\/core($|\/)/],
  },
]);
