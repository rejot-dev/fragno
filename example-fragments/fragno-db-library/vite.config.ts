import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: ["./src/mod.ts", "./src/upvote.ts", "./src/schema/mod.ts"],
      dts: true,
      platform: "node",
      outDir: "./dist",
      plugins: [unpluginFragno({ platform: "node" })],
    },
    {
      fixedExtension: false,
      ignoreWatch: ["./dist"],
      entry: ["./src/mod.ts", "./src/upvote.ts"],
      platform: "browser",
      outDir: "./dist/browser",
      plugins: [unpluginFragno({ platform: "browser" })],
      deps: {
        alwaysBundle: [/^@fragno-dev\/core($|\/)/],
      },
    },
  ],
});
