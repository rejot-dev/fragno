import { defineConfig } from "vite";
import unpluginFragno from "@fragno-dev/unplugin-fragno/vite";

export default defineConfig({
  plugins: [unpluginFragno({ platform: "browser" })],
  resolve: {
    conditions: ["browser"],
  },
  // https://vite.dev/guide/build.html#library-mode
  build: {
    lib: {
      entry: {
        index: "./src/index.ts",
        "client/react": "./src/client/react.ts",
        "client/svelte": "./src/client/svelte.ts",
        "client/vanilla": "./src/client/vanilla.ts",
        "client/vue": "./src/client/vue.ts",
        "client/solid": "./src/client/solid.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "vue", "svelte", "solid-js", "zod", /^@fragno-dev\/db/],
    },
    outDir: "./dist/browser",
    sourcemap: true,
    target: "es2020",
  },
});
