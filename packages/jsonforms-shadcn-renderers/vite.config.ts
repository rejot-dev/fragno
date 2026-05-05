import path from "path";

import { defineConfig } from "vite-plus";

import { baseConfig } from "@fragno-private/vitest-config";

export default defineConfig({
  pack: {
    fixedExtension: false,
    entry: "./src/index.ts",
    dts: true,
    outDir: "./dist",
    platform: "browser",
    external: [/^@\/components\//, /^@\/lib\//],
  },

  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "../../example-apps/stripe-webshop/src/components"),
      "@/lib": path.resolve(__dirname, "../../example-apps/stripe-webshop/src/lib"),
    },
  },

  test: {
    ...baseConfig.test,
    environment: "jsdom",
    globalSetup: "./test-global-setup.mjs",
    setupFiles: ["./src/test-setup.ts"],
  },
});
