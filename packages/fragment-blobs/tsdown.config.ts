import unpluginFragno from "@fragno-dev/unplugin-fragno/rollup";
import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  ignoreWatch: ["./dist"],
  entry: ["./src/index.ts", "./src/routes.ts"],
  dts: true,
  platform: "node",
  outDir: "./dist",
  plugins: [unpluginFragno({ platform: "node" })],
  deps: { neverBundle: [/^@fragno-dev\/core/, /^@fragno-dev\/db/] },
  unbundle: true,
});
