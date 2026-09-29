import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/*.ts", "src/*/*.ts", "!src/**/*.test.ts"],
  platform: "neutral",
  external: ["cloudflare:workers", "miniflare", "esbuild"],
  fixedExtension: false,
  dts: true,
  unbundle: true,
});
