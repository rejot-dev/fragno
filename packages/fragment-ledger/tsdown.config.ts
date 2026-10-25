import { defineConfig } from "tsdown";

export default defineConfig({
  fixedExtension: false,
  ignoreWatch: ["./dist"],
  entry: ["./src/fragment.ts", "./src/errors.ts", "./src/schema.ts"],
  dts: true,
  platform: "node",
  outDir: "./dist",
  deps: { neverBundle: [/^@fragno-dev\/core/, /^@fragno-dev\/db/] },
  unbundle: true,
});
