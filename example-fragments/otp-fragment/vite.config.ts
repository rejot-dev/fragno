import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: ["src/index.ts"],
    format: ["esm"],
    platform: "node",
    target: "es2022",
    dts: true,
  },
});
