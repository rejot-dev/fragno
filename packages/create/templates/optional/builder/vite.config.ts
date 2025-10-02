import { defineConfig } from "vite";
import unpluginFragno from "@fragno-dev/unplugin-fragno/vite";

export default defineConfig({
  plugins: [unpluginFragno()],
  build: {
    lib: {
      entry: {
        index: "./src/index.ts",
        "client/react": "./src/client/react.ts",
        "client/svelte": "./src/client/svelte.ts",
        "client/vanilla": "./src/client/vanilla.ts",
        "client/vue": "./src/client/vue.ts",
      },
      formats: ["es"],
    },
    outDir: "./dist",
    sourcemap: true,
    target: "es2020",
  },
});
